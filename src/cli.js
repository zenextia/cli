import fs from 'node:fs';

import { openBrowser as defaultOpenBrowser } from './browser.js';
import { deploy, pollStatus, phaseOf, requireTools, resolveInstallation, TOOLS } from './deploy.js';
import { CliError, EXIT, usageError } from './errors.js';
import { PRODUCTION_API, apiOrigin } from './http.js';
import { McpClient } from './mcp.js';
import { accessToken, login, mcpUrl } from './oauth.js';
import { Store, configDir } from './store.js';
import { createUi, describeStatus, formatBytes } from './ui.js';

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HELP = `zenextia ${VERSION} — déployer une application AI Factory sur Zenextia

Usage :
  zenextia login   [--api <url>] [--no-browser]
  zenextia logout  [--api <url>]
  zenextia deploy  [dossier] [--api <url>] [--no-wait] [--timeout <minutes>]
  zenextia status  [dossier | --installation <id>] [--version-id <id>] [--api <url>]

Options :
  --api <url>   API Zenextia (défaut : ${PRODUCTION_API}, ou la variable ZENEXTIA_API)
  --json        sortie JSON sur stdout, pour les agents de code et les scripts
  -h, --help    cette aide
  -v, --version version de la CLI

Codes de sortie : 0 succès, 1 échec ou refus, 2 usage, 3 authentification.
`;

const OPTIONS = {
  '--api': 'string',
  '--json': 'boolean',
  '--help': 'boolean',
  '-h': 'boolean',
  '--version': 'boolean',
  '-v': 'boolean',
  '--no-browser': 'boolean',
  '--no-wait': 'boolean',
  '--timeout': 'string',
  '--installation': 'string',
  '--version-id': 'string',
};

const COMMAND_OPTIONS = {
  login: ['--api', '--no-browser'],
  logout: ['--api'],
  deploy: ['--api', '--no-wait', '--timeout'],
  status: ['--api', '--installation', '--version-id'],
};
const GLOBAL_OPTIONS = ['--json', '--help', '-h', '--version', '-v'];

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const type = OPTIONS[name];
    if (!type) throw usageError(`Option inconnue : ${name}`);
    if (type === 'boolean') {
      if (inline !== undefined) throw usageError(`L'option ${name} ne prend pas de valeur.`);
      options[name] = true;
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw usageError(`L'option ${name} attend une valeur.`);
      options[name] = value;
    }
  }
  const [command, ...rest] = positionals;
  return { command, args: rest, options };
}

function checkOptions(command, options) {
  const allowed = new Set([...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] || [])]);
  for (const name of Object.keys(options)) {
    if (!allowed.has(name)) throw usageError(`L'option ${name} ne s'applique pas à « ${command} ».`);
  }
}

/**
 * Run the CLI and return its exit code. Everything environment-specific is
 * injectable so the tests drive the real code paths in-process.
 */
export async function run(argv, deps = {}) {
  const {
    env = process.env,
    stdout = process.stdout,
    stderr = process.stderr,
    openBrowser = defaultOpenBrowser,
    pollIntervalMs = Number(env.ZENEXTIA_POLL_INTERVAL_MS) || 3000,
    retryDelayMs,
    loginTimeoutMs,
    now = Date.now,
  } = deps;

  const json = argv.includes('--json');
  const ui = createUi({ stdout, stderr, json, now });
  try {
    const { command, args, options } = parseArgs(argv);
    if (options['--version'] || options['-v']) {
      if (json) ui.result({ ok: true, version: VERSION });
      else stdout.write(`${VERSION}\n`);
      return EXIT.OK;
    }
    if (!command || command === 'help' || options['--help'] || options['-h']) {
      stdout.write(HELP);
      return command && command !== 'help' && !COMMAND_OPTIONS[command] ? EXIT.USAGE : EXIT.OK;
    }
    if (!COMMAND_OPTIONS[command]) throw usageError(`Commande inconnue : ${command}`, { hint: 'Voir « zenextia --help ».' });
    checkOptions(command, options);

    const origin = apiOrigin(options['--api'] || env.ZENEXTIA_API || PRODUCTION_API);
    const store = new Store(configDir(env));
    const context = { ui, origin, store, options, args, openBrowser, pollIntervalMs, retryDelayMs, loginTimeoutMs, now };

    switch (command) {
      case 'login':
        return await loginCommand(context);
      case 'logout':
        return logoutCommand(context);
      case 'deploy':
        return await deployCommand(context);
      case 'status':
        return await statusCommand(context);
      default:
        throw usageError(`Commande inconnue : ${command}`);
    }
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError(`Erreur inattendue : ${error?.message || error}`, { code: 'UNEXPECTED' });
    ui.error(cliError);
    return cliError.exitCode;
  }
}

function mcpClient({ origin, store, now }) {
  return new McpClient({
    url: mcpUrl(origin),
    clientVersion: VERSION,
    token: (forceRefresh) => accessToken({ origin, store, forceRefresh, now }),
  });
}

