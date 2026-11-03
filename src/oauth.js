// OAuth 2.1 client of the Zenextia MCP authorization facade: protected
// resource metadata (RFC 9728), authorization server metadata (RFC 8414),
// dynamic client registration (RFC 7591), authorization code with PKCE S256
// and a loopback redirect (RFC 8252), resource indicators (RFC 8707) and
// rotating refresh tokens.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import { CliError, EXIT, authError } from './errors.js';
import { getJson, postForm, postJson } from './http.js';

export const CLIENT_NAME = 'Zenextia CLI';
export const SCOPE = 'mcp:tools';
export const CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
// Refresh a little before expiry so a request never leaves with a dying token.
const EXPIRY_MARGIN_MS = 60 * 1000;

export function mcpUrl(origin) {
  return `${origin}/mcp`;
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
  return { verifier, challenge, method: 'S256' };
}

export function createState() {
  return base64url(randomBytes(32));
}

export function sameSecret(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function oauthFailure(step, response) {
  const code = response.body?.error || `HTTP_${response.status}`;
  const description = response.body?.error_description;
  return new CliError(
    `${step} refusée par Zenextia : ${description || code}.`,
    { exitCode: EXIT.AUTH, code: `OAUTH_${String(code).toUpperCase()}` },
  );
}

/** Discover the resource and its authorization server from the API origin. */
export async function discover(origin) {
  const resourceResponse = await getJson(`${origin}/.well-known/oauth-protected-resource/mcp`);
  if (resourceResponse.status !== 200 || !resourceResponse.body) {
    throw new CliError(`${origin} ne publie pas de point d'accès MCP Zenextia.`, {
      code: 'DISCOVERY_FAILED',
      hint: 'Vérifiez l\'adresse passée à --api.',
    });
  }
  const resourceMetadata = resourceResponse.body;
  const resource = resourceMetadata.resource || mcpUrl(origin);
  const issuer = resourceMetadata.authorization_servers?.[0] || origin;

  const issuerUrl = new URL(issuer);
  const suffix = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
  const candidates = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${issuerUrl.origin}${suffix}/.well-known/openid-configuration`,
  ];
  let metadata = null;
  for (const url of candidates) {
    const response = await getJson(url);
    if (response.status === 200 && response.body?.authorization_endpoint) {
      metadata = response.body;
      break;
    }
  }
  if (!metadata?.token_endpoint) {
    throw new CliError(`Serveur d'autorisation introuvable pour ${origin}.`, {
      code: 'DISCOVERY_FAILED',
    });
  }
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes('S256')) {
    throw new CliError('Le serveur d\'autorisation ne prend pas en charge PKCE S256.', {
      code: 'DISCOVERY_FAILED',
    });
  }
  return { resource, metadata };
}

export async function registerClient(metadata) {
  if (!metadata.registration_endpoint) {
    throw new CliError('Le serveur d\'autorisation n\'accepte pas l\'enregistrement de clients.', {
      code: 'REGISTRATION_UNSUPPORTED',
    });
  }
  const response = await postJson(metadata.registration_endpoint, {
    client_name: CLIENT_NAME,
    // Any loopback port matches this registration (RFC 8252 section 7.3).
    redirect_uris: [`http://127.0.0.1${CALLBACK_PATH}`],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
  });
  if (response.status !== 201 && response.status !== 200) {
    throw oauthFailure('L\'inscription du client', response);
  }
  if (!response.body?.client_id) {
    throw new CliError('Réponse d\'inscription invalide (client_id absent).', {
      code: 'REGISTRATION_FAILED',
    });
  }
  return {
    client_id: response.body.client_id,
    registration_endpoint: metadata.registration_endpoint,
    registered_at: new Date().toISOString(),
  };
}

function page(response, status, title, body) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(
    `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body></html>`,
  );
}

/**
 * Listen on 127.0.0.1 with a random port for exactly one authorization
 * response carrying the expected state.
 * @returns {Promise<{redirectUri: string, port: number, result: Promise<{code: string}>, close: () => void}>}
 */
export function startLoopbackServer({ state, timeoutMs = LOGIN_TIMEOUT_MS }) {
  return new Promise((resolveStart, rejectStart) => {
    let done = false;
    let timer;
    let resolveResult;
    let rejectResult;
    const result = new Promise((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Avoid an unhandled rejection when the caller stops before awaiting.
    result.catch(() => {});

    const server = http.createServer((request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { connection: 'close' });
        response.end();
        return;
      }
      if (done) {
        page(response, 410, 'Lien déjà utilisé', 'Cette connexion est déjà terminée. Revenez au terminal.');
        return;
      }
      if (!sameSecret(url.searchParams.get('state'), state)) {
        // Not ours: refuse it and keep waiting for the genuine response.
        page(response, 400, 'Requête refusée', 'Le paramètre « state » ne correspond pas à cette connexion.');
        return;
      }
      done = true;
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        page(response, 400, 'Connexion refusée', 'Vous pouvez fermer cet onglet et revenir au terminal.');
        finish(() =>
          rejectResult(
            authError(
              error === 'access_denied'
                ? 'Connexion refusée dans Zenextia.'
                : `Connexion échouée : ${url.searchParams.get('error_description') || error || 'code absent'}.`,
              { code: `OAUTH_${String(error || 'NO_CODE').toUpperCase()}` },
            ),
          ),
        );
        return;
      }
      page(response, 200, 'Connexion réussie', 'Vous pouvez fermer cet onglet et revenir au terminal.');
      finish(() => resolveResult({ code }));
    });

    function finish(settle) {
      clearTimeout(timer);
      settle();
      server.close();
    }

    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        finish(() =>
          rejectResult(
            authError('Délai de connexion dépassé : aucune réponse du navigateur.', {
              code: 'LOGIN_TIMEOUT',
              hint: 'Relancez « zenextia login ».',
            }),
          ),
        );
      }, timeoutMs);
      resolveStart({
        port,
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        result,
        close() {
          if (done) return;
          done = true;
          clearTimeout(timer);
          server.close();
          rejectResult(authError('Connexion interrompue.', { code: 'LOGIN_ABORTED' }));
        },
      });
    });
  });
}

