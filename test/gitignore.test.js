import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IgnoreMatcher, compilePattern } from '../src/gitignore.js';

function matcher(text, base = '') {
  return new IgnoreMatcher().add(text, base);
}

test('comments, blank lines and escapes', () => {
  assert.equal(compilePattern(''), null);
  assert.equal(compilePattern('# comment'), null);
  assert.equal(compilePattern('   '), null);
  const m = matcher('\\#hash\n\\!bang\ntrailing   \nkeep\\ \n');
  assert.equal(m.ignores('#hash'), true);
  assert.equal(m.ignores('!bang'), true);
  assert.equal(m.ignores('trailing'), true);
  assert.equal(m.ignores('keep '), true);
  assert.equal(m.ignores('keep'), false);
});

test('unanchored names match at any depth', () => {
  const m = matcher('*.log\nbuild\n');
  assert.equal(m.ignores('a.log'), true);
  assert.equal(m.ignores('deep/dir/a.log'), true);
  assert.equal(m.ignores('build', true), true);
  assert.equal(m.ignores('src/build', true), true);
  assert.equal(m.ignores('src/build.js'), false);
  assert.equal(m.ignores('a.logs'), false);
});

test('leading and inner slashes anchor the pattern', () => {
  const m = matcher('/dist\nsrc/generated\n');
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('packages/dist', true), false);
  assert.equal(m.ignores('src/generated', true), true);
  assert.equal(m.ignores('lib/src/generated', true), false);
});

test('directory-only patterns', () => {
  const m = matcher('logs/\n');
  assert.equal(m.ignores('logs', true), true);
  assert.equal(m.ignores('logs', false), false);
  assert.equal(m.ignores('a/logs', true), true);
});

test('negation: the last matching rule wins', () => {
  const m = matcher('*.json\n!package.json\n!/keep/*.json\n');
  assert.equal(m.ignores('data.json'), true);
  assert.equal(m.ignores('package.json'), false);
  assert.equal(m.ignores('sub/package.json'), false);
  assert.equal(m.ignores('keep/a.json'), false);
  assert.equal(m.ignores('other/a.json'), true);
  const reignored = matcher('!a.txt\na.txt\n');
  assert.equal(reignored.ignores('a.txt'), true);
});

test('double asterisks', () => {
  const m = matcher('**/cache\nfoo/**\na/**/b\n**/tmp/*.txt\n');
  assert.equal(m.ignores('cache', true), true);
  assert.equal(m.ignores('x/y/cache', true), true);
  assert.equal(m.ignores('foo', true), false);
  assert.equal(m.ignores('foo/x'), true);
  assert.equal(m.ignores('foo/x/y.js'), true);
  assert.equal(m.ignores('a/b'), true);
  assert.equal(m.ignores('a/x/y/b'), true);
  assert.equal(m.ignores('a/xb'), false);
  assert.equal(m.ignores('tmp/n.txt'), true);
  assert.equal(m.ignores('q/tmp/n.txt'), true);
  assert.equal(m.ignores('q/tmp/sub/n.txt'), false);
});

test('single star and question mark do not cross slashes', () => {
  const m = matcher('/src/*.tmp\nfile?.txt\n');
  assert.equal(m.ignores('src/a.tmp'), true);
  assert.equal(m.ignores('src/a/b.tmp'), false);
  assert.equal(m.ignores('file1.txt'), true);
  assert.equal(m.ignores('file12.txt'), false);
});

test('bracket classes', () => {
  const m = matcher('*.[oa]\nlog[!0-9].txt\n');
  assert.equal(m.ignores('x.o'), true);
  assert.equal(m.ignores('x.a'), true);
  assert.equal(m.ignores('x.c'), false);
  assert.equal(m.ignores('logx.txt'), true);
  assert.equal(m.ignores('log1.txt'), false);
});

test('regex metacharacters are literal', () => {
  const m = matcher('a+b(c).txt\n');
  assert.equal(m.ignores('a+b(c).txt'), true);
  assert.equal(m.ignores('aab(c)xtxt'), false);
});

test('nested .gitignore applies below its directory and overrides the root', () => {
  const m = new IgnoreMatcher().add('*.secret\n').add('!ok.secret\n/local\n', 'pkg');
  assert.equal(m.ignores('a.secret'), true);
  assert.equal(m.ignores('pkg/ok.secret'), false);
  assert.equal(m.ignores('ok.secret'), true);
  assert.equal(m.ignores('pkg/local', true), true);
  assert.equal(m.ignores('local', true), false);
});

test('CRLF and BOM are tolerated', () => {
  const m = matcher('\uFEFFdist\r\n*.log\r\n');
  assert.equal(m.ignores('dist', true), true);
  assert.equal(m.ignores('x.log'), true);
});
