import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run } from '../src/cli.js';
import { EMBEDDED_RULES } from '../src/check.js';
import { GUIDE_FILE, GUIDE_LANGUAGES, agentGuide } from '../src/guide.js';
import { makeProject } from '../test-support/project.js';

function sink() {
  const stream = { text: '', isTTY: false, write(chunk) { stream.text += chunk; return true; } };
  return stream;
}

// No API answers on this port: init falls back to the rules shipped with the CLI.
const OFFLINE = 'http://127.0.0.1:9';

async function cli(argv) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, { stdout, stderr, env: { ZENEXTIA_CONFIG_DIR: makeProject() } });
  return { code, stdout: stdout.text, stderr: stderr.text, json: argv.includes('--json') ? JSON.parse(stdout.text) : null };
}

test('init writes ZENEXTIA.md with every rule an agent needs', async () => {
  const root = makeProject({});
  const result = await cli(['init', root, '--api', OFFLINE, '--json']);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.json.file, path.join(root, GUIDE_FILE));
  assert.equal(result.json.rules, 'embedded');
  const guide = fs.readFileSync(path.join(root, GUIDE_FILE), 'utf8');
  assert.match(guide, /^<!-- Écrit par @zenextia\/cli \d+\.\d+\.\d+/);
  for (const command of ['check --json', 'login', 'deploy --json', 'status --json']) {
    assert.ok(guide.includes(`npx @zenextia/cli ${command} --api ${OFFLINE}`), command);
  }
  assert.ok(guide.includes(`apiOrigin: "${OFFLINE}"`));
});

test('init names no API in production and writes English on request', async () => {
  const root = makeProject({});
  const stdout = sink();
  const code = await run(['init', root, '--lang', 'en'], { stdout, stderr: sink(), env: { ZENEXTIA_CONFIG_DIR: makeProject() }, });
  assert.equal(code, 0);
  const guide = fs.readFileSync(path.join(root, GUIDE_FILE), 'utf8');
  assert.ok(guide.includes('# Publishing an application on Zenextia'));
  assert.ok(!guide.includes('--api'));
  assert.ok(guide.includes('apiOrigin: "https://api.zenextia.com"'));
});

test('an unknown language is a usage error', async () => {
  const result = await cli(['init', makeProject({}), '--lang', 'de', '--api', OFFLINE, '--json']);
  assert.equal(result.code, 2);
});