export function buildAuthorizationUrl(metadata, { clientId, redirectUri, challenge, state, resource }) {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('resource', resource);
  return url.toString();
}

function tokenRecord(body, { resource, tokenEndpoint, clientId, previousRefresh, now }) {
  if (!body?.access_token) {
    throw new CliError('Réponse de jeton invalide (access_token absent).', {
      exitCode: EXIT.AUTH,
      code: 'OAUTH_INVALID_RESPONSE',
    });
  }
  const expiresIn = Number(body.expires_in);
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token || previousRefresh || null,
    token_type: body.token_type || 'Bearer',
    scope: body.scope || SCOPE,
    resource: body.resource || resource,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    token_endpoint: tokenEndpoint,
    client_id: clientId,
    obtained_at: new Date(now).toISOString(),
    // Optional identity the backend may add later; shown when present.
    ...(body.workspace ? { workspace: body.workspace } : {}),
    ...(body.member ? { member: body.member } : {}),
  };
}

/**
 * Full interactive login. `openBrowser(url)` is injected; the URL is always
 * reported through `onUrl` as well, for terminals without a browser.
 */
export async function login({ origin, store, openBrowser, onUrl, timeoutMs, now = Date.now }) {
  const { resource, metadata } = await discover(origin);

  let client = store.api(origin).client;
  if (!client || client.registration_endpoint !== metadata.registration_endpoint) {
    client = await registerClient(metadata);
    store.saveClient(origin, client);
  }

  const pkce = createPkce();
  const state = createState();
  const loopback = await startLoopbackServer({ state, timeoutMs });
  const authorizationUrl = buildAuthorizationUrl(metadata, {
    clientId: client.client_id,
    redirectUri: loopback.redirectUri,
    challenge: pkce.challenge,
    state,
    resource,
  });
  onUrl?.(authorizationUrl);
  try {
    await openBrowser?.(authorizationUrl);
  } catch {
    // The printed URL remains the fallback.
  }

  let code;
  try {
    ({ code } = await loopback.result);
  } catch (error) {
    // An unknown client is only reported in the browser: register afresh
    // next time rather than waiting on a dead registration again.
    if (error.code === 'LOGIN_TIMEOUT') store.forgetClient(origin);
    throw error;
  }

  const response = await postForm(metadata.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: loopback.redirectUri,
    client_id: client.client_id,
    code_verifier: pkce.verifier,
    resource,
  });
  if (response.status !== 200) {
    if (response.body?.error === 'invalid_client') store.forgetClient(origin);
    throw oauthFailure('La connexion', response);
  }
  const tokens = tokenRecord(response.body, {
    resource,
    tokenEndpoint: metadata.token_endpoint,
    clientId: client.client_id,
    now: now(),
  });
  store.saveTokens(origin, tokens);
  return tokens;
}

function notLoggedIn(origin) {
  return authError(`Vous n'êtes pas connecté à ${origin}.`, {
    hint: `Lancez « zenextia login${origin === 'https://api.zenextia.com' ? '' : ` --api ${origin}`} ».`,
  });
}

/** Exchange the refresh token; rotation means the new one must be stored at once. */
export async function refreshTokens({ origin, store, now = Date.now }) {
  const tokens = store.api(origin).tokens;
  if (!tokens) throw notLoggedIn(origin);
  if (!tokens.refresh_token) {
    store.clearTokens(origin);
    throw authError('Votre session Zenextia a expiré.', {
      code: 'SESSION_EXPIRED',
      hint: notLoggedIn(origin).hint,
    });
  }
  const response = await postForm(tokens.token_endpoint, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: tokens.client_id,
    resource: tokens.resource,
  });
  if (response.status !== 200) {
    if (response.status >= 500 || !response.body?.error) {
      throw new CliError(`Zenextia ne répond pas correctement (HTTP ${response.status}).`, {
        code: 'TOKEN_REFRESH_UNAVAILABLE',
        hint: 'Réessayez dans quelques instants.',
      });
    }
    store.clearTokens(origin);
    throw authError('Votre session Zenextia a expiré ou a été révoquée.', {
      code: 'SESSION_EXPIRED',
      hint: notLoggedIn(origin).hint,
    });
  }
  const next = tokenRecord(response.body, {
    resource: tokens.resource,
    tokenEndpoint: tokens.token_endpoint,
    clientId: tokens.client_id,
    previousRefresh: tokens.refresh_token,
    now: now(),
  });
  store.saveTokens(origin, { ...tokens, ...next });
  return next;
}

/** A valid access token for `origin`, refreshed when close to expiry. */
export async function accessToken({ origin, store, forceRefresh = false, now = Date.now }) {
  const tokens = store.api(origin).tokens;
  if (!tokens?.access_token) throw notLoggedIn(origin);
  const fresh = tokens.expires_at === null || tokens.expires_at - EXPIRY_MARGIN_MS > now();
  if (fresh && !forceRefresh) return tokens.access_token;
  return (await refreshTokens({ origin, store, now })).access_token;
}
