import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeHost, InMemoryRuntimeEventLog, InMemoryRuntimeCheckpointStore, SessionStore, ToolRegistry } from '../dist/index.js';

const request = (id = 'task') => ({ protocol: 'bush.model_request.v1', requestId: id, sessionId: `internal-${id}`, turnId: id,
  model: 'fixture', reasoningEffort: 'xhigh', maxOutputTokens: 128000, metadata: { contextWindowTokens: 400000 },
  tools: [], messages: [{ role: 'developer', content: 'Return the structured result.' }, { role: 'user', content: 'source snapshot' }], permissionMode: 'task_free' });
const event = (r, sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: r.requestId,
  sequence, createdAt: new Date().toISOString(), kind, ...extra });
async function fixture(t, provider, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-internal-task-'));
  const sessions = new SessionStore(), events = new InMemoryRuntimeEventLog(), checkpoints = new InMemoryRuntimeCheckpointStore();
  sessions.ensureSession('visible-conversation');
  const host = new InMemoryRuntimeHost({ dataRoot: root, registerDefaultWorkspaceTools: false, provider,
    sessionStore: sessions, eventLog: events, checkpointStore: checkpoints, ...options });
  t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { host, sessions, events, checkpoints, root };
}

test('internal work uses Runtime lifecycle and commits before completion without a recent Session or hooks', async t => {
  const validating = Promise.withResolvers(), release = Promise.withResolvers(), input = request(), progress = [];
  let loads = 0, commits = 0;
  const f = await fixture(t, { async *stream(r) {
    assert.equal(r.reasoningEffort, 'xhigh'); assert.equal(r.maxOutputTokens, 128000);
    assert.deepEqual(r.tools, []); assert.deepEqual(r.messages, input.messages);
    yield event(r, 0, 'reasoning_delta', { delta: 'reasoning' });
    yield event(r, 1, 'text_delta', { delta: '{"ok":true}' });
    yield event(r, 2, 'usage', { inputTokens: 42, outputTokens: 18 });
    yield event(r, 3, 'response_completed', { finishReason: 'stop' });
  } }, { loadPluginExtensions: async () => { loads++; throw Error('Internal tasks must not load conversation plugins.'); } });
  const operation = f.host.runInternalTask(input, { onProgress: p => progress.push(p), acceptResult: async text => {
    assert.deepEqual(JSON.parse(text), { ok: true }); validating.resolve(); await release.promise; commits++;
  } });
  await validating.promise;
  const running = f.host.events(input.sessionId, input.turnId);
  assert.ok(running.some(e => e.kind === 'turn_started'));
  assert.ok(running.some(e => e.kind === 'model_request_usage'));
  assert.ok(!running.some(e => e.kind === 'turn_terminal'));
  assert.equal(progress.at(-1).phase, 'validating');
  assert.equal(f.checkpoints.list().length, 1, 'normal Runtime checkpointing is used');
  release.resolve(); const outcome = await operation;
  assert.equal(outcome.terminal.payload.status, 'completed'); assert.equal(commits, 1); assert.equal(loads, 0);
  assert.equal(outcome.usage.outputTokens, 18); assert.equal(f.checkpoints.list().length, 0);
  assert.equal(f.sessions.list().length, 1); assert.equal(f.sessions.hasSession(input.sessionId), false);
  assert.equal(f.host.events(input.sessionId, input.turnId).filter(e => e.kind === 'turn_terminal').length, 1);
});

test('internal tasks inherit Runtime retry/backoff and never commit rejected attempts', async t => {
  let calls = 0, commits = 0; const delays = [], phases = [], input = request('retry');
  const f = await fixture(t, { async *stream(r) {
    calls++;
    if (calls < 3) {
      yield event(r, 0, 'text_delta', { delta: 'discarded partial JSON' });
      yield event(r, 1, 'response_failed', { code: 'server_error', status: 503, message: 'Busy', retryable: true });
    } else {
      yield event(r, 0, 'text_delta', { delta: '{"done":true}' });
      yield event(r, 1, 'response_completed', { finishReason: 'stop' });
    }
  } }, { maxAttempts: 3, retryDelayMs: () => 7, wait: async delay => { delays.push(delay); } });
  const result = await f.host.runInternalTask(input, { onProgress: p => phases.push(p.phase), acceptResult: async text => {
    assert.deepEqual(JSON.parse(text), { done: true }); commits++;
  } });
  assert.equal(result.terminal.payload.status, 'completed'); assert.equal(calls, 3); assert.equal(commits, 1);
  assert.deepEqual(delays, [7, 7]); assert.ok(phases.includes('retrying'));
  const events = f.host.events(input.sessionId, input.turnId);
  assert.equal(events.filter(e => e.kind === 'provider_retry').length, 2);
  assert.equal(events.filter(e => e.kind === 'replay_reset').length, 2);
});

