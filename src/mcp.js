// Minimal MCP Streamable HTTP client: initialize, notifications/initialized,
// tools/list and tools/call. The Zenextia endpoint is stateful (Mcp-Session-Id)
// and answers POSTs as an SSE stream by default; plain JSON is accepted too.

import { CliError, EXIT, authError } from './errors.js';
import { readJsonBody, send, sleep } from './http.js';

export const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RATE_LIMIT_RETRIES = 3;

/** A tool answered with isError: the backend's own error envelope. */
export class ToolError extends CliError {
  constructor({ tool, code, message, details, requestId }) {
    super(`${message || 'Erreur inconnue'} (${code})`, {
      code: code || 'TOOL_ERROR',
      details: { tool, ...(details ? { ...details } : {}), ...(requestId ? { requestId } : {}) },
    });
    this.name = 'ToolError';
    this.tool = tool;
    this.backendMessage = message;
    this.retryable = details?.retryable === true;
  }
}

const HTTP_ERROR_MESSAGES = {
  EXTERNAL_AGENTS_DISABLED:
    'Les agents IA externes sont désactivés pour ce Workspace. Un administrateur peut les activer dans Paramètres > Intégrations.',
  MCP_RATE_LIMITED: 'Trop de requêtes vers Zenextia. Réessayez dans une minute.',
  MCP_RESOURCE_SCOPE_MISMATCH: 'Ce jeton ne donne pas accès à ce point d\'accès Zenextia.',
  MCP_ORIGIN_REJECTED: 'Requête refusée par Zenextia (origine non autorisée).',
};

/** Parse SSE events incrementally from a fetch body. */
async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  const tail = parseEvent(buffer + decoder.decode());
  if (tail) yield tail;
}

function parseEvent(raw) {
  let type = 'message';
  const data = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') type = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { type, data: data.join('\n') } : null;
}

export { parseEvent as parseSseEvent };

/** Structured result of a tool: structuredContent, else the JSON in the text block. */
export function toolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  for (const block of result?.content || []) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    const candidates = [block.text, block.text.slice(block.text.lastIndexOf('\n\n') + 2)];
    for (const candidate of candidates) {
      try {
        const value = JSON.parse(candidate);
        if (value && typeof value === 'object') return value;
      } catch {
        // Not JSON: try the next form.
      }
    }
  }
  return {};
}

export class McpClient {
  /**
   * @param {{url: string, token: (force: boolean) => Promise<string>, clientVersion?: string}} options
   */
  constructor({ url, token, clientVersion = '0.0.0' }) {
    this.url = url;
    this.token = token;
    this.clientVersion = clientVersion;
    this.sessionId = null;
    this.protocolVersion = null;
    this.nextId = 1;
    this.serverInfo = null;
  }

  async connect() {
    this.sessionId = null;
    this.protocolVersion = null;
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'zenextia-cli', version: this.clientVersion },
    });
    this.protocolVersion = result?.protocolVersion || PROTOCOL_VERSION;
    this.serverInfo = result?.serverInfo || null;
    await this.notify('notifications/initialized');
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    do {
      const page = await this.request('tools/list', cursor ? { cursor } : {});
      tools.push(...(page?.tools || []));
      cursor = page?.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Call a tool and return its structured payload, or throw a ToolError. */
  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const payload = toolPayload(result);
    if (result?.isError) {
      const error = payload.error || {};
      const text = (result.content || []).find((block) => block?.type === 'text')?.text;
      throw new ToolError({
        tool: name,
        code: error.code || 'TOOL_ERROR',
        message: error.message || text,
        details: error.details,
        requestId: error.requestId,
      });
    }
    return payload;
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await send(this.url, {
        method: 'DELETE',
        headers: { ...(await this.#headers(false)), 'mcp-session-id': sessionId },
        timeoutMs: 5_000,
      });
    } catch {
      // The server forgets idle sessions on its own.
    }
  }

  async notify(method, params) {
    await this.#post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, null);
  }

  async request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    return this.#post({ jsonrpc: '2.0', id, method, params: params ?? {} }, id);
  }

  async #headers(forceRefresh) {
    const headers = {
      authorization: `Bearer ${await this.token(forceRefresh)}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    return headers;
  }

  async #post(message, id) {
    let refreshed = false;
    let forceRefresh = false;
    let rateLimited = 0;
    let reconnected = false;
    for (;;) {
      const headers = await this.#headers(forceRefresh);
      forceRefresh = false;
      const response = await send(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      if (response.status === 401) {
        await response.body?.cancel();
        if (!refreshed) {
          refreshed = true;
          forceRefresh = true;
          continue;
        }
        throw authError('Zenextia refuse votre session.', {
          code: 'SESSION_REJECTED',
          hint: 'Relancez « zenextia login ».',
        });
      }
      if (response.status === 429 && rateLimited < MAX_RATE_LIMIT_RETRIES) {
        await response.body?.cancel();
        rateLimited += 1;
        const seconds = Number(response.headers.get('retry-after')) || 10;
        await sleep(Math.min(seconds, 60) * 1000);
        continue;
      }
      // An expired MCP session: start a new one once, then replay.
      if (
        response.status === 404 &&
        this.sessionId &&
        message.method !== 'initialize' &&
        !reconnected
      ) {
        await response.body?.cancel();
        reconnected = true;
        await this.connect();
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw await httpError(response);
      }

      if (message.method === 'initialize') {
        const sessionId = response.headers.get('mcp-session-id');
        if (sessionId) this.sessionId = sessionId;
      }
      if (id === null) {
        await response.body?.cancel();
        return null;
      }
      return this.#readResponse(response, id);
    }
  }

  async #readResponse(response, id) {
    const type = (response.headers.get('content-type') || '').toLowerCase();
    let found;
    if (type.includes('text/event-stream')) {
      for await (const event of sseEvents(response.body)) {
        if (event.type !== 'message') continue;
        let parsed;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          continue;
        }
        const match = [parsed].flat().find((item) => item?.id === id && ('result' in item || 'error' in item));
        if (match) {
          found = match;
          break;
        }
      }
      // Stop reading: the stream may stay open for server notifications.
      response.body?.cancel().catch(() => {});
    } else {
      const parsed = await readJsonBody(response);
      found = [parsed].flat().find((item) => item?.id === id);
    }
    if (!found) {
      throw new CliError('Réponse MCP inattendue de Zenextia.', { code: 'MCP_PROTOCOL_ERROR' });
    }
    if (found.error) {
      throw new CliError(`Erreur MCP : ${found.error.message || 'inconnue'} (${found.error.code}).`, {
        code: 'MCP_ERROR',
        details: { rpcCode: found.error.code },
      });
    }
    return found.result;
  }
}

async function httpError(response) {
  const body = await readJsonBody(response);
  const code = body?.error?.code || `HTTP_${response.status}`;
  const message = HTTP_ERROR_MESSAGES[code] || body?.error?.message || `Erreur HTTP ${response.status}.`;
  return new CliError(message, {
    exitCode: response.status === 403 && code === 'MCP_RESOURCE_SCOPE_MISMATCH' ? EXIT.AUTH : EXIT.FAILED,
    code,
    details: body?.error?.requestId ? { requestId: body.error.requestId } : undefined,
  });
}