for (const lang of GUIDE_LANGUAGES) {
  test(`the ${lang} guide carries the rules the portal brief used to hold`, () => {
    const guide = agentGuide({ lang });
    assert.doesNotMatch(guide, /\{\{[a-z]/i);
    for (const needle of [
      'WebAssembly', 'Web Workers', 'window.print()', 'confirm()',
      'device.microphone', 'device.camera', 'device.screen', 'clipboard.write',
      'externalOrigins', 'https://abcd.supabase.co', 'wss',
      'app.identity.token("https://api.example.com")', 'Bearer ${token}', 'verifyIdentityToken',
      '--code', 'build.log', 'zenextia.app.json', 'NODE_USE_ENV_PROXY=1',
    ]) {
      assert.ok(guide.includes(needle), needle);
    }
    assert.ok(!guide.includes('--no-browser'));
    for (const extension of EMBEDDED_RULES.acceptedExtensions) {
      assert.ok(guide.includes(extension.slice(1)), extension);
    }
    for (const name of EMBEDDED_RULES.noticeFiles) assert.ok(guide.includes(name), name);
    const manifest = JSON.parse(guide.slice(guide.indexOf('```json\n{') + 8, guide.indexOf('\n}\n```') + 2));
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'sdkMajor', 'id', 'version', 'name', 'description', 'author', 'entrypoint', 'permissions', 'externalOrigins']);
    // Member-facing text never leaks internal references.
    assert.doesNotMatch(guide, /\bADR\b|txzenextia|quarantine|Kong|BunkerWeb/i);
  });

  test(`docs/agent-guide.${lang}.md is what init writes (run npm run docs)`, () => {
    const published = fs.readFileSync(new URL(`../docs/agent-guide.${lang}.md`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(published, agentGuide({ lang }));
  });
}

// A well-started project: init scaffolds what Zenextia builds, never over an
// existing file, and asks nothing of an agent (CTO, 2026-11-12).
import { applicationId, scaffoldFiles, resolvePlan } from '../src/scaffold.js';

const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');

async function initIn(root, extra) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(['init', root, '--api', OFFLINE, '--json', ...extra], {
    stdout, stderr, env: { ZENEXTIA_CONFIG_DIR: makeProject() },
  });
  return { code, json: JSON.parse(stdout.text), stderr: stderr.text };
}

test('an empty folder gets a Vite + React project Zenextia can build', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  const result = await initIn(root, ['--name', 'Gestion des abonnements']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.template, 'react');
  assert.equal(result.json.id, 'gestion-des-abonnements');
  for (const name of ['package.json', 'vite.config.js', 'index.html', 'src/main.jsx', 'src/App.jsx', 'zenextia.app.json', 'AGENTS.md', 'CLAUDE.md', GUIDE_FILE]) {
    assert.ok(fs.existsSync(path.join(root, name)), name);
  }
  assert.match(read(root, 'vite.config.js'), /base: '\.\/'/);
  assert.match(read(root, 'index.html'), /src="\.\/src\/main\.jsx"/);
  assert.equal(JSON.parse(read(root, 'package.json')).scripts.build, 'vite build');
  const manifest = JSON.parse(read(root, 'zenextia.app.json'));
  assert.equal(manifest.id, 'gestion-des-abonnements');
  assert.deepEqual(manifest.permissions, []);
  assert.match(read(root, 'CLAUDE.md'), /@AGENTS\.md/);
  assert.match(read(root, 'AGENTS.md'), /ZENEXTIA\.md/);
  assert.deepEqual(result.json.nextSteps.slice(0, 2), ['npm install', 'npm run build']);
});

test('Supabase: identity permission, the declared origin and a verifying function', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  const result = await initIn(root, ['--backend', 'supabase', '--supabase-url', 'https://ABCD.supabase.co/rest', '--method', 'specs']);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(read(root, 'zenextia.app.json'));
  assert.deepEqual(manifest.permissions, ['identity.read']);
  assert.deepEqual(manifest.externalOrigins, ['https://abcd.supabase.co']);
  const fn = read(root, 'supabase/functions/zenextia-whoami/index.ts');
  assert.match(fn, /verifyIdentityToken/);
  assert.match(fn, new RegExp(`apiOrigin: '${OFFLINE}'`));
  assert.match(fn, /workspace\.id/);
  assert.match(read(root, 'src/backend.js'), /https:\/\/abcd\.supabase\.co\/functions\/v1/);
  assert.ok(fs.existsSync(path.join(root, 'docs/spec.md')));
  assert.match(read(root, 'AGENTS.md'), /docs\/spec\.md/);
  assert.ok(JSON.parse(read(root, 'package.json')).dependencies['@zenextia/app-sdk']);
});

test('Zenextia data: data permissions, an entity, and a simulation only outside Zenextia', () => {
  const plan = resolvePlan(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-')), { backend: 'zenextia', name: 'Notes' });
  const files = scaffoldFiles(plan);
  const manifest = JSON.parse(files['zenextia.app.json']);
  assert.deepEqual(manifest.permissions, ['identity.read', 'data.read', 'data.write']);
  assert.equal(manifest.entities[0].entityType, 'note');
  // The simulation depends on where the app runs, never on a failed connection.
  assert.match(files['src/zenextia.js'], /insideZenextia \? connectToPortal\(\) : createSimulatedApp/);
  assert.doesNotMatch(files['src/zenextia.js'], /catch/);
});

test('an existing project keeps every file and gets no template', async () => {
  const root = makeProject({ 'AGENTS.md': 'TEST mine\n' });
  const before = read(root, 'zenextia.app.json');
  const result = await initIn(root, []);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.json.template, 'none');
  assert.ok(result.json.kept.includes('zenextia.app.json'));
  assert.ok(result.json.kept.includes('AGENTS.md'));
  assert.equal(read(root, 'zenextia.app.json'), before);
  assert.equal(read(root, 'AGENTS.md'), 'TEST mine\n');
  const refused = await initIn(root, ['--template', 'react']);
  assert.equal(refused.code, 2);
});

