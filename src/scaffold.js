// `zenextia init`: start a project the way Zenextia builds it. Every file is
// written only when absent, except ZENEXTIA.md which belongs to the CLI.

import fs from 'node:fs';
import path from 'node:path';

import { usageError } from './errors.js';
import { PRODUCTION_API } from './http.js';

export const TEMPLATES = ['react', 'vanilla', 'none'];
export const BACKENDS = ['none', 'zenextia', 'supabase', 'custom'];
export const METHODS = ['none', 'specs'];

// Caret ranges on current majors: `npm install` resolves the newest compatible
// release and the lockfile pins it. No network is needed to scaffold.
const VERSIONS = {
  vite: '^6.3.5',
  '@vitejs/plugin-react': '^4.5.0',
  react: '^19.1.0',
  'react-dom': '^19.1.0',
  '@zenextia/app-sdk': '^0.5.0',
};

/** The manifest id: lowercase words joined by hyphens, starting with a letter. */
export function applicationId(value) {
  const id = String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return id || 'mon-application';
}

/** An exact https origin, as `externalOrigins` accepts it. */
export function httpsOrigin(value, option = '--supabase-url') {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin.toLowerCase();
  } catch {
    // Reported below.
  }
  throw usageError(`${option} attend une adresse https, par exemple https://abcd.supabase.co.`);
}

export function validateChoice(value, allowed, option) {
  if (!allowed.includes(value)) {
    throw usageError(`${option} accepte : ${allowed.join(', ')}.`);
  }
  return value;
}

/**
 * What `init` decides from the project folder and the options: an existing npm
 * project is never scaffolded over; an empty folder gets a React project.
 */
export function resolvePlan(root, options = {}) {
  const hasPackage = fs.existsSync(path.join(root, 'package.json'));
  const template = options.template ?? (hasPackage ? 'none' : 'react');
  validateChoice(template, TEMPLATES, '--template');
  if (hasPackage && template !== 'none') {
    throw usageError('Ce dossier contient déjà un package.json : --template ne s\'applique qu\'à un nouveau projet.', {
      hint: 'Lancez « zenextia init » sans --template, ou dans un dossier vide.',
    });
  }
  const backend = validateChoice(options.backend ?? 'none', BACKENDS, '--backend');
  const method = validateChoice(options.method ?? 'none', METHODS, '--method');
  const lang = validateChoice(options.lang ?? 'fr', ['fr', 'en'], '--lang');
  const backendOrigin = options.backendUrl ? httpsOrigin(options.backendUrl) : null;
  const name = (options.name || path.basename(path.resolve(root)) || 'Mon application').trim();
  return { template, backend, method, backendOrigin, name, id: applicationId(name), lang };
}

function manifest(plan) {
  const permissions = {
    none: [],
    zenextia: ['identity.read', 'data.read', 'data.write'],
    supabase: ['identity.read'],
    custom: ['identity.read'],
  }[plan.backend];
  const fr = plan.lang !== 'en';
  return {
    schemaVersion: 1,
    sdkMajor: 1,
    id: plan.id,
    version: '0.1.0',
    name: plan.name.slice(0, 120),
    description: fr ? 'À décrire en une phrase.' : 'Describe it in one sentence.',
    author: fr ? 'À compléter' : 'To complete',
    entrypoint: 'index.html',
    permissions,
    ...(plan.backend === 'zenextia'
      ? {
          entities: [
            {
              entityType: 'note',
              label: fr ? 'Notes' : 'Notes',
              fields: [
                { name: 'title', label: fr ? 'Titre' : 'Title', type: 'string', required: true },
                { name: 'done', label: fr ? 'Terminée' : 'Done', type: 'boolean' },
              ],
            },
          ],
        }
      : {}),
    externalOrigins: plan.backendOrigin ? [plan.backendOrigin] : [],
  };
}