async function loginCommand({ ui, origin, store, options, openBrowser, loginTimeoutMs, now }) {
  if (!ui.json) ui.say(`Connexion à ${origin}…`);
  const tokens = await login({
    origin,
    store,
    timeoutMs: loginTimeoutMs,
    now,
    openBrowser: options['--no-browser'] ? null : openBrowser,
    onUrl: (url) => {
      ui.notice(
        options['--no-browser']
          ? `Ouvrez ce lien dans votre navigateur pour autoriser la CLI :\n${url}`
          : `Votre navigateur va s'ouvrir. Sinon, ouvrez ce lien :\n${url}`,
      );
      ui.notice('Dans Zenextia, choisissez le Workspace puis autorisez l\'accès.');
    },
  });

  const workspace = tokens.workspace?.name || null;
  const member = tokens.member?.name || tokens.member?.email || null;
  if (workspace || member) {
    ui.say(`Connecté${workspace ? ` au Workspace « ${workspace} »` : ''}${member ? ` en tant que ${member}` : ''}.`);
  } else {
    ui.say('Connecté.');
  }

  // Best effort: tell the author now if deployment will be refused.
  let developerTools = null;
  let warning = null;
  const mcp = mcpClient({ origin, store, now });
  try {
    await mcp.connect();
    await requireTools(mcp, Object.values(TOOLS));
    developerTools = true;
  } catch (error) {
    developerTools = false;
    warning = error instanceof CliError ? error : null;
  } finally {
    await mcp.close();
  }
  if (warning) {
    ui.say(`Attention : ${warning.message}`);
    if (warning.hint) ui.say(warning.hint);
  } else {
    ui.say('Les outils de déploiement sont disponibles. Lancez « zenextia deploy » dans votre projet.');
  }
  ui.result({
    ok: true,
    api: origin,
    resource: tokens.resource,
    expiresAt: tokens.expires_at ? new Date(tokens.expires_at).toISOString() : null,
    workspace: tokens.workspace ?? null,
    member: tokens.member ?? null,
    developerTools,
    ...(warning ? { warning: warning.toJSON() } : {}),
  });
  return EXIT.OK;
}

function logoutCommand({ ui, origin, store }) {
  const had = store.clearTokens(origin);
  ui.say(had ? `Déconnecté de ${origin}.` : `Aucune session ouverte sur ${origin}.`);
  if (had) {
    ui.say('La connexion reste listée dans Zenextia (Paramètres > Intégrations), où vous pouvez la révoquer.');
  }
  ui.result({ ok: true, api: origin, loggedOut: had });
  return EXIT.OK;
}

function timeoutMinutes(value) {
  if (value === undefined) return 30;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw usageError('--timeout attend un nombre de minutes positif.');
  return minutes;
}

async function deployCommand({ ui, origin, store, options, args, pollIntervalMs, retryDelayMs, now }) {
  if (args.length > 1) throw usageError('Un seul dossier de projet est attendu.');
  const dir = args[0] || '.';
  const minutes = timeoutMinutes(options['--timeout']);
  const mcp = mcpClient({ origin, store, now });
  let result;
  try {
    result = await deploy({
      dir,
      origin,
      store,
      mcp,
      wait: !options['--no-wait'],
      pollIntervalMs,
      retryDelayMs,
      timeoutMs: minutes * 60 * 1000,
      now,
      hooks: {
        onArchive: (archive, project) =>
          ui.say(
            `Archive de « ${project.manifest.id} » ${project.manifest.version} : ` +
              `${archive.entries.length} fichiers, ${formatBytes(archive.bytes)}.`,
          ),
        onPrepared: () => ui.say('Envoi des sources…'),
        onCompleteRetry: () => ui.say('Le stockage n\'a pas encore confirmé la réception, nouvelle tentative…'),
        onQueued: () => ui.say('Sources reçues. Construction et vérification par Zenextia…'),
        onStatus: (status) => ui.status(status),
      },
    });
  } finally {
    await mcp.close();
  }

  ui.endProgress();
  const status = result.status;
  if (result.phase === 'queued') {
    ui.say('Construction en file d\'attente.');
    ui.say(`Suivez-la avec : zenextia status${dir === '.' ? '' : ` ${dir}`}`);
  } else {
    describeStatus(ui, status, result.phase);
    if (result.phase === 'timeout') {
      ui.say(`Toujours en cours après ${minutes} min. Suivez avec : zenextia status${dir === '.' ? '' : ` ${dir}`}`);
    }
  }
  ui.result({
    ok: result.phase === 'ready' || result.phase === 'queued',
    phase: result.phase,
    applicationId: result.applicationId,
    version: result.version,
    installationId: result.installationId,
    versionId: result.versionId,
    uploadId: result.uploadId,
    buildId: result.buildId,
    source: result.source,
    previewUrl: status?.previewUrl ?? null,
    publishable: status?.publishable ?? false,
    nextStep: status?.nextStep ?? null,
    status,
  });
  return result.phase === 'ready' || result.phase === 'queued' ? EXIT.OK : EXIT.FAILED;
}

async function statusCommand({ ui, origin, store, options, args, now }) {
  if (args.length > 1) throw usageError('Un seul dossier de projet est attendu.');
  if (args.length && options['--installation']) {
    throw usageError('Indiquez soit un dossier, soit --installation, pas les deux.');
  }
  const target = resolveInstallation({
    dir: args[0] || '.',
    installationId: options['--installation'],
    versionId: options['--version-id'],
    origin,
    store,
  });
  const mcp = mcpClient({ origin, store, now });
  let status;
  try {
    await mcp.connect();
    await requireTools(mcp, [TOOLS.status]);
    ({ status } = await pollStatus(mcp, target, { timeoutMs: 0, now }));
  } finally {
    await mcp.close();
  }
  const phase = phaseOf(status);
  describeStatus(ui, status, phase);
  if (phase === 'in_progress') ui.say('Toujours en cours.');
  ui.result({ ok: phase !== 'failed', phase, installationId: target.installationId, status });
  return phase === 'failed' ? EXIT.FAILED : EXIT.OK;
}
