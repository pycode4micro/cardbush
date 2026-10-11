import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBufferedModelRound } from '../dist/bufferedModelRetry.js';

const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', messages: [], tools: [] };
const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: 'r', sequence, createdAt: new Date().toISOString(), kind, ...fields });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('idle providers exhaust the shared retry budget and release the caller', async t => {
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  let calls = 0; const retry = [];
  const result = await executeBufferedModelRound({ async *stream() { calls++; await new Promise(() => {}); } }, request,
    { signal: new AbortController().signal, idleTimeoutMs: 15, wait: async () => {}, onRetry: status => retry.push(status) });
  assert.equal(calls, 3); assert.equal(result.error.code, 'provider_timeout');
  assert.deepEqual(retry.map(status => status.attempt), [2, 3]);
});

test('active reasoning refreshes the idle deadline without limiting total generation time', async () => {
  const result = await executeBufferedModelRound({ async *stream() {
    for (let i = 0; i < 6; i++) { await pause(15); yield event(i, 'reasoning_delta', { delta: '.' }); }
    yield event(6, 'text_delta', { delta: 'Done' });
    yield event(7, 'response_completed', { finishReason: 'stop' });
  } }, request, { signal: new AbortController().signal, idleTimeoutMs: 70, onRetry: () => assert.fail('active request retried') });
  assert.equal(result.status, 'completed'); assert.equal(result.text, 'Done');
});

test('user cancellation never becomes an automatic network retry', async () => {
  const controller = new AbortController();
  const pending = executeBufferedModelRound({ async *stream() { await new Promise(() => {}); } }, request,
    { signal: controller.signal, idleTimeoutMs: 1000, onRetry: () => assert.fail('cancel retried') });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
