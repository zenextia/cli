// `zenextia init`: write the full rules for coding agents into the project.
// The portal's brief stays a few lines and points here, so the rules follow
// the CLI release and the platform's file types instead of a pasted text.

import fs from 'node:fs';
import path from 'node:path';

import { EMBEDDED_RULES } from './check.js';
import { usageError } from './errors.js';
import { PRODUCTION_API } from './http.js';

export const GUIDE_FILE = 'ZENEXTIA.md';
export const GUIDE_LANGUAGES = ['fr', 'en'];

const TEMPLATES = new URL('./guide/', import.meta.url);

/** The CLI invocation an agent should run, naming the API outside production. */
export function cliInvocation(subcommand, api) {
  return `npx @zenextia/cli ${subcommand}${api ? ` --api ${api}` : ''}`;
}

/**
 * The agent guide in `lang`. `api` is the origin to name in commands, or null
 * for production; `rules` gives the accepted file types.
 */
export function agentGuide({ lang = 'fr', api = null, rules = EMBEDDED_RULES } = {}) {
  if (!GUIDE_LANGUAGES.includes(lang)) {
    throw usageError(`Langue inconnue : ${lang}`, { hint: `Choisissez parmi : ${GUIDE_LANGUAGES.join(', ')}.` });
  }
  const template = fs.readFileSync(new URL(`${lang}.md`, TEMPLATES), 'utf8').replace(/\r\n/g, '\n');
  const extensions = [...rules.acceptedExtensions]
    .map((extension) => extension.replace(/^\./, ''))
    .sort()
    .join(', ');
  const noticeFiles = [...rules.noticeFiles].sort().join(', ');
  return template
    .replace(/\{\{cli ([^}]+)\}\}/g, (_, subcommand) => cliInvocation(subcommand, api))
    .replace(/\{\{apiOrigin\}\}/g, api || PRODUCTION_API)
    .replace(/\{\{extensions\}\}/g, extensions)
    .replace(/\{\{noticeFiles\}\}/g, noticeFiles);
}

/**
 * The Workspace's technical frame as a section of ZENEXTIA.md, or '' when it
 * has none. `frame.text` comes from the API, already in the guide's language:
 * the rules its administrators set, mandatory first.
 */
export function frameSection(frame, lang = 'fr') {
  if (!frame?.text || !Array.isArray(frame.rules) || !frame.rules.length) return '';
  const en = lang === 'en';
  const heading = en ? '## Technical frame of your Workspace' : '## Cadre technique de votre espace de travail';
  const intro = en
    ? 'Your Workspace\'s administrators set these rules for every application made for it. Follow the mandatory ones; say so when you cannot follow a recommended one.'
    : 'Les administrateurs de votre espace ont fixé ces règles pour toute application réalisée pour lui. Respecte les règles obligatoires ; dis-le quand tu ne peux pas suivre une règle recommandée.';
  const refresh = en
    ? `Read on ${new Date().toISOString().slice(0, 10)}. Run "init" again to refresh it.`
    : `Lu le ${new Date().toISOString().slice(0, 10)}. Relancez « init » pour le mettre à jour.`;
  return `\n${heading}\n\n${intro}\n\n${frame.text.trim()}\n\n<!-- ${refresh} -->\n`;
}

/** Write ZENEXTIA.md at the project root and return where it went. */
export function writeAgentGuide(root, { lang, api, rules, version, frame = null }) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw usageError(`Le dossier ${root} est introuvable.`);
  }
  const header = lang === 'en'
    ? `<!-- Written by @zenextia/cli ${version}. Run "npx @zenextia/cli@latest init${api ? ` --api ${api}` : ''} --lang en" to refresh it. -->`
    : `<!-- Écrit par @zenextia/cli ${version}. Relancez « npx @zenextia/cli@latest init${api ? ` --api ${api}` : ''} » pour le mettre à jour. -->`;
  const file = path.join(root, GUIDE_FILE);
  fs.writeFileSync(file, `${header}\n\n${agentGuide({ lang, api, rules })}${frameSection(frame, lang)}`, 'utf8');
  return file;
}
