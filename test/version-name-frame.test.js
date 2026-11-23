import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MAX_VERSION_NAME, versionNameOf } from '../src/deploy.js';
import { GUIDE_FILE, agentGuide, frameSection } from '../src/guide.js';
import { cliHarness } from '../test-support/cli.js';
import { startFakeBackend } from '../test-support/fake-backend.js';
import { makeProject } from '../test-support/project.js';

// A version carries a name, and a Workspace gives its developers a technical
// frame (Zenextia ADR 0107).
const FRAME = {
  revision: 3,
  rules: [
    { id: 'r-1', theme: 'interface', level: 'mandatory', text: 'TEST L’interface est réalisée avec React et Vite.' },
    { id: 'r-2', theme: 'data', level: 'mandatory', text: 'TEST Le back-end enregistre ses données dans PostgreSQL.' },
  ],
  updatedAt: '2026-11-23T12:00:00+00:00',
  text: {
    fr: 'Cadre technique de l’espace de travail (révision 3), fixé par ses administrateurs :\nObligatoire :\n- Interface et framework : TEST L’interface est réalisée avec React et Vite.\n- Données et back-end : TEST Le back-end enregistre ses données dans PostgreSQL.',
    en: 'Technical frame of the Workspace (revision 3), set by its administrators:\nMandatory:\n- Interface and framework: TEST L’interface est réalisée avec React et Vite.',
  },
};

async function withBackend(options, body) {
  const backend = await startFakeBackend(options);
  try {
    await body(backend, cliHarness(backend));
  } finally {
    await backend.close();
  }
}

test('a version name is one short line, refused before anything is sent', () => {
  assert.equal(versionNameOf(undefined), undefined);
  assert.equal(versionNameOf('  Export   PDF '), 'Export PDF');
  assert.equal(versionNameOf('x'.repeat(MAX_VERSION_NAME)).length, MAX_VERSION_NAME);
  for (const bad of ['', '   ', 'x'.repeat(MAX_VERSION_NAME + 1), 'bell\u0007']) {
    assert.throws(() => versionNameOf(bad), { code: 'VERSION_NAME_INVALID' }, JSON.stringify(bad));
  }
});

test('deploy --version-name sends the name beside the manifest, never inside it', async () => {
  await withBackend({ completeFailures: 0 }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const project = makeProject();
    const result = await cli.run(['deploy', project, '--version-name', '  TEST Export   PDF ', '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.json.versionName, 'TEST Export PDF');
    assert.equal(result.json.status.versionName, 'TEST Export PDF');
    const [sent] = backend.state.prepareCalls;
    assert.equal(sent.versionName, 'TEST Export PDF');
    assert.ok(!('versionName' in sent.manifest));
    // The project's own file is left alone: the name is not part of the application.
    assert.ok(!fs.readFileSync(path.join(project, 'zenextia.app.json'), 'utf8').includes('TEST Export PDF'));
  });
});

test('the person reads the name next to the version number', async () => {
  await withBackend({ completeFailures: 0 }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const project = makeProject();
    const sent = await cli.run(['deploy', project, '--version-name', 'TEST Export PDF']);
    assert.equal(sent.code, 0, sent.stderr + sent.stdout);
    const said = sent.stdout + sent.stderr;
    assert.match(said, /Archive de « [^»]+ » \S+ « TEST Export PDF » :/);
    assert.match(said, /Version 0\.1\.0 « TEST Export PDF » \(/);
    // A version without a name reads as before.
    const plain = await cli.run(['deploy', makeProject()]);
    assert.doesNotMatch(plain.stdout + plain.stderr, /« TEST Export PDF »/);
  });
});

test('deploy without a name sends no such argument', async () => {
  // An API that predates version names refuses an argument it does not know.
  await withBackend({ completeFailures: 0, versionNames: false }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const result = await cli.run(['deploy', makeProject(), '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.json.versionName, null);
    assert.ok(!('versionName' in backend.state.prepareCalls[0]));
  });
});

test('an environment that does not take names yet says so, and how to name the version', async () => {
  await withBackend({ versionNames: false }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const result = await cli.run(['deploy', makeProject(), '--version-name', 'TEST Export PDF', '--json']);
    assert.equal(result.code, 1);
    assert.equal(result.json.error.code, 'VERSION_NAME_UNSUPPORTED');
    assert.match(result.json.error.hint, /sans --version-name/);
    assert.equal(backend.state.uploads.size, 0);
  });
});

test('a name too long is a usage error and nothing leaves the workstation', async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const before = backend.state.log.length;
    const result = await cli.run(['deploy', makeProject(), '--version-name', 'x'.repeat(61), '--json']);
    assert.equal(result.code, 2);
    assert.equal(result.json.error.code, 'VERSION_NAME_INVALID');
    assert.equal(backend.state.log.length, before);
    // The option belongs to deploy only.
    assert.equal((await cli.run(['status', '--version-name', 'TEST', '--json'])).code, 2);
  });
});

