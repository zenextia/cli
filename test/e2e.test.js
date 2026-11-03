import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { cliHarness } from '../test-support/cli.js';
import { startFakeBackend } from '../test-support/fake-backend.js';
import { MANIFEST, makeProject } from '../test-support/project.js';

async function withBackend(options, body) {
  const backend = await startFakeBackend(options);
  try {
    await body(backend, cliHarness(backend));
  } finally {
    await backend.close();
  }
}

function credentials(cli) {
  return JSON.parse(fs.readFileSync(path.join(cli.configDir, 'credentials.json'), 'utf8'));
}

test('login, deploy and status end to end over SSE, with a retryable complete', async () => {
  await withBackend({}, async (backend, cli) => {
    const login = await cli.run(['login', '--json']);
    assert.equal(login.code, 0, login.stderr + login.stdout);
    assert.equal(login.json.ok, true);
    assert.equal(login.json.api, backend.base);
    assert.equal(login.json.resource, backend.resource);
    assert.equal(login.json.developerTools, true);
    assert.match(login.stderr, /\/mcp\/oauth\/authorize\?/);
    assert.equal(backend.state.clients.size, 1);

    const stored = credentials(cli).apis[backend.base];
    assert.ok(stored.client.client_id.startsWith('mcp_client_'));
    assert.ok(stored.tokens.access_token.startsWith('zxm_TEST'));
    assert.ok(stored.tokens.refresh_token.startsWith('mcp_refresh_'));

    // A second login reuses the cached client registration.
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    assert.equal(backend.state.clients.size, 1);

    const project = makeProject({ '.env': 'SECRET=TEST\n', '.gitignore': 'dist/\n', 'dist/x.js': '1' });
    const deploy = await cli.run(['deploy', project, '--json']);
    assert.equal(deploy.code, 0, deploy.stdout + deploy.stderr);
    assert.equal(deploy.json.ok, true);
    assert.equal(deploy.json.phase, 'ready');
    assert.equal(deploy.json.applicationId, MANIFEST.id);
    assert.equal(deploy.json.installationId, 'inst_TEST');
    assert.equal(deploy.json.previewUrl, 'https://app-dev.zenextia.com/applications/preview/TEST');
    assert.match(deploy.json.nextStep, /^TEST /);
    assert.match(deploy.json.buildId, /^bld_/);
    assert.equal(backend.state.completeCalls, 2, 'complete retried once');
    assert.equal(backend.state.statusCalls, 4, 'polled until verification settled');

    const prepared = backend.state.prepared.get(deploy.json.uploadId);
    assert.deepEqual(prepared.manifest, MANIFEST);
    assert.deepEqual(prepared.files, [
      '.gitignore',
      'index.html',
      'package-lock.json',
      'package.json',
      'src/main.js',
      'zenextia.app.json',
    ]);
    assert.equal(prepared.sha256, deploy.json.source.sha256);
    assert.equal(prepared.bytes, deploy.json.source.bytes);
    // Sessions are closed with DELETE.
    assert.ok(backend.state.log.includes('DELETE /mcp'));

    const status = await cli.run(['status', project, '--json']);
    assert.equal(status.code, 0, status.stdout);
    assert.equal(status.json.phase, 'ready');
    assert.equal(status.json.status.versionId, deploy.json.versionId);

    const byId = await cli.run(['status', '--installation', 'inst_TEST', '--json']);
    assert.equal(byId.code, 0);
    assert.equal(byId.json.installationId, 'inst_TEST');
  });
});

