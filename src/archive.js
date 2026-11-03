// Source archive of an AI Factory project (deploy contract, section 4).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CliError, usageError } from './errors.js';
import { IgnoreMatcher } from './gitignore.js';
import { ZipLimitError, ZipWriter } from './zip.js';

export const MANIFEST_FILE = 'zenextia.app.json';
export const REQUIRED_FILES = Object.freeze([MANIFEST_FILE, 'package.json', 'package-lock.json']);
export const LIMITS = Object.freeze({ maxBytes: 100 * 1024 * 1024, maxEntries: 20_000 });

/** Names never archived, at any depth, whatever .gitignore says. */
export function isAlwaysExcluded(name) {
  const lower = name.toLowerCase();
  return (
    lower === '.git' || lower === 'node_modules' || lower === '.npmrc' || lower.startsWith('.env')
  );
}

function isSafeName(name) {
  // Backslashes would become path separators once extracted on Windows.
  // eslint-disable-next-line no-control-regex
  return name !== '.' && name !== '..' && !/[\\\u0000-\u001f\u007f]/.test(name);
}

/**
 * List the files to archive, sorted, with project-relative POSIX paths.
 * @param {string} root
 * @param {{maxEntries?: number}} [options]
 * @returns {Array<{path: string, absolute: string}>}
 */
export function collectFiles(root, { maxEntries = LIMITS.maxEntries } = {}) {
  const matcher = new IgnoreMatcher();
  const files = [];

  const walk = (relativeDir) => {
    const absoluteDir = relativeDir ? path.join(root, ...relativeDir.split('/')) : root;
    const gitignore = path.join(absoluteDir, '.gitignore');
    const gitignoreStat = fs.lstatSync(gitignore, { throwIfNoEntry: false });
    if (gitignoreStat?.isFile()) matcher.add(fs.readFileSync(gitignore, 'utf8'), relativeDir);

    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .map((entry) => entry.name)
      .sort(compareNames);
    for (const name of entries) {
      if (isAlwaysExcluded(name)) continue;
      const relative = relativeDir ? `${relativeDir}/${name}` : name;
      const absolute = path.join(absoluteDir, name);
      const stat = fs.lstatSync(absolute);
      const isDir = stat.isDirectory();
      const required = relativeDir === '' && REQUIRED_FILES.includes(name) && stat.isFile();
      if (!required && matcher.ignores(relative, isDir)) continue;
      if (!isSafeName(name)) {
        throw new CliError(`Nom de fichier non pris en charge dans l'archive : ${relative}`, {
          code: 'SOURCE_PATH_INVALID',
          hint: 'Renommez le fichier ou ajoutez-le au .gitignore.',
        });
      }
      if (stat.isSymbolicLink()) {
        throw new CliError(`Les liens symboliques ne sont pas acceptés : ${relative}`, {
          code: 'SOURCE_SYMLINK_REFUSED',
          hint: 'Remplacez le lien par le fichier lui-même ou ajoutez-le au .gitignore.',
        });
      }
      if (isDir) {
        walk(relative);
      } else if (stat.isFile()) {
        files.push({ path: relative, absolute });
        if (files.length > maxEntries) {
          throw new CliError(
            `Le projet contient plus de ${maxEntries} fichiers à envoyer, la limite de Zenextia.`,
            { code: 'SOURCE_TOO_MANY_ENTRIES', hint: 'Excluez les fichiers inutiles via .gitignore.' },
          );
        }
      } else {
        throw new CliError(`Fichier spécial refusé : ${relative}`, {
          code: 'SOURCE_SPECIAL_FILE_REFUSED',
          hint: 'Ajoutez-le au .gitignore.',
        });
      }
    }
  };

  walk('');
  return files.sort((a, b) => compareNames(a.path, b.path));
}

