import { CliError, usageError } from './errors.js';

export const PRODUCTION_API = 'https://api.zenextia.com';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Normalise the API base URL to its origin. HTTPS is required, except on a
 * loopback host (local tests).
 */
export function apiOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`Adresse d'API invalide : ${value}`, { code: 'API_URL_INVALID' });
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw usageError(`L'API doit être en HTTPS : ${value}`, { code: 'API_URL_INVALID' });
  }
  return url.origin;
}

export function networkError(url, error) {
  const target = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  })();
  const cause = error?.cause?.code || error?.cause?.message || error?.message || String(error);
  return new CliError(`Impossible de joindre ${target} (${cause}).`, {
    code: 'NETWORK_ERROR',
    hint: 'Vérifiez votre connexion internet ou votre proxy, puis réessayez.',
  });
}

/** fetch with a timeout and a readable network error. */
export async function send(url, { timeoutMs = DEFAULT_TIMEOUT_MS, ...init } = {}) {
  try {
    return await fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw networkError(url, error);
  }
}

export async function readJsonBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function getJson(url) {
  const response = await send(url, { headers: { accept: 'application/json' } });
  return { status: response.status, body: await readJsonBody(response) };
}

export async function postJson(url, payload) {
  const response = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await readJsonBody(response) };
}

export async function postForm(url, fields) {
  const response = await send(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(
      Object.entries(fields).filter(([, value]) => value !== undefined && value !== null),
    ).toString(),
  });
  return { status: response.status, body: await readJsonBody(response) };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