test('human output in French, with JSON-RPC answered as plain JSON and text-only results', async () => {
  await withBackend({ sse: false, structuredContent: false, completeFailures: 0 }, async (backend, cli) => {
    const login = await cli.run(['login']);
    assert.equal(login.code, 0, login.stderr);
    assert.match(login.stdout, /Connecté\./);
    assert.match(login.stdout, /outils de déploiement sont disponibles/);

    const project = makeProject();
    const deploy = await cli.run(['deploy', project]);
    assert.equal(deploy.code, 0, deploy.stderr);
    assert.match(deploy.stdout, /Archive de « test-crm » 0\.1\.0 : 5 fichiers/);
    assert.match(deploy.stdout, /Aperçu : https:\/\/app-dev\.zenextia\.com/);
    assert.match(deploy.stdout, /Étape suivante : TEST/);
    assert.match(deploy.stderr, /Construction : en file d'attente/);
    assert.match(deploy.stderr, /Construction : réussie · Vérification : réussie/);

    const logout = await cli.run(['logout']);
    assert.equal(logout.code, 0);
    assert.match(logout.stdout, /Déconnecté/);
    assert.equal(credentials(cli).apis[backend.base].tokens, undefined);
    assert.ok(credentials(cli).apis[backend.base].client, 'client registration kept');

    const after = await cli.run(['status', project, '--json']);
    assert.equal(after.code, 3);
    assert.equal(after.json.error.code, 'AUTH_REQUIRED');
  });
});

test('refreshes an expiring token and stores the rotated refresh token', async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const before = credentials(cli).apis[backend.base].tokens;

    const later = () => Date.now() + 2 * 60 * 60 * 1000;
    const status = await cli.run(['status', '--installation', 'inst_TEST', '--json'], { now: later });
    assert.equal(status.code, 0, JSON.stringify(status.json));
    assert.equal(backend.state.refreshCalls, 1);

    const after = credentials(cli).apis[backend.base].tokens;
    assert.notEqual(after.refresh_token, before.refresh_token);
    assert.notEqual(after.access_token, before.access_token);
    assert.equal(backend.state.refresh.has(before.refresh_token), false, 'old refresh token rotated out');
  });
});

test('a 401 from the MCP endpoint triggers one refresh and a replay', async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    backend.state.access.clear(); // revoked server-side, still "fresh" locally
    const status = await cli.run(['status', '--installation', 'inst_TEST', '--json']);
    assert.equal(status.code, 0, JSON.stringify(status.json));
    assert.equal(backend.state.unauthorized, 1);
    assert.equal(backend.state.refreshCalls, 1);
  });
});

test('a failed refresh asks to log in again (exit 3) and drops the tokens', async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    backend.state.refresh.clear();
    const later = () => Date.now() + 2 * 60 * 60 * 1000;
    const status = await cli.run(['status', '--installation', 'inst_TEST'], { now: later });
    assert.equal(status.code, 3);
    assert.match(status.stderr, /session Zenextia a expiré/);
    assert.match(status.stderr, /zenextia login/);
    assert.equal(credentials(cli).apis[backend.base].tokens, undefined);
  });
});

test('credentials are written with mode 0600', { skip: process.platform === 'win32' }, async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const mode = fs.statSync(path.join(cli.configDir, 'credentials.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('a denied consent exits with the auth code', async () => {
  await withBackend({ deny: true }, async (backend, cli) => {
    const login = await cli.run(['login', '--json']);
    assert.equal(login.code, 3);
    assert.equal(login.json.error.code, 'OAUTH_ACCESS_DENIED');
  });
});

test('deploy is refused clearly when the developer tools are hidden', async () => {
  await withBackend({ tools: ['factory_status'] }, async (backend, cli) => {
    const login = await cli.run(['login', '--json']);
    assert.equal(login.code, 0);
    assert.equal(login.json.developerTools, false);
    const deploy = await cli.run(['deploy', makeProject(), '--json']);
    assert.equal(deploy.code, 1);
    assert.equal(deploy.json.error.code, 'DEVELOPER_TOOLS_UNAVAILABLE');
    assert.match(deploy.json.error.hint, /Publier des applications/);
  });
});

test('a failed build exits 1 with the error and the next step', async () => {
  const statuses = [
    {
      build: { status: 'failed', error: { code: 'BUILD_FAILED', message: 'TEST npm run build exited 1' } },
      verification: { status: 'pending', error: null },
      nextStep: 'TEST Corrigez la construction puis redéployez.',
    },
  ];
  await withBackend({ statuses, completeFailures: 0 }, async (backend, cli) => {
    assert.equal((await cli.run(['login', '--json'])).code, 0);
    const deploy = await cli.run(['deploy', makeProject()]);
    assert.equal(deploy.code, 1);
    assert.match(deploy.stdout, /Échec de la construction : TEST npm run build exited 1 \(BUILD_FAILED\)/);
    assert.match(deploy.stdout, /Étape suivante : TEST Corrigez/);
  });
});

test('usage errors exit 2', async () => {
  await withBackend({}, async (backend, cli) => {
    assert.equal((await cli.run(['deploy', '--bogus'])).code, 2);
    assert.equal((await cli.run(['unknown'])).code, 2);
    assert.equal((await cli.run(['deploy', '--installation', 'x'])).code, 2);
    assert.equal((await cli.run(['status', makeProject(), '--json'])).code, 2, 'no known deployment');
    const missing = await cli.run(['deploy', path.join(makeProject(), 'nope'), '--json']);
    assert.equal(missing.code, 2);
    assert.equal(missing.json.error.code, 'PROJECT_NOT_FOUND');
  });
});
