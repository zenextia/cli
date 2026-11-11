import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { run } from '../src/cli.js';
import { EMBEDDED_RULES, checkBuild } from '../src/check.js';
import { MANIFEST, makeProject, writeFiles } from '../test-support/project.js';

function sink() {
  const stream = { text: '', isTTY: false, write(chunk) { stream.text += chunk; return true; } };
  return stream;
}

async function cli(argv, env = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(argv, { stdout, stderr, env: { ZENEXTIA_CONFIG_DIR: makeProject(), ...env } });
  return { code, stdout: stdout.text, stderr: stderr.text, json: argv.includes('--json') ? JSON.parse(stdout.text) : null };
}

// The PDF editor of the first author: pdf.js resources must pass as they are.
const PDFJS_BUILD = {
  'dist/index.html': '<!doctype html><script type="module" src="assets/app.js"></script>',
  'dist/assets/app.js': 'console.log("TEST");',
  'dist/assets/pdf.worker.min.mjs': 'self.onmessage = () => {};',
  'dist/assets/cmaps/78-EUC-H.bcmap': 'binary',
  'dist/assets/standard_fonts/FoxitDingbats.pfb': 'font',
  'dist/assets/iccs/CGATS001Compat-v2-micro.icc': 'acsp',
  'dist/assets/iccs/LICENSE': 'MIT',
  'dist/assets/openjpeg.wasm': 'asm',
};

test('a pdf.js build passes the local check with the embedded rules', () => {
  const root = makeProject(PDFJS_BUILD);
  const report = checkBuild(root, MANIFEST, EMBEDDED_RULES);
  assert.deepEqual(report.problems, []);
  assert.equal(report.files, 8);
});

test('every refused file is listed with what the build service would say', () => {
  const root = makeProject({
    'dist/index.html': '<link href="/assets/app.css"><script>alert(1)</script><button onclick="go()">TEST</button><form></form>',
    'dist/server.py': 'print()',
    'dist/assets/app.js.map': '{}',
    'dist/.env': 'TEST=1',
    'dist/notes/build.zip': 'zip',
  });
  const report = checkBuild(root, { ...MANIFEST, icon: 'icon.png' }, EMBEDDED_RULES);
  const byPath = Object.fromEntries(report.problems.map((item) => [item.path, item.code]));
  assert.equal(byPath['server.py'], 'FORBIDDEN_FILE');
  assert.equal(byPath['assets/app.js.map'], 'FORBIDDEN_FILE');
  assert.equal(byPath['.env'], 'FORBIDDEN_FILE');
  assert.equal(byPath['notes/build.zip'], 'FORBIDDEN_FILE');
  assert.equal(byPath['index.html'], 'ABSOLUTE_ASSET_PATH');
  assert.equal(byPath['icon.png'], 'ICON_MISSING');
  assert.deepEqual(report.warnings.map((item) => item.code).sort(), ['FORM_SUBMIT', 'INLINE_HANDLER', 'INLINE_SCRIPT']);
});

test('zenextia check reads the platform rules and exits 1 on a refused file', async () => {
  const served = { ...EMBEDDED_RULES, acceptedExtensions: EMBEDDED_RULES.acceptedExtensions.filter((item) => item !== '.bcmap') };
  const server = http.createServer((request, response) => {
    if (request.url !== '/ai-factory/bundle-rules') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: served }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    const root = makeProject(PDFJS_BUILD);
    const refused = await cli(['check', root, '--api', api, '--json']);
    assert.equal(refused.code, 1, refused.stdout + refused.stderr);
    assert.equal(refused.json.rules, 'api');
    assert.deepEqual(refused.json.problems.map((item) => item.path), ['assets/cmaps/78-EUC-H.bcmap']);
    const human = await cli(['check', root, '--api', api]);
    assert.match(human.stdout, /Refusé · assets\/cmaps\/78-EUC-H\.bcmap/);
    assert.match(human.stdout, /Fichiers acceptés : /);
  } finally {
    server.close();
  }
});

test('zenextia check falls back to the embedded rules and asks for a build first', async () => {
  const root = makeProject(PDFJS_BUILD);
  const offline = await cli(['check', root, '--api', 'http://127.0.0.1:9', '--json']);
  assert.equal(offline.code, 0, offline.stdout + offline.stderr);
  assert.equal(offline.json.rules, 'embedded');
  const unbuilt = makeProject();
  const missing = await cli(['check', unbuilt, '--api', 'http://127.0.0.1:9', '--json']);
  assert.equal(missing.code, 1);
  assert.equal(missing.json.error.code, 'BUILD_OUTPUT_MISSING');
  writeFiles(unbuilt, { 'dist/app.js': 'x' });
  const noEntry = await cli(['check', unbuilt, '--api', 'http://127.0.0.1:9', '--json']);
  assert.deepEqual(noEntry.json.problems.map((item) => item.code), ['ENTRYPOINT_MISSING']);
});
