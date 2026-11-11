import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cliHarness } from '../test-support/cli.js';
import { startFakeBackend } from '../test-support/fake-backend.js';

// `zenextia login --code`: nothing listens on this machine, the member types
// the code in Zenextia from any device and the CLI polls (RFC 8628).
async function withBackend(options, body) {
  const backend = await startFakeBackend(options);
  try {
    await body(backend, cliHarness(backend));
  } finally {
    await backend.close();
  }
}

const noWait = { sleep: async () => {} };

test('login --code shows the code, waits for the approval and stores the session', async () => {
  await withBackend({ device: { decision: 'approve', polls: 2 } }, async (backend, cli) => {
    const login = await cli.run(['login', '--code', '--json'], noWait);
    assert.equal(login.code, 0, login.stderr + login.stdout);
    assert.equal(login.json.ok, true);
    assert.match(login.stderr, /saisissez le code : BCDF-GHJK/);
    assert.match(login.stderr, /\/mcp\/oauth\/device\?code=BCDF-GHJK/);
    assert.equal(backend.state.log.filter((line) => line === 'POST /mcp/oauth/token').length, 3);
    assert.equal(backend.state.log.some((line) => line.startsWith('GET /mcp/oauth/authorize')), false);
    const status = await cli.run(['status', '--installation', 'inst_TEST', '--json']);
    assert.notEqual(status.code, 3, status.stdout);
  });
});

test('a refused or expired code ends the login with an authentication error', async () => {
  for (const [decision, code] of [['deny', 'LOGIN_DENIED'], ['expire', 'LOGIN_TIMEOUT']]) {
    await withBackend({ device: { decision, polls: 0 } }, async (_backend, cli) => {
      const login = await cli.run(['login', '--code', '--json'], noWait);
      assert.equal(login.code, 3, decision);
      assert.equal(login.json.error.code, code);
    });
  }
});

test('an API without device sign-in says so, and --code refuses --no-browser', async () => {
  await withBackend({ withoutDevice: true }, async (_backend, cli) => {
    const login = await cli.run(['login', '--code', '--json'], noWait);
    assert.equal(login.code, 1);
    assert.equal(login.json.error.code, 'DEVICE_LOGIN_UNAVAILABLE');
    const both = await cli.run(['login', '--code', '--no-browser', '--json'], noWait);
    assert.equal(both.code, 2);
  });
});