// Byte order of the UTF-8 encoding: independent of locale and platform.
function compareNames(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Build the deterministic source ZIP.
 * @returns {{buffer: Buffer, sha256: string, bytes: number, entries: string[]}}
 */
export function buildSourceArchive(root, { maxBytes = LIMITS.maxBytes, maxEntries = LIMITS.maxEntries } = {}) {
  const files = collectFiles(root, { maxEntries });
  const writer = new ZipWriter({ maxBytes, maxEntries });
  try {
    for (const file of files) writer.add(file.path, fs.readFileSync(file.absolute));
  } catch (error) {
    if (error instanceof ZipLimitError) {
      throw new CliError(
        error.kind === 'bytes'
          ? `L'archive des sources dépasse ${Math.round(maxBytes / 1024 / 1024)} Mio, la limite de Zenextia.`
          : `Le projet contient plus de ${maxEntries} fichiers à envoyer, la limite de Zenextia.`,
        {
          code: error.kind === 'bytes' ? 'SOURCE_TOO_LARGE' : 'SOURCE_TOO_MANY_ENTRIES',
          hint: 'Excluez les fichiers inutiles (médias, sorties de build) via .gitignore.',
        },
      );
    }
    throw error;
  }
  const buffer = writer.finish();
  return {
    buffer,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.length,
    entries: files.map((file) => file.path),
  };
}

function readJson(root, name) {
  const file = path.join(root, name);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) {
    throw usageError(`Fichier manquant : ${name} (dans ${root}).`, {
      code: 'PROJECT_FILE_MISSING',
      hint:
        name === 'package-lock.json'
          ? 'Lancez « npm install » pour générer le package-lock.json.'
          : undefined,
    });
  }
  if (!stat.isFile()) {
    throw usageError(`${name} doit être un fichier ordinaire.`, { code: 'PROJECT_FILE_INVALID' });
  }
  const text = fs.readFileSync(file, 'utf8');
  try {
    return { text, value: JSON.parse(text.replace(/^﻿/, '')) };
  } catch (error) {
    throw usageError(`${name} n'est pas un JSON valide : ${error.message}`, {
      code: 'PROJECT_FILE_INVALID',
    });
  }
}

/**
 * Read and pre-check the project, so obvious mistakes fail before upload.
 * The backend remains the authority on every rule.
 */
export function readProject(root) {
  const resolved = path.resolve(root);
  const rootStat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory()) {
    throw usageError(`Dossier introuvable : ${resolved}`, { code: 'PROJECT_NOT_FOUND' });
  }
  const manifest = readJson(resolved, MANIFEST_FILE).value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw usageError(`${MANIFEST_FILE} doit contenir un objet JSON.`, { code: 'MANIFEST_INVALID' });
  }
  for (const field of ['id', 'version']) {
    if (typeof manifest[field] !== 'string' || manifest[field] === '') {
      throw usageError(`${MANIFEST_FILE} : le champ « ${field} » est obligatoire.`, {
        code: 'MANIFEST_INVALID',
      });
    }
  }
  const pkg = readJson(resolved, 'package.json').value;
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw usageError('package.json doit contenir un objet JSON.', { code: 'PACKAGE_JSON_INVALID' });
  }
  checkLockfile(readJson(resolved, 'package-lock.json').value);
  return { root: resolved, manifest };
}

/** The npm lockfile profile of the build service (lockfile v3, npmjs, sha512). */
export function checkLockfile(lock) {
  const fail = (message) => {
    throw usageError(`package-lock.json : ${message}`, {
      code: 'LOCKFILE_INVALID',
      hint: 'Régénérez-le avec npm 7 ou plus récent (« npm install ») depuis registry.npmjs.org.',
    });
  };
  if (!lock || typeof lock !== 'object') fail('contenu invalide.');
  if (lock.lockfileVersion !== 3) {
    fail(`lockfileVersion ${JSON.stringify(lock.lockfileVersion)} au lieu de 3.`);
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object' || !('' in packages)) {
    fail('la section « packages » est absente.');
  }
  for (const [location, entry] of Object.entries(packages)) {
    if (location === '') continue;
    if (!location.startsWith('node_modules/') || entry?.link) {
      fail(`« ${location} » est un paquet local ou lié, non accepté.`);
    }
    let resolvedUrl;
    try {
      resolvedUrl = new URL(entry.resolved);
    } catch {
      fail(`« ${location} » n'a pas d'URL « resolved ».`);
    }
    if (resolvedUrl.protocol !== 'https:' || resolvedUrl.host !== 'registry.npmjs.org') {
      fail(`« ${location} » ne vient pas de https://registry.npmjs.org.`);
    }
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      fail(`« ${location} » n'a pas d'empreinte sha512.`);
    }
  }
}