test('init writes the Workspace technical frame at the end of ZENEXTIA.md when signed in', async () => {
  await withBackend({ frame: FRAME }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const root = makeProject({});
    const result = await cli.run(['init', root, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.deepEqual(result.json.technicalFrame, { revision: 3, rules: 2 });
    const spoken = await cli.run(['init', makeProject({})]);
    assert.match(spoken.stdout + spoken.stderr, /cadre technique de votre espace \(révision 3\)/);
    const guide = fs.readFileSync(path.join(root, GUIDE_FILE), 'utf8');
    const section = guide.slice(guide.indexOf('## Cadre technique de votre espace de travail'));
    assert.ok(section.startsWith('## Cadre technique'), 'the section is there');
    assert.ok(section.includes('- Données et back-end : TEST Le back-end enregistre ses données dans PostgreSQL.'));
    assert.match(section, /Respecte les règles obligatoires/);
    // It comes after every rule of the guide, and the guide itself is unchanged.
    assert.ok(guide.startsWith('<!-- Écrit par @zenextia/cli'));
    assert.ok(guide.includes(agentGuide({ lang: 'fr', api: backend.base }).trimEnd().slice(-200)));
    assert.deepEqual(backend.state.frameCalls, [{ lang: 'fr' }, { lang: 'fr' }]);

    const english = await cli.run(['init', makeProject({}), '--lang', 'en', '--json']);
    assert.equal(english.code, 0);
    assert.deepEqual(backend.state.frameCalls.at(-1), { lang: 'en' });
    assert.ok(fs.readFileSync(english.json.file, 'utf8').includes('## Technical frame of your Workspace'));
  });
});

test('init never needs a sign-in, a frame or a recent API', async () => {
  // Not signed in: no request to the connector, no section.
  await withBackend({ frame: FRAME }, async (backend, cli) => {
    const root = makeProject({});
    const result = await cli.run(['init', root, '--json']);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.json.technicalFrame, null);
    assert.ok(!fs.readFileSync(path.join(root, GUIDE_FILE), 'utf8').includes('Cadre technique de votre espace'));
    assert.equal(backend.state.frameCalls, undefined);
    assert.ok(!backend.state.log.some((line) => line.includes('/mcp')));
  });
  // Signed in, but this API has no such tool, or the Workspace set no rule.
  for (const options of [{}, { frame: { ...FRAME, rules: [] } }]) {
    await withBackend(options, async (backend, cli) => {
      assert.equal((await cli.run(['login', '--json'])).code, 0);
      const root = makeProject({});
      const result = await cli.run(['init', root, '--json']);
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.equal(result.json.technicalFrame, null);
      assert.ok(!fs.readFileSync(path.join(root, GUIDE_FILE), 'utf8').includes('Cadre technique de votre espace'));
    });
  }
});

test('the frame section is empty without rules', () => {
  assert.equal(frameSection(null), '');
  assert.equal(frameSection({ revision: 1, rules: [], text: 'TEST' }), '');
  assert.equal(frameSection({ revision: 1, rules: [{}], text: '' }), '');
  const section = frameSection({ revision: 1, rules: [{}], text: 'TEST règle' }, 'fr');
  assert.match(section, /^\n## Cadre technique de votre espace de travail\n/);
  assert.match(section, /TEST règle/);
});

test('the guide tells the agent about the name, the frame and the screen by its name', () => {
  const french = agentGuide({ lang: 'fr' });
  assert.match(french, /--version-name "Export PDF"/);
  assert.match(french, /factory_technical_frame/);
  assert.match(french, /Zenextia ne les voit pas/);
  assert.match(french, /Applications › Gérer les applications/);
  const english = agentGuide({ lang: 'en' });
  assert.match(english, /--version-name "PDF export"/);
  assert.match(english, /Applications › Manage applications/);
});