function packageJson(plan) {
  const react = plan.template === 'react';
  const sdk = plan.backend !== 'none';
  return {
    name: plan.id,
    private: true,
    version: '0.1.0',
    type: 'module',
    scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
    dependencies: {
      ...(react ? { react: VERSIONS.react, 'react-dom': VERSIONS['react-dom'] } : {}),
      ...(sdk ? { '@zenextia/app-sdk': VERSIONS['@zenextia/app-sdk'] } : {}),
    },
    devDependencies: {
      ...(react ? { '@vitejs/plugin-react': VERSIONS['@vitejs/plugin-react'] } : {}),
      vite: VERSIONS.vite,
    },
  };
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function viteConfig(plan) {
  return plan.template === 'react'
    ? `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './': Zenextia serves the application under a path of its own, so every
// asset must be referenced relatively.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist' },
});
`
    : `import { defineConfig } from 'vite';

// base './': Zenextia serves the application under a path of its own, so every
// asset must be referenced relatively.
export default defineConfig({
  base: './',
  build: { outDir: 'dist' },
});
`;
}

function indexHtml(plan) {
  const entry = plan.template === 'react' ? './src/main.jsx' : './src/main.js';
  const mount = plan.template === 'react' ? '<div id="root"></div>' : '<main id="app"></main>';
  return `<!doctype html>
<html lang="${plan.lang === 'en' ? 'en' : 'fr'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${plan.name.replace(/[<&]/g, '')}</title>
    <link rel="stylesheet" href="./src/style.css" />
  </head>
  <body>
    ${mount}
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;
}

const STYLE = `:root { font-family: system-ui, sans-serif; color: #1f2937; background: #ffffff; }
body { margin: 0; }
main, #root > main { max-width: 960px; margin: 0 auto; padding: 24px; }
.simulation { background: #fef3c7; color: #92400e; padding: 8px 12px; border-radius: 8px; font-size: 14px; }
.error { color: #b91c1c; }
`;

// In Zenextia the portal provides the bridge; outside it (npm run dev) there is
// none, so the app runs on in-memory data and says so. Never a fallback when
// a real connection fails.
const ZENEXTIA_DATA = `import { connectToPortal, createSimulatedApp } from '@zenextia/app-sdk';
import manifest from '../zenextia.app.json';

export const insideZenextia = Boolean(globalThis.__ZENEXTIA_HOST__);

/** The Zenextia app: the portal inside Zenextia, an in-memory simulation in local development. */
export async function connect() {
  return insideZenextia ? connectToPortal() : createSimulatedApp({ manifest });
}
`;

function backendClient(plan) {
  const base = plan.backend === 'supabase'
    ? `${plan.backendOrigin ?? 'https://VOTRE-PROJET.supabase.co'}/functions/v1`
    : plan.backendOrigin ?? 'https://api.example.com';
  return `import { connectToPortal } from '@zenextia/app-sdk';

// Your back-end's address. It is part of the code (no .env reaches Zenextia)
// and its origin must be listed in zenextia.app.json > externalOrigins.
export const BACKEND_URL = '${base}';

/**
 * Call your back-end as the member: a five-minute Zenextia identity token goes
 * in the Authorization header, and the back-end has Zenextia check it.
 */
export async function callBackend(pathname, init = {}) {
  const app = await connectToPortal();
  const { token } = await app.identity.token(new URL(BACKEND_URL).origin);
  return fetch(\`\${BACKEND_URL}\${pathname}\`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: \`Bearer \${token}\` },
  });
}
`;
}

function supabaseFunction(api) {
  return `// Supabase Edge Function: who is calling, as Zenextia vouches for it.
// Deploy with \`supabase functions deploy zenextia-whoami --no-verify-jwt\` and set
// ZENEXTIA_INSTALLATION_ID (returned by \`npx @zenextia/cli deploy --json\`).
import { verifyIdentityToken } from 'npm:@zenextia/app-sdk@^0.5.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const identity = await verifyIdentityToken({
    apiOrigin: '${api}',
    installationId: Deno.env.get('ZENEXTIA_INSTALLATION_ID') ?? '',
    audience: new URL(Deno.env.get('SUPABASE_URL') ?? request.url).origin,
    token,
  });
  if (!identity) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: cors });
  }
  // Filter every table by identity.workspace.id: one Supabase project may
  // serve several Workspaces and applications.
  return Response.json({ member: identity.member, workspace: identity.workspace }, { headers: cors });
});
`;
}

function reactSources(plan) {
  const fr = plan.lang !== 'en';
  const main = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
  let app;
  if (plan.backend === 'zenextia') {
    app = `import { useEffect, useState } from 'react';
import { connect, insideZenextia } from './zenextia.js';

export default function App() {
  const [notes, setNotes] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    connect()
      .then((app) => app.data.entity('note').list({ pageSize: 25 }))
      .then((page) => setNotes(page.items))
      .catch((failure) => setError(\`\${failure.code ?? 'ERROR'} · \${failure.requestId ?? ''}\`));
  }, []);
  return (
    <main>
      {!insideZenextia && <p className="simulation">${fr ? 'Simulation locale : données en mémoire.' : 'Local simulation: in-memory data.'}</p>}
      <h1>${plan.name.replace(/[<>{}]/g, '')}</h1>
      {error && <p className="error">{error}</p>}
      <ul>{notes.map((note) => <li key={note.id}>{note.data.title}</li>)}</ul>
    </main>
  );
}
`;
  } else if (plan.backend === 'supabase' || plan.backend === 'custom') {
    app = `import { useEffect, useState } from 'react';
import { callBackend } from './backend.js';

export default function App() {
  const [member, setMember] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    callBackend('${plan.backend === 'supabase' ? '/zenextia-whoami' : '/whoami'}')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(\`HTTP \${response.status}\`))))
      .then((body) => setMember(body.member))
      .catch((failure) => setError(failure.message));
  }, []);
  return (
    <main>
      <h1>${plan.name.replace(/[<>{}]/g, '')}</h1>
      {member && <p>${fr ? 'Connecté en tant que' : 'Signed in as'} {member.name}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}
`;
  } else {
    app = `export default function App() {
  return (
    <main>
      <h1>${plan.name.replace(/[<>{}]/g, '')}</h1>
      <p>${fr ? 'Votre application commence ici.' : 'Your application starts here.'}</p>
    </main>
  );
}
`;
  }
  return { 'src/main.jsx': main, 'src/App.jsx': app };
}

function vanillaSources(plan) {
  const fr = plan.lang !== 'en';
  const title = plan.name.replace(/[<>`$\\]/g, '');
  return {
    'src/main.js': `const app = document.getElementById('app');
const title = document.createElement('h1');
title.textContent = ${JSON.stringify(title)};
const text = document.createElement('p');
text.textContent = ${JSON.stringify(fr ? 'Votre application commence ici.' : 'Your application starts here.')};
app.append(title, text);
`,
  };
}

function agentsFile(plan) {
  const fr = plan.lang !== 'en';
  const spec = plan.method === 'specs';
  return fr
    ? `# Instructions pour les agents de code

Cette application est publiée sur Zenextia. Avant toute modification, lis
ZENEXTIA.md en entier : il fixe les règles techniques, le fichier
zenextia.app.json et les commandes pour vérifier et envoyer l'application.
${spec ? `
La spécification vit dans docs/spec.md. Avant de coder une fonctionnalité,
complète-la ; avant d'envoyer une version, vérifie ses critères d'acceptation.
` : ''}`
    : `# Instructions for coding agents

This application is published on Zenextia. Before any change, read ZENEXTIA.md
in full: it sets the technical rules, the zenextia.app.json file and the
commands to check and send the application.
${spec ? `
The specification lives in docs/spec.md. Complete it before coding a feature;
check its acceptance criteria before sending a version.
` : ''}`;
}

function specFile(plan) {
  return plan.lang !== 'en'
    ? `# Spécification : ${plan.name}

## Problème
Ce que l'application résout, pour qui.

## Utilisateurs et droits
Qui l'utilise. Ce que chacun lit et modifie (droits « Lire / Modifier les données » de Zenextia).

## Écrans
Un paragraphe par écran : ce qu'on y voit, ce qu'on y fait.

## Données
Les types d'enregistrements et leurs champs, ou le back-end et ses tables.

## Services externes
Chaque origine contactée et pourquoi (zenextia.app.json > externalOrigins).

## Critères d'acceptation
- [ ] …
`
    : `# Specification: ${plan.name}

## Problem
What the application solves, for whom.

## Users and rights
Who uses it. What each one reads and changes (Zenextia "Read / Change the data" rights).

## Screens
One paragraph per screen: what one sees and does there.

## Data
Record types and their fields, or the back-end and its tables.

## External services
Every origin contacted and why (zenextia.app.json > externalOrigins).

## Acceptance criteria
- [ ] …
`;
}

/** The files `init` would create, by path relative to the project root. */
export function scaffoldFiles(plan, { api = null } = {}) {
  const files = {};
  if (plan.template !== 'none') {
    files['package.json'] = json(packageJson(plan));
    files['vite.config.js'] = viteConfig(plan);
    files['index.html'] = indexHtml(plan);
    files['src/style.css'] = STYLE;
    files['.gitignore'] = 'node_modules\ndist\n.env*\n';
    Object.assign(files, plan.template === 'react' ? reactSources(plan) : vanillaSources(plan));
    if (plan.backend === 'zenextia') files['src/zenextia.js'] = ZENEXTIA_DATA;
    if (plan.backend === 'supabase' || plan.backend === 'custom') files['src/backend.js'] = backendClient(plan);
  }
  if (plan.backend === 'supabase') {
    files['supabase/functions/zenextia-whoami/index.ts'] = supabaseFunction(api || PRODUCTION_API);
  }
  files['zenextia.app.json'] = json(manifest(plan));
  files['AGENTS.md'] = agentsFile(plan);
  // Claude Code reads CLAUDE.md; the import keeps one source of instructions.
  files['CLAUDE.md'] = '@AGENTS.md\n';
  if (plan.method === 'specs') files['docs/spec.md'] = specFile(plan);
  return files;
}

/** Write the files that do not exist yet; return what was created and what was kept. */
export function writeScaffold(root, files) {
  const created = [];
  const kept = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) {
      kept.push(relative);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    created.push(relative);
  }
  return { created, kept };
}