test('bad choices are usage errors, before anything is written', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  for (const extra of [['--backend', 'firebase'], ['--template', 'vue'], ['--supabase-url', 'http://abcd.supabase.co'], ['--lang', 'de']]) {
    const result = await initIn(root, extra);
    assert.equal(result.code, 2, extra.join(' '));
  }
  assert.deepEqual(fs.readdirSync(root), []);
});

test('at a terminal, init asks; an agent or --yes is never asked', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  const stderr = sink();
  const code = await run(['init', root, '--api', OFFLINE], {
    stdout: sink(), stderr, env: { ZENEXTIA_CONFIG_DIR: makeProject() },
    interactive: true, answers: ['TEST Matrice', '2', '2', '1'],
  });
  assert.equal(code, 0, stderr.text);
  assert.match(stderr.text, /Base du projet/);
  assert.ok(fs.existsSync(path.join(root, 'src/main.js')), 'vanilla chosen');
  assert.deepEqual(JSON.parse(read(root, 'zenextia.app.json')).permissions, ['identity.read', 'data.read', 'data.write']);
  const quiet = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  const yes = sink();
  assert.equal(await run(['init', quiet, '--api', OFFLINE, '--yes'], { stdout: sink(), stderr: yes, env: { ZENEXTIA_CONFIG_DIR: makeProject() }, interactive: true, answers: [] }), 0);
  assert.doesNotMatch(yes.text, /Base du projet/);
});

test('the application id follows the manifest rule', () => {
  assert.equal(applicationId('Matrice des priorités'), 'matrice-des-priorites');
  assert.equal(applicationId('2026 Éditeur PDF!'), 'editeur-pdf');
  assert.equal(applicationId('***'), 'mon-application');
  assert.match(applicationId('x'.repeat(100)), /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
});

// Found 2026-11-13: 0.6.0 documents record files and tools (SDK 0.5.0), but the
// scaffold still pinned ^0.3.0, which for a 0.x version never reaches 0.4 or
// later. The guide's features must exist in the SDK range a new project gets.
test('a scaffolded project gets the SDK the guide documents', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'zenextia-init-'));
  const result = await initIn(root, ['--backend', 'supabase', '--supabase-url', 'https://abcd.supabase.co', '--method', 'specs']);
  assert.equal(result.code, 0, result.stderr);
  const admits = (range, version) => {
    const [, major, minor, patch] = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range) ?? [];
    const [vMajor, vMinor, vPatch] = version.split('.').map(Number);
    if (major === undefined) return false;
    if (Number(major) > 0) return vMajor === Number(major) && (vMinor > Number(minor) || (vMinor === Number(minor) && vPatch >= Number(patch)));
    return vMajor === 0 && vMinor === Number(minor) && vPatch >= Number(patch);
  };
  const range = JSON.parse(read(root, 'package.json')).dependencies['@zenextia/app-sdk'];
  assert.ok(admits(range, '0.5.0'), `package.json range ${range} excludes SDK 0.5.0 (files, tools)`);
  const fn = read(root, 'supabase/functions/zenextia-whoami/index.ts');
  const deno = /npm:@zenextia\/app-sdk@(\^[\d.]+)/.exec(fn)?.[1];
  assert.ok(deno && admits(deno, '0.5.0'), `edge function range ${deno} excludes SDK 0.5.0`);
});
