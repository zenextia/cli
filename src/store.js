// Credentials and deployment state in the user's configuration directory,
// keyed by API origin so DEV, STAGING and production never mix.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CliError } from './errors.js';

const CREDENTIALS_FILE = 'credentials.json';
const DEPLOYMENTS_FILE = 'deployments.json';

export function configDir(env = process.env, platform = process.platform) {
  if (env.ZENEXTIA_CONFIG_DIR) return path.resolve(env.ZENEXTIA_CONFIG_DIR);
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'zenextia');
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'zenextia');
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Fichier de configuration illisible : ${file}`, {
      code: 'CONFIG_CORRUPT',
      hint: 'Supprimez-le puis relancez « zenextia login ».',
    });
  }
}

/** Write through a private temporary file and an atomic rename. */
export function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not every file system supports POSIX modes (Windows uses the ACL of %APPDATA%).
  }
}

export class Store {
  constructor(dir = configDir()) {
    this.dir = dir;
    this.credentialsFile = path.join(dir, CREDENTIALS_FILE);
    this.deploymentsFile = path.join(dir, DEPLOYMENTS_FILE);
  }

  #load(file) {
    const data = readJson(file);
    return data && typeof data === 'object' && data.apis ? data : { version: 1, apis: {} };
  }

  #update(file, origin, change) {
    const data = this.#load(file);
    const next = change({ ...(data.apis[origin] || {}) });
    if (next === null) delete data.apis[origin];
    else data.apis[origin] = next;
    writePrivateJson(file, data);
    return next;
  }

  /** @returns {{client?: object, tokens?: object}} */
  api(origin) {
    return this.#load(this.credentialsFile).apis[origin] || {};
  }

  saveClient(origin, client) {
    this.#update(this.credentialsFile, origin, (entry) => ({ ...entry, client }));
  }

  forgetClient(origin) {
    this.#update(this.credentialsFile, origin, ({ client, ...rest }) => rest);
  }

  saveTokens(origin, tokens) {
    this.#update(this.credentialsFile, origin, (entry) => ({ ...entry, tokens }));
  }

  clearTokens(origin) {
    let had = false;
    this.#update(this.credentialsFile, origin, ({ tokens, ...rest }) => {
      had = Boolean(tokens);
      return rest;
    });
    return had;
  }

  deployment(origin, applicationId) {
    return this.#load(this.deploymentsFile).apis[origin]?.[applicationId] || null;
  }

  saveDeployment(origin, applicationId, record) {
    this.#update(this.deploymentsFile, origin, (entry) => ({ ...entry, [applicationId]: record }));
  }
}
