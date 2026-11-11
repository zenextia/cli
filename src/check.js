// `zenextia check`: inspect the built application (dist/) on the author's
// machine with the rules the build service applies, before any upload.

import fs from 'node:fs';
import path from 'node:path';

import { CliError } from './errors.js';
import { getJson } from './http.js';

export const OUTPUT_DIRECTORY = 'dist';

// Copy of GET /ai-factory/bundle-rules, used only when the API cannot be reached.
export const EMBEDDED_RULES = Object.freeze({
  acceptedExtensions: [
    '.aac', '.afm', '.avif', '.bcmap', '.bin', '.css', '.csv', '.dat', '.data', '.flac', '.gif', '.gz',
    '.html', '.icc', '.icm', '.ico', '.jpeg', '.jpg', '.js', '.json', '.m4a', '.md', '.mjs', '.mp3',
    '.mp4', '.oga', '.ogg', '.ogv', '.otf', '.pdf', '.pfb', '.png', '.svg', '.traineddata', '.ttf',
    '.txt', '.vtt', '.wasm', '.wav', '.weba', '.webm', '.webmanifest', '.webp', '.woff', '.woff2',
  ],
  noticeFiles: ['AUTHORS', 'COPYING', 'LICENCE', 'LICENSE', 'NOTICE', 'README'],
  maxEntries: 2000,
  maxAssetBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024,
  maxArchiveBytes: 25 * 1024 * 1024,
});

const ROOT_ABSOLUTE = /(?:\s(?:src|href|poster|srcset|data)\s*=\s*["']?|url\(\s*["']?|@import\s+["'])\/(?!\/)/i;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*[^<\s]/i;
const INLINE_HANDLER = /<[a-z][^>]*\son[a-z]+\s*=/i;
const FORM = /<form\b/i;

/** The platform's current rules, or the embedded copy when offline. */
export async function fetchRules(origin) {
  try {
    const { status, body } = await getJson(`${origin}/ai-factory/bundle-rules`);
    const rules = body?.data;
    if (status === 200 && Array.isArray(rules?.acceptedExtensions) && Array.isArray(rules?.noticeFiles)) {
      return { rules, source: 'api' };
    }
  } catch {
    // Offline or an older platform: fall back to the copy shipped with the CLI.
  }
  return { rules: EMBEDDED_RULES, source: 'embedded' };
}

function accepted(name, rules) {
  const extension = path.posix.extname(name);
  if (!extension) return rules.noticeFiles.includes(name.toUpperCase());
  return rules.acceptedExtensions.includes(extension);
}

/**
 * Check `dist/` of a project. Problems are what the build service refuses;
 * warnings are what it accepts but the application frame will not run.
 */
export function checkBuild(root, manifest, rules) {
  const output = path.join(root, OUTPUT_DIRECTORY);
  if (!fs.statSync(output, { throwIfNoEntry: false })?.isDirectory()) {
    throw new CliError(`Le dossier ${OUTPUT_DIRECTORY}/ est introuvable.`, {
      code: 'BUILD_OUTPUT_MISSING',
      hint: 'Lancez « npm run build » avant « zenextia check ».',
    });
  }
  const problems = [];
  const warnings = [];
  const problem = (code, file, message) => problems.push({ code, path: file, message });
  const warning = (code, file, message) => warnings.push({ code, path: file, message });
  const files = new Set();
  let entries = 0;
  let bytes = 0;

  const walk = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      entries += 1;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        problem('FORBIDDEN_FILE', name, 'Fichiers cachés et node_modules sont refusés.');
        continue;
      }
      if (!relative && entry.name.toLowerCase() === '__zenextia') {
        problem('RESERVED_PATH', name, 'Le dossier __zenextia est réservé à Zenextia.');
        continue;
      }
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        problem('UNSAFE_ENTRY', name, 'Les liens et fichiers spéciaux sont refusés.');
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, name);
        continue;
      }
      files.add(name);
      const size = fs.statSync(full).size;
      bytes += size;
      if (!accepted(entry.name, rules)) {
        problem('FORBIDDEN_FILE', name, 'Type de fichier non accepté.');
        continue;
      }
      if (size > rules.maxAssetBytes) {
        problem('ASSET_TOO_LARGE', name, `Fichier de plus de ${Math.round(rules.maxAssetBytes / 1048576)} Mo.`);
        continue;
      }
      const content = fs.readFileSync(full);
      const text = content.toString('latin1');
      if (PRIVATE_KEY.test(text)) problem('PRIVATE_KEY', name, 'Une clé privée a été trouvée dans ce fichier.');
      const extension = path.posix.extname(name).toLowerCase();
      if ((extension === '.html' || extension === '.css') && ROOT_ABSOLUTE.test(text)) {
        problem('ABSOLUTE_ASSET_PATH', name, 'Un chemin part de la racine du site (/...) : utilisez des chemins relatifs (avec Vite, base: \'./\').');
      }
      if (extension === '.html') {
        if (INLINE_SCRIPT.test(text)) warning('INLINE_SCRIPT', name, 'Un script écrit dans le HTML ne s\'exécutera pas : placez-le dans un fichier .js.');
        if (INLINE_HANDLER.test(text)) warning('INLINE_HANDLER', name, 'Un attribut on…= (onclick…) ne s\'exécutera pas : utilisez addEventListener.');
        if (FORM.test(text)) warning('FORM_SUBMIT', name, 'L\'envoi de formulaire est bloqué : réagissez au clic du bouton plutôt qu\'à submit.');
      }
    }
  };
  walk(output, '');

  if (entries > rules.maxEntries) {
    problem('TOO_MANY_FILES', OUTPUT_DIRECTORY, `Plus de ${rules.maxEntries} fichiers et dossiers.`);
  }
  if (bytes > rules.maxExpandedBytes) {
    problem('BUILD_TOO_LARGE', OUTPUT_DIRECTORY, `Plus de ${Math.round(rules.maxExpandedBytes / 1048576)} Mo au total.`);
  }
  const entrypoint = typeof manifest.entrypoint === 'string' && manifest.entrypoint ? manifest.entrypoint : 'index.html';
  if (!files.has(entrypoint)) {
    problem('ENTRYPOINT_MISSING', entrypoint, `${OUTPUT_DIRECTORY}/${entrypoint} est introuvable (champ « entrypoint » du manifeste).`);
  }
  if (typeof manifest.icon === 'string' && manifest.icon && !files.has(manifest.icon)) {
    problem('ICON_MISSING', manifest.icon, `${OUTPUT_DIRECTORY}/${manifest.icon} est introuvable (champ « icon » du manifeste).`);
  }
  return { problems, warnings, files: files.size, bytes };
}
