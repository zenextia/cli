// A small .gitignore matcher covering the patterns projects actually use:
// comments, escapes, trailing-space trimming, negation, directory-only
// patterns (`dir/`), anchoring (leading or inner `/`), `*`, `?`, `[...]`
// classes and `**` in leading, trailing and inner positions.
//
// Precedence follows git: rules are evaluated in order, the last matching
// rule wins, and the rules of a deeper .gitignore come after its ancestors'.
// A file inside an ignored directory cannot be re-included; the caller gets
// that behaviour by not descending into ignored directories.

/**
 * Compile one .gitignore line. Returns null for blank lines and comments.
 * @param {string} line
 * @returns {{regex: RegExp, negate: boolean, dirOnly: boolean, pattern: string} | null}
 */
export function compilePattern(line) {
  let pattern = line.replace(/\r$/, '');
  if (pattern === '' || pattern.startsWith('#')) return null;

  // Trailing spaces are ignored unless escaped with a backslash.
  while (pattern.endsWith(' ') && !pattern.endsWith('\\ ')) {
    pattern = pattern.slice(0, -1);
  }
  if (pattern === '') return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('\\!') || pattern.startsWith('\\#')) {
    pattern = pattern.slice(1);
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }
  if (pattern === '') return null;

  // A slash at the beginning or in the middle anchors the pattern to the
  // directory of the .gitignore; otherwise it matches at any depth.
  const anchored = pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const body = anchored ? pattern : `**/${pattern}`;

  return {
    regex: new RegExp(`^${translate(body)}$`),
    negate,
    dirOnly,
    pattern: line.trim(),
  };
}

function translate(pattern) {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const atSegmentStart = i === 0 || pattern[i - 1] === '/';
    if (atSegmentStart && pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (atSegmentStart && pattern.startsWith('**', i) && i + 2 === pattern.length) {
      out += '.*';
      i += 2;
      continue;
    }
    const char = pattern[i];
    if (char === '*') {
      out += '[^/]*';
      while (pattern[i] === '*') i += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (char === '[') {
      const parsed = bracket(pattern, i);
      if (parsed) {
        out += parsed.regex;
        i = parsed.end;
        continue;
      }
      out += '\\[';
      i += 1;
      continue;
    }
    if (char === '\\' && i + 1 < pattern.length) {
      out += escapeRegex(pattern[i + 1]);
      i += 2;
      continue;
    }
    out += escapeRegex(char);
    i += 1;
  }
  return out;
}

function bracket(pattern, start) {
  let j = start + 1;
  let negate = false;
  if (pattern[j] === '!' || pattern[j] === '^') {
    negate = true;
    j += 1;
  }
  let content = '';
  if (pattern[j] === ']') {
    content += '\\]';
    j += 1;
  }
  while (j < pattern.length && pattern[j] !== ']') {
    const char = pattern[j];
    if (char === '\\' && j + 1 < pattern.length) {
      content += escapeRegex(pattern[j + 1]);
      j += 2;
      continue;
    }
    content += char === '-' ? '-' : escapeRegex(char);
    j += 1;
  }
  if (j >= pattern.length) return null;
  // A bracket expression never matches the path separator.
  return { regex: `(?!/)[${negate ? '^' : ''}${content}]`, end: j + 1 };
}

function escapeRegex(char) {
  return /[\\^$.*+?()[\]{}|/-]/.test(char) ? `\\${char}` : char;
}

export class IgnoreMatcher {
  constructor() {
    /** @type {Array<{base: string, regex: RegExp, negate: boolean, dirOnly: boolean}>} */
    this.rules = [];
  }

  /**
   * Add the content of a .gitignore found in `base` (a project-relative
   * directory with forward slashes, '' for the root).
   */
  add(text, base = '') {
    const normalizedBase = base.replace(/^\/+|\/+$/g, '');
    for (const line of text.replace(/^﻿/, '').split('\n')) {
      const rule = compilePattern(line);
      if (rule) this.rules.push({ ...rule, base: normalizedBase });
    }
    return this;
  }

  /**
   * @param {string} path project-relative path with forward slashes
   * @param {boolean} isDir
   */
  ignores(path, isDir = false) {
    let ignored = false;
    for (const rule of this.rules) {
      let relative;
      if (rule.base === '') {
        relative = path;
      } else if (path.startsWith(`${rule.base}/`)) {
        relative = path.slice(rule.base.length + 1);
      } else {
        continue;
      }
      if (rule.dirOnly && !isDir) continue;
      if (rule.regex.test(relative)) ignored = !rule.negate;
    }
    return ignored;
  }
}
