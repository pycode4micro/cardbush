import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { UsageLedger } from '../dist-electron/usageLedger.js';
import { usageRecordingProvider } from '../dist-electron/usageRecordingProvider.mjs';

function fixture(t) {
  const prefix = join(tmpdir(), 'cardbush-usage-test-');
  const root = mkdtempSync(prefix), path = join(root, 'usage', 'ledger.sqlite');
  const ledger = new UsageLedger(path);
  t.after(() => { ledger.close(); assert.ok(resolve(root).startsWith(prefix)); rmSync(root, { recursive: true, force: true }); });
  return { root, path, ledger };
}
const request = { requestId: 'reused-request', sessionId: 'main-session', model: 'test-model' };
const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, createdAt: new Date().toISOString(), kind, ...fields });
async function drain(provider, input = request) { for await (const unused of provider.stream(input)) void unused; }

test('durable reported usage survives runtime/history deletion and fresh readers', t => {
  const { root, path, ledger } = fixture(t);
  const record = { id: 'attempt-1', sessionId: 'main', model: 'test', recordedAt: '2026-09-10T12:00:00Z', inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 };
  ledger.record(record);
  ledger.record(record);
  ledger.record({ ...record, inputTokens: undefined, cachedInputTokens: undefined, outputTokens: 30 });
  assert.equal(ledger.snapshot().totalTokens, 130, 'duplicate/corrected usage replaces one request');
  assert.equal(ledger.snapshot().requestCount, 1);
  const cache = join(root, 'runtime-state'); mkdirSync(cache); writeFileSync(join(cache, 'history.json'), '{}');
  assert.ok(resolve(cache).startsWith(resolve(root) + sep)); rmSync(cache, { recursive: true });
  const reader = new UsageLedger(path);
  try {
    assert.equal(reader.snapshot().totalTokens, 130);
    assert.equal(reader.snapshot().promptCacheMissTokens, 40);
    ledger.record({ ...record, id: 'child-attempt', sessionId: 'child', recordedAt: '2026-09-11T12:00:00Z', inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
    const updated = reader.snapshot();
    assert.equal(updated.totalTokens, 145);
    assert.equal(updated.conversationCount, 2);
    assert.equal(updated.longestStreak, 2);
    assert.equal(updated.activity.reduce((sum, day) => sum + day.tokens, 0), updated.totalTokens);
  } finally { reader.close(); }
});

test('provider observer counts each actual attempt, including child calls and usage before failure', async t => {
  const { ledger } = fixture(t);
  const provider = usageRecordingProvider({ async *stream() {
    yield event(0, 'usage', { inputTokens: 100, outputTokens: 10 });
    yield event(1, 'usage', { inputTokens: 100, outputTokens: 20 });
    yield event(2, 'usage', { inputTokens: 100, outputTokens: 20 });
    throw Error('connection interrupted after reported usage');
  } }, usage => ledger.record(usage));
  await assert.rejects(drain(provider), /interrupted/);
  await assert.rejects(drain(provider), /interrupted/);
  await assert.rejects(drain(provider, { ...request, sessionId: 'child-session' }), /interrupted/);
  const result = ledger.snapshot();
  assert.equal(result.totalTokens, 360);
  assert.equal(result.requestCount, 3, 'retrying the same request id is real additional use');
  assert.equal(result.conversationCount, 2);
});

test('no accounting guesses from estimates, missing usage, invalid or mismatched events', async t => {
  const { ledger } = fixture(t);
  const provider = usageRecordingProvider({
    estimateInputTokens: async () => 5000,
    countInputTokens: async () => ({ inputTokens: 4999, source: 'provider' }),
    async *stream() {
      yield event(0, 'usage', { inputTokens: 200, requestId: 'unrelated' });
      yield event(1, 'usage', { inputTokens: -1 });
      yield event(2, 'response_completed');
    },
  }, usage => ledger.record(usage));
  assert.equal(await provider.estimateInputTokens(request), 5000);
  assert.equal((await provider.countInputTokens(request)).inputTokens, 4999);
  await drain(provider);
  assert.equal(ledger.snapshot().totalTokens, 0);
  assert.equal(ledger.snapshot().requestCount, 0);
});

test('reported output-only usage persists before a consumer cancels the stream', async t => {
  const { ledger } = fixture(t);
  const provider = usageRecordingProvider({ async *stream() { yield event(0, 'usage', { outputTokens: 42 }); } }, usage => ledger.record(usage));
  for await (const unused of provider.stream(request)) { void unused; break; }
  assert.equal(ledger.snapshot().totalTokens, 42);
  assert.equal(ledger.snapshot().promptTokens, 0);
});
