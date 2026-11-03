// Builds throw-away AI Factory projects for the tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANIFEST = {
  schemaVersion: 1,
  sdkMajor: 1,
  id: 'test-crm',
  version: '0.1.0',
  name: 'TEST CRM',
  description: 'TEST application',
  author: 'TEST author',
};

export const LOCKFILE = {
  name: 'test-crm',
  version: '0.1.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'test-crm', version: '0.1.0', dependencies: { 'left-pad': '^1.3.0' } },
    'node_modules/left-pad': {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity:
        'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQEksJ8nYbQwvcGFTI+dY88+vy5k8ANEkHiXYO6bsSOFIb0w==',
    },
  },
};

export function tempDir(prefix = 'zenextia-cli-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

export function makeProject(extra = {}, { manifest = MANIFEST, lockfile = LOCKFILE } = {}) {
  const root = tempDir();
  writeFiles(root, {
    'zenextia.app.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'package.json': `${JSON.stringify({ name: 'test-crm', version: '0.1.0', private: true }, null, 2)}\n`,
    'package-lock.json': `${JSON.stringify(lockfile, null, 2)}\n`,
    'index.html': '<!doctype html><title>TEST</title>\n',
    'src/main.js': 'console.log("TEST");\n',
    ...extra,
  });
  return root;
}
