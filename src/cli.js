import fs from 'node:fs';
import path from 'node:path';

import { readProject } from './archive.js';
import { openBrowser as defaultOpenBrowser } from './browser.js';
import { OUTPUT_DIRECTORY, checkBuild, fetchRules } from './check.js';
import { GUIDE_FILE, writeAgentGuide } from './guide.js';
import { choose, createAsker, text } from './prompt.js';
import { resolvePlan, scaffoldFiles, writeScaffold } from './scaffold.js';
import { deploy, pollStatus, phaseOf, requireTools, resolveInstallation, TOOLS } from './deploy.js';
import { CliError, EXIT, usageError } from './errors.js';
import { PRODUCTION_API, apiOrigin } from './http.js';
import { McpClient } from './mcp.js';
import { accessToken, login, loginWithCode, mcpUrl } from './oauth.js';
import { Store, configDir } from './store.js';
import { createUi, describeStatus, formatBytes } from './ui.js';

export const VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const HELP = `zenextia ${VERSION} — déployer une application AI Factory sur Zenextia

Usage :
  zenextia init    [dossier] [--template react|vanilla|none] [--backend none|zenextia|supabase|custom]
                   [--method none|specs] [--name <nom>] [--supabase-url <url>] [--yes] [--lang fr|en]
  zenextia login   [--api <url>] [--no-browser | --code]
  zenextia logout  [--api <url>]
  zenextia check   [dossier] [--api <url>]
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
  '--code': 'boolean',
  '--no-wait': 'boolean',
  '--timeout': 'string',
  '--installation': 'string',
  '--version-id': 'string',
  '--lang': 'string',
  '--template': 'string',
  '--backend': 'string',
  '--method': 'string',
  '--name': 'string',
  '--supabase-url': 'string',
  '--yes': 'boolean',
};

const COMMAND_OPTIONS = {
  init: ['--api', '--lang', '--template', '--backend', '--method', '--name', '--supabase-url', '--yes'],
  login: ['--api', '--no-browser', '--code'],
  logout: ['--api'],
  check: ['--api'],
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
    sleep,
    stdin = process.stdin,
    interactive,
    answers,
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
    const context = { ui, origin, store, options, args, openBrowser, pollIntervalMs, retryDelayMs, loginTimeoutMs, now, sleep, stdin, stdout, stderr, interactive, answers };

    switch (command) {
      case 'init':
        return await initCommand(context);
      case 'login':
        return await loginCommand(context);
      case 'logout':
        return logoutCommand(context);
      case 'check':
        return await checkCommand(context);
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

async function loginCommand({ ui, origin, store, options, openBrowser, loginTimeoutMs, now, sleep }) {
  if (options['--code'] && options['--no-browser']) {
    throw usageError('--code et --no-browser ne vont pas ensemble : --code n\'ouvre jamais de navigateur.');
  }
  if (!ui.json) ui.say(`Connexion à ${origin}…`);
  const tokens = options['--code'] ? await loginWithCode({
    origin,
    store,
    now,
    sleep,
    onCode: ({ userCode, verificationUri, verificationUriComplete, expiresIn }) => {
      ui.notice(`Sur n'importe quel appareil, ouvrez ${verificationUri} et saisissez le code : ${userCode}`);
      if (verificationUriComplete) ui.notice(`Ou ouvrez directement : ${verificationUriComplete}`);
      ui.notice(`Le code expire dans ${Math.round(expiresIn / 60)} minutes. Choisissez le Workspace puis autorisez l'accès ; la CLI attend.`);
    },
  }) : await login({
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

/**
 * The questions, at a terminal only: a coding agent, a pipe, --json or --yes
 * get the options and their defaults, never a prompt that would hang.
 */
async function askPlan({ options, root, stdin, stderr, interactive, answers }) {
  const chosen = {
    template: options['--template'],
    backend: options['--backend'],
    method: options['--method'],
    name: options['--name'],
    backendUrl: options['--supabase-url'],
    lang: options['--lang'] || 'fr',
  };
  const tty = interactive ?? Boolean(stdin?.isTTY && stderr?.isTTY);
  if (!tty || options['--yes'] || options['--json']) return chosen;
  const asker = createAsker({ input: stdin, output: stderr, answers });
  try {
    const existing = fs.existsSync(path.join(root, 'package.json'));
    chosen.name ??= await text(asker, stderr, "Nom de l'application", path.basename(path.resolve(root)));
    if (!existing && !chosen.template) {
      chosen.template = await choose(asker, stderr, 'Base du projet', [
        { value: 'react', label: 'Vite + React (recommandé)' },
        { value: 'vanilla', label: 'Vite, JavaScript sans framework' },
        { value: 'none', label: 'Aucune : je pars de mon propre projet' },
      ], 'react');
    }
    chosen.backend ??= await choose(asker, stderr, 'Données et back-end', [
      { value: 'none', label: "Aucun : l'application tient dans le navigateur" },
      { value: 'zenextia', label: 'Données partagées chez Zenextia (kit, état simple)' },
      { value: 'supabase', label: 'Supabase (vraie base, avec le jeton d\'identité Zenextia)' },
      { value: 'custom', label: 'Mon propre serveur (avec le jeton d\'identité Zenextia)' },
    ], 'none');
    if ((chosen.backend === 'supabase' || chosen.backend === 'custom') && !chosen.backendUrl) {
      chosen.backendUrl = (await text(asker, stderr,
        chosen.backend === 'supabase' ? 'Adresse du projet Supabase (https://….supabase.co), vide pour plus tard' : 'Adresse du back-end (https://…), vide pour plus tard')) || undefined;
    }
    chosen.method ??= await choose(asker, stderr, 'Méthode de travail (BMAD ou un autre cadre : installez-le ensuite, ZENEXTIA.md reste la référence)', [
      { value: 'none', label: 'Libre' },
      { value: 'specs', label: "Spécification d'abord (docs/spec.md, critères d'acceptation)" },
    ], 'none');
  } finally {
    asker.close();
  }
  return chosen;
}

async function initCommand({ ui, origin, args, options, stdin, stderr, interactive, answers }) {
  if (args.length > 1) throw usageError('Un seul dossier de projet est attendu.');
  const root = args[0] || '.';
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw usageError(`Le dossier ${root} est introuvable.`);
  }
  const api = origin === PRODUCTION_API ? null : origin;
  const plan = resolvePlan(root, await askPlan({ options, root, stdin, stderr, interactive, answers }));
  const { created, kept } = writeScaffold(root, scaffoldFiles(plan, { api }));
  const { rules, source } = await fetchRules(origin);
  const file = writeAgentGuide(root, { lang: plan.lang, api, rules, version: VERSION });
  const en = plan.lang === 'en';
  for (const name of created) ui.say(`${en ? 'Created' : 'Créé'} · ${name}`);
  for (const name of kept) ui.say(`${en ? 'Kept, already there' : 'Conservé, déjà présent'} · ${name}`);
  ui.say(`${en ? 'Rules written to' : 'Règles écrites dans'} ${GUIDE_FILE}.`);
  const nextSteps = [
    ...(plan.template !== 'none' ? ['npm install'] : []),
    ...(plan.backend === 'supabase' ? [en ? 'supabase functions deploy zenextia-whoami --no-verify-jwt' : 'supabase functions deploy zenextia-whoami --no-verify-jwt'] : []),
    'npm run build',
    `npx @zenextia/cli check${api ? ` --api ${api}` : ''}`,
    `npx @zenextia/cli login${api ? ` --api ${api}` : ''}`,
    `npx @zenextia/cli deploy${api ? ` --api ${api}` : ''}`,
  ];
  ui.say(en ? `Next: read ${GUIDE_FILE} in full, then:` : `Ensuite : lis ${GUIDE_FILE} en entier, puis :`);
  for (const step of nextSteps) ui.say(`  ${step}`);
  if ((plan.backend === 'supabase' || plan.backend === 'custom') && !plan.backendOrigin) {
    ui.say(en
      ? 'Set your back-end address in src/backend.js and its origin in zenextia.app.json > externalOrigins.'
      : "Indique l'adresse du back-end dans src/backend.js et son origine dans zenextia.app.json > externalOrigins.");
  }
  ui.result({
    ok: true, file, lang: plan.lang, api: origin, rules: source,
    template: plan.template, backend: plan.backend, method: plan.method, id: plan.id,
    created, kept, nextSteps,
  });
  return EXIT.OK;
}

async function checkCommand({ ui, origin, args }) {
  if (args.length > 1) throw usageError('Un seul dossier de projet est attendu.');
  const project = readProject(args[0] || '.');
  const { rules, source } = await fetchRules(origin);
  if (source === 'embedded') ui.say(`Règles de ${origin} injoignables : contrôle avec la copie fournie par la CLI.`);
  const report = checkBuild(project.root, project.manifest, rules);
  for (const item of report.problems) ui.say(`Refusé · ${item.path} : ${item.message}`);
  for (const item of report.warnings) ui.say(`Attention · ${item.path} : ${item.message}`);
  const ok = report.problems.length === 0;
  ui.say(
    ok
      ? `${OUTPUT_DIRECTORY}/ est prêt : ${report.files} fichiers, ${formatBytes(report.bytes)}${report.warnings.length ? `, ${report.warnings.length} point(s) d'attention` : ''}. Lancez « zenextia deploy ».`
      : `${report.problems.length} problème(s) : corrigez-les puis relancez « npm run build » et « zenextia check ».`,
  );
  if (!ok && !ui.json) {
    ui.say(`Fichiers acceptés : ${rules.acceptedExtensions.join(' ')}, et sans extension ${rules.noticeFiles.join(', ')}.`);
  }
  ui.result({ ok, rules: source, files: report.files, bytes: report.bytes, problems: report.problems, warnings: report.warnings, acceptedExtensions: rules.acceptedExtensions, noticeFiles: rules.noticeFiles });
  return ok ? EXIT.OK : EXIT.FAILED;
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
