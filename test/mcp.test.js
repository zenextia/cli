import { test } from 'node:test';
import assert from 'node:assert/strict';

import { phaseOf } from '../src/deploy.js';
import { parseSseEvent, toolPayload } from '../src/mcp.js';

test('SSE events: multi-line data, comments, CRLF and event types', () => {
  assert.deepEqual(parseSseEvent('event: message\r\ndata: {"a":\r\ndata:1}'), {
    type: 'message',
    data: '{"a":\n1}',
  });
  assert.equal(parseSseEvent(': keep-alive'), null);
  assert.deepEqual(parseSseEvent('data: x'), { type: 'message', data: 'x' });
  assert.equal(parseSseEvent('event: ping\ndata: 1').type, 'ping');
});

test('tool payload: structuredContent first, then the JSON in the text block', () => {
  assert.deepEqual(toolPayload({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
  assert.deepEqual(
    toolPayload({ content: [{ type: 'text', text: 'Summary line.\n\n{"uploadId":"u1"}' }] }),
    { uploadId: 'u1' },
  );
  assert.deepEqual(toolPayload({ content: [{ type: 'text', text: '{"b":2}' }] }), { b: 2 });
  assert.deepEqual(toolPayload({ content: [{ type: 'text', text: 'no json' }] }), {});
});

test('deployment phases', () => {
  assert.equal(phaseOf({ build: { status: 'queued' } }), 'in_progress');
  assert.equal(phaseOf({ build: { status: 'running' } }), 'in_progress');
  assert.equal(phaseOf({ build: { status: 'failed', error: { code: 'X' } } }), 'failed');
  assert.equal(phaseOf({ build: { status: 'succeeded' }, verification: { status: 'pending' } }), 'in_progress');
  assert.equal(phaseOf({ build: { status: 'succeeded' }, verification: { status: null } }), 'in_progress');
  assert.equal(
    phaseOf({ build: { status: 'succeeded' }, verification: { status: 'rejected', error: { code: 'V' } } }),
    'failed',
  );
  assert.equal(phaseOf({ build: { status: 'succeeded' }, verification: { status: 'passed' } }), 'ready');
  assert.equal(
    phaseOf({ build: { status: 'succeeded' }, verification: { status: 'running' }, previewUrl: 'https://x' }),
    'ready',
  );
});