test('domain validation failure is a failed Runtime task, retains its error, and is not a provider retry', async t => {
  let calls = 0; const invalid = new Error('Source revision changed'), input = request('validation');
  const f = await fixture(t, { async *stream(r) {
    calls++; yield event(r, 0, 'text_delta', { delta: '{"ok":true}' });
    yield event(r, 1, 'response_completed', { finishReason: 'stop' });
  } }, { maxAttempts: 3 });
  await assert.rejects(f.host.runInternalTask(input, { acceptResult: async () => { throw invalid; } }), error => error === invalid);
  assert.equal(calls, 1); const events = f.host.events(input.sessionId, input.turnId);
  assert.equal(events.at(-1).payload.status, 'failed'); assert.equal(events.at(-1).payload.reason, 'task_result_rejected');
  assert.ok(!events.some(e => e.kind === 'provider_retry')); assert.equal(f.checkpoints.list().length, 0);
});

test('the assembled empty tool set is enforced before any tool executes', async t => {
  let effects = 0, commits = 0; const registry = new ToolRegistry(), input = request('tools');
  registry.register({ definition: { name: 'fixture_write', description: 'Test effect', inputSchema: { type: 'object', properties: {} } },
    manifest: { effect_kind: 'observation', operation: 'fixture.count', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    execute: async () => { effects++; return {}; } });
  const f = await fixture(t, { async *stream(r) {
    yield event(r, 0, 'tool_call_delta', { index: 0, toolCallId: 'unexpected', nameDelta: 'fixture_write', argumentsDelta: '{}' });
    yield event(r, 1, 'response_completed', { finishReason: 'tool_calls' });
  } }, { toolRegistry: registry });
  const result = await f.host.runInternalTask(input, { acceptResult: async () => { commits++; } });
  assert.equal(result.terminal.payload.reason, 'tools_disabled'); assert.equal(effects, 0); assert.equal(commits, 0);
  assert.ok(!f.host.events(input.sessionId, input.turnId).some(e => e.kind === 'tool_running'));
});

test('ordinary and internal model work use the same bounded cancellation and timeout mechanism', async t => {
  const entered = Promise.withResolvers(), input = request('ordinary-timeout');
  const f = await fixture(t, { async *stream(_r, { signal }) {
    entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operation = f.host.runModelTurn(input, { execution: { timeouts: { firstResponseMs: 1000, idleMs: 1000, totalMs: 5000 } } });
  await entered.promise; t.mock.timers.tick(1000); const terminal = await operation;
  assert.equal(terminal.payload.status, 'failed'); assert.equal(terminal.payload.reason, 'model_request_timeout');
  assert.equal(terminal.payload.details.timeoutReason, 'first_response');
  assert.equal(f.checkpoints.list().length, 0);
});

test('internal tasks cannot bypass their domain owner when resuming a source snapshot', async t => {
  const entered = Promise.withResolvers(), input = request('recovery'), controller = new AbortController();
  const f = await fixture(t, { async *stream(_r, { signal }) {
    entered.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  let committed = false;
  const operation = f.host.runInternalTask(input, { signal: controller.signal, acceptResult: async () => { committed = true; } });
  await entered.promise;
  const restarted = new InMemoryRuntimeHost({ provider: { async *stream() { assert.fail('stale snapshot was resumed'); } },
    dataRoot: f.root, registerDefaultWorkspaceTools: false, checkpointStore: f.checkpoints, eventLog: f.events, settleOrphanedTurns: false });
  await assert.rejects(restarted.resumeModelTurn(input.sessionId, input.turnId), /fresh validated source snapshot/);
  controller.abort(); const result = await operation;
  assert.equal(result.terminal.payload.status, 'stopped'); assert.equal(committed, false);
  await restarted.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});
