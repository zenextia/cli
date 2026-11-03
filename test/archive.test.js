import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

import { buildSourceArchive, checkLockfile, collectFiles, readProject } from '../src/archive.js';
import { crc32, listZipEntries } from '../src/zip.js';
import { LOCKFILE, makeProject, writeFiles } from '../test-support/project.js';

function readEntry(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
}

test('crc32 matches the reference value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('always excludes .git, node_modules, .env* and .npmrc at any depth', () => {
  const root = makeProject({
    '.git/HEAD': 'ref: refs/heads/main\n',
    'node_modules/left-pad/index.js': 'module.exports = 1;\n',
    'packages/ui/node_modules/x/index.js': '1\n',
    '.env': 'SECRET=TEST\n',
    '.env.local': 'SECRET=TEST\n',
    '.ENV.production': 'SECRET=TEST\n',
    'config/.env.test': 'SECRET=TEST\n',
    '.npmrc': '//registry.npmjs.org/:_authToken=TEST\n',
    'sub/.npmrc': 'x\n',
    'src/environment.js': 'export default 1;\n',
  });
  const paths = collectFiles(root).map((file) => file.path);
  assert.deepEqual(paths, [
    'index.html',
    'package-lock.json',
    'package.json',
    'src/environment.js',
    'src/main.js',
    'zenextia.app.json',
  ]);
});

test('honours root and nested .gitignore files, including negation', () => {
  const root = makeProject({
    '.gitignore': 'dist/\n*.log\n!keep.log\n/coverage\n',
    'dist/app.js': 'built\n',
    'logs/a.log': 'x\n',
    'logs/keep.log': 'kept\n',
    'coverage/lcov.info': 'x\n',
    'src/coverage/notes.md': 'kept: not anchored here\n',
    'src/.gitignore': 'generated/\n!important.log\n',
    'src/generated/x.js': 'x\n',
    'src/important.log': 'kept\n',
  });
  const paths = collectFiles(root).map((file) => file.path);
  assert.deepEqual(paths, [
    '.gitignore',
    'index.html',
    'logs/keep.log',
    'package-lock.json',
    'package.json',
    'src/.gitignore',
    'src/coverage/notes.md',
    'src/important.log',
    'src/main.js',
    'zenextia.app.json',
  ]);
});

test('required root files are kept even when .gitignore lists them', () => {
  const root = makeProject({ '.gitignore': 'package-lock.json\n*.json\n' });
  const paths = collectFiles(root).map((file) => file.path);
  assert.ok(paths.includes('package-lock.json'));
  assert.ok(paths.includes('package.json'));
  assert.ok(paths.includes('zenextia.app.json'));
});

test('refuses symlinks unless they are excluded', (t) => {
  const root = makeProject();
  try {
    fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'link.html'), 'file');
  } catch {
    // Windows without the symlink privilege: a junction needs none.
    try {
      fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link.html'), 'junction');
    } catch (error) {
      t.skip(`links unavailable here (${error.code})`);
      return;
    }
  }
  assert.throws(() => collectFiles(root), { code: 'SOURCE_SYMLINK_REFUSED' });
  fs.writeFileSync(path.join(root, '.gitignore'), 'link.html\n');
  assert.ok(!collectFiles(root).some((file) => file.path === 'link.html'));
});

test('the archive is deterministic: order, timestamps and bytes', () => {
  const files = {
    'b.txt': 'b\n',
    'a/z.txt': 'z\n',
    'a/b.txt': 'TEST '.repeat(500),
    'Upper.txt': 'U\n',
    'é.txt': 'accent\n',
  };
  const first = makeProject(files);
  const second = makeProject(files);
  const old = new Date('2001-02-03T04:05:06Z');
  for (const name of Object.keys(files)) fs.utimesSync(path.join(second, ...name.split('/')), old, old);

  const a = buildSourceArchive(first);
  const b = buildSourceArchive(second);
  assert.equal(a.sha256, b.sha256);
  assert.ok(a.buffer.equals(b.buffer));
  assert.equal(a.bytes, a.buffer.length);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);

  const entries = listZipEntries(a.buffer);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    [
      'Upper.txt',
      'a/b.txt',
      'a/z.txt',
      'b.txt',
      'index.html',
      'package-lock.json',
      'package.json',
      'src/main.js',
      'zenextia.app.json',
      'é.txt',
    ],
  );
  for (const entry of entries) {
    assert.equal(entry.time, 0);
    assert.equal(entry.date, 0x21);
    assert.ok(!entry.name.startsWith('/') && !entry.name.includes('..'));
  }
  const big = entries.find((entry) => entry.name === 'a/b.txt');
  assert.equal(big.method, 8);
  assert.equal(readEntry(a.buffer, big).toString(), 'TEST '.repeat(500));
  const small = entries.find((entry) => entry.name === 'b.txt');
  assert.equal(readEntry(a.buffer, small).toString(), 'b\n');
  assert.equal(crc32(readEntry(a.buffer, small)), small.crc);
});

test('enforces the size and entry limits', () => {
  const root = makeProject({ 'big.bin': Buffer.alloc(4096, 7) });
  assert.throws(() => buildSourceArchive(root, { maxBytes: 1024 }), { code: 'SOURCE_TOO_LARGE' });
  assert.throws(() => buildSourceArchive(root, { maxEntries: 3 }), {
    code: 'SOURCE_TOO_MANY_ENTRIES',
  });
});

test('readProject requires the manifest, package.json and a v3 lockfile', () => {
  const root = makeProject();
  assert.equal(readProject(root).manifest.id, 'test-crm');

  fs.rmSync(path.join(root, 'package-lock.json'));
  assert.throws(() => readProject(root), { code: 'PROJECT_FILE_MISSING', exitCode: 2 });

  writeFiles(root, { 'package-lock.json': JSON.stringify({ ...LOCKFILE, lockfileVersion: 2 }) });
  assert.throws(() => readProject(root), { code: 'LOCKFILE_INVALID' });

  writeFiles(root, { 'zenextia.app.json': '{"id": "x"}' });
  assert.throws(() => readProject(root), { code: 'MANIFEST_INVALID' });
});

test('lockfile profile: npmjs tarballs with sha512 only', () => {
  checkLockfile(LOCKFILE);
  const withPackage = (entry) => ({
    ...LOCKFILE,
    packages: { '': LOCKFILE.packages[''], 'node_modules/x': entry },
  });
  const good = LOCKFILE.packages['node_modules/left-pad'];
  assert.throws(
    () => checkLockfile(withPackage({ ...good, resolved: 'https://evil.example/x.tgz' })),
    { code: 'LOCKFILE_INVALID' },
  );
  assert.throws(() => checkLockfile(withPackage({ ...good, integrity: 'sha1-abc' })), {
    code: 'LOCKFILE_INVALID',
  });
  assert.throws(
    () =>
      checkLockfile({
        ...LOCKFILE,
        packages: { '': {}, 'packages/local': { link: true } },
      }),
    { code: 'LOCKFILE_INVALID' },
  );
});
