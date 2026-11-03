// In-process stand-in for the Zenextia API: the MCP OAuth facade, the
// stateful Streamable HTTP endpoint (SSE by default, like the backend's
// json_response=False) and the presigned quarantine PUT target.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { inflateRawSync } from 'node:zlib';

import { listZipEntries } from '../src/zip.js';

const ALL_TOOLS = ['factory_deploy_prepare', 'factory_deploy_complete', 'factory_status'];

const DEFAULT_STATUSES = [
  { build: { status: 'queued', error: null }, verification: { status: 'pending', error: null } },
  { build: { status: 'running', error: null }, verification: { status: 'pending', error: null } },
  { build: { status: 'succeeded', error: null }, verification: { status: 'running', error: null } },
  {
    build: { status: 'succeeded', error: null },
    verification: { status: 'passed', error: null },
    review: { status: 'pending' },
    previewUrl: 'https://app-dev.zenextia.com/applications/preview/TEST',
    publishable: false,
    nextStep: 'TEST Ouvrez l’aperçu puis demandez la revue.',
  },
];

function id(prefix) {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function toolResult(structured, { structuredContent = true } = {}) {
  return {
    content: [{ type: 'text', text: `TEST summary\n\n${JSON.stringify(structured)}` }],
    ...(structuredContent ? { structuredContent: structured } : {}),
    isError: false,
  };
}

function toolError(code, message, details) {
  const payload = { error: { code, message, requestId: 'req_TEST', ...(details ? { details } : {}) } };
  return {
    content: [{ type: 'text', text: `${message} (${code})` }],
    structuredContent: payload,
    isError: true,
  };
}

function zipFiles(buffer) {
  const files = {};
  for (const entry of listZipEntries(buffer)) {
    const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    const raw = buffer.subarray(start, start + entry.compressedSize);
    files[entry.name] = entry.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
  }
  return files;
}

export async function startFakeBackend(options = {}) {
  const state = {
    sse: options.sse ?? true,
    structuredContent: options.structuredContent ?? true,
    accessTtl: options.accessTtl ?? 3600,
    deny: options.deny ?? false,
    tools: options.tools ?? ALL_TOOLS,
    completeFailures: options.completeFailures ?? 1,
    statuses: options.statuses ?? DEFAULT_STATUSES,
    clients: new Map(),
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    sessions: new Map(),
    prepared: new Map(),
    uploads: new Map(),
    completeCalls: 0,
    statusCalls: 0,
    refreshCalls: 0,
    unauthorized: 0,
    log: [],
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, base);
    state.log.push(`${request.method} ${url.pathname}`);
    try {
      await route(request, response, url);
    } catch (error) {
      sendJson(response, 500, { error: { code: 'TEST_SERVER_ERROR', message: error.message } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resource = `${base}/mcp`;

  async function route(request, response, url) {
    const path = url.pathname;
    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/mcp') {
      return sendJson(response, 200, {
        resource,
        authorization_servers: [base],
        scopes_supported: ['mcp:tools'],
        resource_name: 'Zenextia',
        bearer_methods_supported: ['header'],
      });
    }
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return sendJson(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/mcp/oauth/authorize`,
        token_endpoint: `${base}/mcp/oauth/token`,
        registration_endpoint: `${base}/mcp/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:tools'],
      });
    }
    if (request.method === 'POST' && path === '/mcp/oauth/register') return register(request, response);
    if (request.method === 'GET' && path === '/mcp/oauth/authorize') return authorize(response, url);
    if (request.method === 'POST' && path === '/mcp/oauth/token') return token(request, response);
    if (path === '/mcp') return mcp(request, response);
    if (request.method === 'PUT' && path.startsWith('/upload/')) return upload(request, response, path.slice(8));
    return sendJson(response, 404, { error: 'not_found' });
  }

  async function register(request, response) {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    const uris = body.redirect_uris || [];
    if (!uris.length || !uris.every((uri) => new URL(uri).hostname === '127.0.0.1')) {
      return sendJson(response, 400, { error: 'invalid_redirect_uri' });
    }
    if (body.token_endpoint_auth_method !== 'none') {
      return sendJson(response, 400, { error: 'invalid_client_metadata' });
    }
    const clientId = id('mcp_client');
    state.clients.set(clientId, { redirectUris: uris, name: body.client_name });
    return sendJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: body.grant_types,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  }

  function authorize(response, url) {
    const q = Object.fromEntries(url.searchParams);
    const client = state.clients.get(q.client_id);
    const redirect = new URL(q.redirect_uri);
    const registered = client?.redirectUris.some((uri) => {
      const known = new URL(uri);
      return known.hostname === redirect.hostname && known.pathname === redirect.pathname;
    });
    if (
      !client ||
      !registered ||
      q.response_type !== 'code' ||
      q.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(q.code_challenge || '') ||
      q.resource !== resource ||
      q.scope !== 'mcp:tools' ||
      !q.state
    ) {
      return sendJson(response, 400, { error: 'invalid_request' });
    }
    if (state.deny) {
      redirect.searchParams.set('error', 'access_denied');
    } else {
      const code = id('mcp_code');
      state.codes.set(code, {
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        challenge: q.code_challenge,
        resource: q.resource,
      });
      redirect.searchParams.set('code', code);
    }
    redirect.searchParams.set('state', q.state);
    response.writeHead(303, { location: redirect.toString() });
    response.end();
  }

  function issue(clientId) {
    const access = id('zxm_TEST');
    const refresh = id('mcp_refresh');
    state.access.set(access, { expiresAt: Date.now() + state.accessTtl * 1000 });
    state.refresh.set(refresh, { clientId });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: state.accessTtl,
      scope: 'mcp:tools',
      resource,
      refresh_token: refresh,
    };
  }

  async function token(request, response) {
    const form = Object.fromEntries(new URLSearchParams((await readBody(request)).toString('utf8')));
    if (!state.clients.has(form.client_id)) return sendJson(response, 401, { error: 'invalid_client' });
    if (form.resource && form.resource !== resource) return sendJson(response, 400, { error: 'invalid_target' });
    if (form.grant_type === 'authorization_code') {
      const record = state.codes.get(form.code);
      state.codes.delete(form.code);
      const challenge = sha256(form.code_verifier || '').toString('base64url');
      if (
        !record ||
        record.clientId !== form.client_id ||
        record.redirectUri !== form.redirect_uri ||
        record.challenge !== challenge
      ) {
        return sendJson(response, 400, { error: 'invalid_grant', error_description: 'TEST bad code' });
      }
      return sendJson(response, 200, issue(form.client_id), { 'cache-control': 'no-store' });
    }
    if (form.grant_type === 'refresh_token') {
      state.refreshCalls += 1;
      const record = state.refresh.get(form.refresh_token);
      if (!record || record.clientId !== form.client_id) {
        return sendJson(response, 400, { error: 'invalid_grant', error_description: 'Refresh token is invalid, expired, or revoked.' });
      }
      state.refresh.delete(form.refresh_token); // rotation
      return sendJson(response, 200, issue(form.client_id), { 'cache-control': 'no-store' });
    }
    return sendJson(response, 400, { error: 'unsupported_grant_type' });
  }

  function respondRpc(response, message, headers = {}) {
    if (!state.sse) return sendJson(response, 200, message, headers);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
    // A server notification first: the client must skip it.
    response.write(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'TEST' } })}\n\n`);
    // Spread the payload over several data lines (joined with "\n" by the
    // client) and two network writes, with CRLF line endings.
    const lines = JSON.stringify(message, null, 1).split('\n');
    const half = Math.ceil(lines.length / 2);
    response.write('event: message\r\nid: 1\r\n');
    response.write(lines.slice(0, half).map((line) => `data: ${line}\r\n`).join(''));
    setTimeout(() => {
      response.end(`${lines.slice(half).map((line) => `data:${line}\r\n`).join('')}\r\n`);
    }, 5);
  }

  async function mcp(request, response) {
    const authorization = request.headers.authorization || '';
    const tokenValue = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const access = state.access.get(tokenValue);
    if (!access || access.expiresAt < Date.now()) {
      state.unauthorized += 1;
      return sendJson(
        response,
        401,
        { error: { code: 'MCP_CONNECTION_INVALID', message: 'TEST invalid' } },
        { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"` },
      );
    }
    if (request.method === 'DELETE') {
      state.sessions.delete(request.headers['mcp-session-id']);
      response.writeHead(200);
      return response.end();
    }
    if (request.method !== 'POST') return sendJson(response, 405, {});
    if (!String(request.headers.accept).includes('text/event-stream')) {
      return sendJson(response, 406, { error: 'accept must include text/event-stream' });
    }
    const message = JSON.parse((await readBody(request)).toString('utf8'));
    if (message.method === 'initialize') {
      const sessionId = randomBytes(16).toString('hex');
      state.sessions.set(sessionId, { initialized: false });
      return respondRpc(
        response,
        {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'zenextia', version: '2.0.0' },
          },
        },
        { 'mcp-session-id': sessionId },
      );
    }
    const session = state.sessions.get(request.headers['mcp-session-id']);
    if (!session) return sendJson(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' } });
    if (request.headers['mcp-protocol-version'] !== '2025-06-18') {
      return sendJson(response, 400, { error: 'missing protocol version header' });
    }
    if (message.method === 'notifications/initialized') {
      session.initialized = true;
      response.writeHead(202);
      return response.end();
    }
    if (!session.initialized) return sendJson(response, 400, { error: 'not initialized' });
    if (message.method === 'tools/list') {
      return respondRpc(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: state.tools.map((name) => ({ name, inputSchema: { type: 'object' } })) },
      });
    }
    if (message.method === 'tools/call') {
      const result = callTool(message.params.name, message.params.arguments || {});
      return respondRpc(response, { jsonrpc: '2.0', id: message.id, result });
    }
    return respondRpc(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }

  function callTool(name, args) {
    if (!state.tools.includes(name)) return toolError('MCP_TOOL_NOT_FOUND', 'TEST unknown tool');
    const opts = { structuredContent: state.structuredContent };
    if (name === 'factory_deploy_prepare') {
      if (!args.manifest?.id || !/^[0-9a-f]{64}$/.test(args.sourceSha256) || !(args.sourceBytes > 0)) {
        return toolError('AI_FACTORY_INVALID_INPUT', 'TEST invalid input');
      }
      const prepared = {
        installationId: 'inst_TEST',
        versionId: id('ver'),
        uploadId: id('upl'),
        manifest: args.manifest,
        sha256: args.sourceSha256,
        bytes: args.sourceBytes,
      };
      state.prepared.set(prepared.uploadId, prepared);
      return toolResult(
        {
          installationId: prepared.installationId,
          versionId: prepared.versionId,
          uploadId: prepared.uploadId,
          target: {
            url: `${base}/upload/${prepared.uploadId}`,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/zip',
              'x-amz-checksum-sha256': Buffer.from(args.sourceSha256, 'hex').toString('base64'),
              'If-None-Match': '*',
            },
          },
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        },
        opts,
      );
    }
    if (name === 'factory_deploy_complete') {
      state.completeCalls += 1;
      if (state.completeCalls <= state.completeFailures) {
        return toolError('AI_FACTORY_UPLOAD_NOT_RECEIVED', 'TEST not yet visible', { retryable: true });
      }
      const prepared = state.prepared.get(args.uploadId);
      const body = state.uploads.get(args.uploadId);
      if (!prepared || !body) return toolError('AI_FACTORY_UPLOAD_NOT_RECEIVED', 'TEST missing', { retryable: true });
      if (body.length !== prepared.bytes || sha256(body).toString('hex') !== prepared.sha256) {
        return toolError('AI_FACTORY_UPLOAD_MISMATCH', 'TEST mismatch');
      }
      const files = zipFiles(body);
      for (const required of ['zenextia.app.json', 'package.json', 'package-lock.json']) {
        if (!files[required]) return toolError('AI_FACTORY_SOURCE_INVALID', `TEST missing ${required}`);
      }
      if (JSON.stringify(JSON.parse(files['zenextia.app.json'])) !== JSON.stringify(prepared.manifest)) {
        return toolError('AI_FACTORY_SOURCE_INVALID', 'TEST manifest differs');
      }
      prepared.files = Object.keys(files);
      return toolResult({ buildId: id('bld'), status: 'queued' }, opts);
    }
    if (name === 'factory_status') {
      const index = Math.min(state.statusCalls, state.statuses.length - 1);
      state.statusCalls += 1;
      return toolResult(
        {
          installationId: args.installationId,
          versionId: args.versionId || 'ver_latest',
          version: '0.1.0',
          review: { status: 'pending' },
          previewUrl: null,
          publishable: false,
          nextStep: 'TEST Patientez.',
          ...state.statuses[index],
        },
        opts,
      );
    }
    return toolError('MCP_TOOL_NOT_FOUND', 'TEST unknown tool');
  }

  async function upload(request, response, uploadId) {
    const prepared = state.prepared.get(uploadId);
    if (!prepared) return sendJson(response, 403, {});
    if (
      request.headers['content-type'] !== 'application/zip' ||
      request.headers['if-none-match'] !== '*' ||
      request.headers['x-amz-checksum-sha256'] !== Buffer.from(prepared.sha256, 'hex').toString('base64')
    ) {
      return sendJson(response, 403, { error: 'SignatureDoesNotMatch' });
    }
    if (state.uploads.has(uploadId)) return sendJson(response, 412, {});
    state.uploads.set(uploadId, await readBody(request));
    response.writeHead(200);
    response.end();
  }

  return {
    base,
    resource,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}
