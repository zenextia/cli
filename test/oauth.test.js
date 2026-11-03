import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { browserCommand } from '../src/browser.js';
import { apiOrigin } from '../src/http.js';
import { buildAuthorizationUrl, createPkce, createState, sameSecret, startLoopbackServer } from '../src/oauth.js';
import { Store, configDir, writePrivateJson } from '../src/store.js';
import { tempDir } from '../test-support/project.js';

test('PKCE S256: verifier shape and challenge derivation', () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const { verifier, challenge, method } = createPkce();
    assert.equal(method, 'S256');
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
    assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
    seen.add(verifier);
  }
  assert.equal(seen.size, 20);
});

test('state is random and compared in constant time', () => {
  const a = createState();
  const b = createState();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
  assert.equal(sameSecret(a, a), true);
  assert.equal(sameSecret(a, b), false);
  assert.equal(sameSecret(a, a.slice(1)), false);
  assert.equal(sameSecret(a, null), false);
});

test('the authorization URL carries PKCE, state, scope and resource', () => {
  const url = new URL(
    buildAuthorizationUrl(
      { authorization_endpoint: 'https://api-dev.zenextia.com/mcp/oauth/authorize' },
      {
        clientId: 'mcp_client_TEST',
        redirectUri: 'http://127.0.0.1:5555/callback',
        challenge: 'c'.repeat(43),
        state: 's'.repeat(43),
        resource: 'https://api-dev.zenextia.com/mcp',
      },
    ),
  );
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'mcp:tools');
  assert.equal(url.searchParams.get('resource'), 'https://api-dev.zenextia.com/mcp');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5555/callback');
});

test('loopback callback: wrong state refused, then single use', async () => {
  const state = createState();
  const loopback = await startLoopbackServer({ state, timeoutMs: 5000 });
  assert.match(loopback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

  const other = await fetch(`http://127.0.0.1:${loopback.port}/favicon.ico`);
  assert.equal(other.status, 404);

  const forged = await fetch(`${loopback.redirectUri}?code=EVIL&state=wrong`);
  assert.equal(forged.status, 400);
  await forged.text();

  const genuine = await fetch(`${loopback.redirectUri}?code=GOOD&state=${state}`);
  assert.equal(genuine.status, 200);
  assert.match(await genuine.text(), /Connexion réussie/);
  assert.deepEqual(await loopback.result, { code: 'GOOD' });

  // The server is closed after the first genuine response.
  await assert.rejects(fetch(`${loopback.redirectUri}?code=AGAIN&state=${state}`));
});

test('loopback callback: access_denied and timeout reject with auth errors', async () => {
  const state = createState();
  const denied = await startLoopbackServer({ state, timeoutMs: 5000 });
  const response = await fetch(`${denied.redirectUri}?error=access_denied&state=${state}`);
  assert.equal(response.status, 400);
  await response.text();
  await assert.rejects(denied.result, { exitCode: 3, code: 'OAUTH_ACCESS_DENIED' });

  const slow = await startLoopbackServer({ state, timeoutMs: 30 });
  await assert.rejects(slow.result, { exitCode: 3, code: 'LOGIN_TIMEOUT' });
});

test('browser command per platform', () => {
  const url = 'https://api.zenextia.com/mcp/oauth/authorize?a=1&b=%20';
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});

test('API origin: production default, HTTPS required except loopback', () => {
  assert.equal(apiOrigin('https://api-dev.zenextia.com/'), 'https://api-dev.zenextia.com');
  assert.equal(apiOrigin('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
  assert.throws(() => apiOrigin('http://api.zenextia.com'), { exitCode: 2 });
  assert.throws(() => apiOrigin('not a url'), { exitCode: 2 });
});

test('config directory per platform', () => {
  assert.equal(
    configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32'),
    path.join('C:\\Users\\a\\AppData\\Roaming', 'zenextia'),
  );
  assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux'), path.join('/xdg', 'zenextia'));
  assert.equal(configDir({ ZENEXTIA_CONFIG_DIR: '/custom' }, 'linux'), path.resolve('/custom'));
});

test('credential store: keyed by origin, private file mode', () => {
  const dir = path.join(tempDir(), 'nested', 'zenextia');
  const store = new Store(dir);
  store.saveClient('https://api-dev.zenextia.com', { client_id: 'dev' });
  store.saveTokens('https://api-dev.zenextia.com', { access_token: 'TEST' });
  store.saveClient('https://api.zenextia.com', { client_id: 'prod' });
  assert.equal(store.api('https://api-dev.zenextia.com').client.client_id, 'dev');
  assert.equal(store.api('https://api.zenextia.com').tokens, undefined);
  assert.equal(store.clearTokens('https://api-dev.zenextia.com'), true);
  assert.equal(store.clearTokens('https://api-dev.zenextia.com'), false);
  assert.equal(store.api('https://api-dev.zenextia.com').client.client_id, 'dev');
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
    'no temporary file left behind',
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.credentialsFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    // An existing file with loose permissions is tightened on write.
    fs.chmodSync(store.credentialsFile, 0o644);
    writePrivateJson(store.credentialsFile, { version: 1, apis: {} });
    assert.equal(fs.statSync(store.credentialsFile).mode & 0o777, 0o600);
  }
});
