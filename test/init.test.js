import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
