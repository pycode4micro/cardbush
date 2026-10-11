import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';

const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
const event = (request, sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, createdAt: new Date().toISOString(), kind, ...fields });
const failure = (request, sequence = 0, fields = {}) => event(request, sequence, 'response_failed', {
  code: 'ECONNRESET', message: 'Connection error. (ECONNRESET)', retryable: true, ...fields });

function fixture(t, provider, wait, deps = {}) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-retry-')), journal = new ConversationJournal(root), delegated = [];
  const assistant = new AssistantConversation(journal, { provider, wait, checkpoint: () => ({}), exists: () => true, tasks: () => [],
    delegate: async input => { delegated.push(input); return { taskId: 'child', status: 'running' }; }, ...deps });
  t.after(() => { assistant.close(); rmSync(root, { force: true, recursive: true }); });
  let parent;
  const send = (options = {}) => assistant.command({ action: 'turn', sessionId: id,
    entry: { id: 'user-input', role: 'user', content: 'Inspect the files', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
    profile: assistantProfileSchema.parse({}), parent: parent = { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: id,
      turnId: 'turn', model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Inspect the files' } }],
      tools: [], metadata: {}, permissionMode: 'task_free', ...options } });
  return { assistant, journal, delegated, send, retry: options => assistant.command({ action: 'retry', sessionId: id,
    parent: { ...parent, ...options }, profile: assistantProfileSchema.parse({}) }), read: () => assistant.command({ action: 'read', sessionId: id }) };
}

test('empty and reasoning-only truncated replies fail visibly and retry preserves the original message', async t => {
  for (const finishReason of ['stop', 'length']) {
    const requests = [];
    const f = fixture(t, { async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield event(request, 0, 'reasoning_delta', { delta: 'Private deliberation only' });
        yield event(request, 1, 'response_completed', { finishReason });
      } else {
        yield event(request, 0, 'text_delta', { delta: 'Recovered reply' });
        yield event(request, 1, 'response_completed', { finishReason: 'stop' });
      }
    } });
    f.send(); await until(() => !f.read().busy);
    assert.equal(requests[0].maxOutputTokens, 128000);
    assert.equal(f.read().canRetry, true);
    assert.match(f.read().error, finishReason === 'length' ? /输出达到上限/ : /未返回回复/);
    assert.equal(f.journal.modelHistory(id).read().messages.some(message => message.role === 'assistant'), false);
    f.retry({ maxOutputTokens: 200000 }); await until(() => !f.read().busy);
    assert.equal(requests[1].maxOutputTokens, 200000, 'retry uses current model settings without a hidden cap');
    assert.equal(f.read().canRetry, false); assert.equal(f.read().error, '');
    assert.deepEqual(f.journal.read(id).map(entry => entry.content), ['Inspect the files', 'Recovered reply']);
  }
});

test('stopping an uncooperative provider releases busy and ignores late output after retry', async t => {
  let release, attempts = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { async *stream(request) {
    const first = ++attempts === 1;
    if (first) await blocked;
    yield event(request, 0, 'text_delta', { delta: first ? 'Must not appear' : 'Recovered reply' });
    yield event(request, 1, 'response_completed', { finishReason: 'stop' });
  } });
  t.after(release);
  f.send(); await until(() => attempts === 1);
  f.assistant.command({ action: 'stop', sessionId: id });
  await until(() => !f.read().busy);
  assert.equal(f.read().canRetry, true); assert.match(f.read().error, /已停止/);
  f.retry(); await until(() => !f.read().busy);
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.read().error, '');
  assert.deepEqual(f.journal.read(id).map(entry => entry.content), ['Inspect the files', 'Recovered reply']);
});

test('manual retry resumes after an accepted task receipt without dispatching it twice', async t => {
  let rounds = 0;
  const f = fixture(t, { async *stream(request) {
    if (++rounds === 1) {
      yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: 'accepted-task', nameDelta: 'subagent', argumentsDelta: '{"prompt":"Inspect files"}' });
      yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else if (rounds === 2) yield failure(request, 0, { code: 'invalid_api_key', status: 401, retryable: false });
    else {
      assert.ok(request.messages.some(message => message.role === 'tool' && message.toolCallId === 'accepted-task'));
      yield event(request, 0, 'text_delta', { delta: 'The task was already accepted.' });
      yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    }
  } });
  f.send(); await until(() => !f.read().busy);
  assert.equal(f.delegated.length, 1); assert.equal(f.read().canRetry, true);
  f.retry(); await until(() => !f.read().busy);
  assert.equal(f.delegated.length, 1); assert.equal(f.read().error, '');
  assert.equal(f.journal.read(id).filter(entry => entry.source === 'text' && entry.role === 'user').length, 1);
});

test('an unfinished persisted message offers recovery after restarting assistant', async t => {
  const f = fixture(t, { async *stream(request) { yield failure(request, 0, { status: 401 }); } });
  f.send(); await until(() => !f.read().busy); f.assistant.close();
  const restored = new AssistantConversation(f.journal, { provider: { async *stream() {} }, checkpoint: () => ({}),
    exists: () => true, tasks: () => [], delegate: async () => ({}) });
  t.after(() => restored.close());
  const snapshot = restored.command({ action: 'read', sessionId: id });
  assert.equal(snapshot.canRetry, true); assert.equal(snapshot.busy, false);
  assert.match(snapshot.error, /上次回复未完成/);
});

test('a memory scheduling failure cannot leave assistant busy', async t => {
  const f = fixture(t, { async *stream(request) {
    yield event(request, 0, 'text_delta', { delta: 'Saved reply' });
    yield event(request, 1, 'response_completed', { finishReason: 'stop' });
  } }, undefined, { memory: { definitions: () => [], recall: async () => undefined, changes: async () => undefined,
    schedule: () => { throw Error('Memory schedule failed'); } } });
  f.send(); await until(() => !f.read().busy);
  assert.match(f.read().error, /Memory schedule failed/);
  assert.equal(f.journal.read(id).at(-1).content, 'Saved reply');
});

test('assistant retries the same failed round without replaying earlier dispatch or page writes', async t => {
  const requests = [], waits = []; let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      for (const [index, name, args] of [[0, 'subagent', { prompt: 'Inspect files' }], [1, 'page_write', { content: 'Task accepted' }]])
        yield event(request, index, 'tool_call_delta', { index, toolCallId: 'call-' + index, nameDelta: name, argumentsDelta: JSON.stringify(args) });
      yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
    } else if (requests.length <= 3) {
      yield event(request, 0, 'text_delta', { delta: 'unfinished, must not be published' });
      yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: 'discarded', nameDelta: 'subagent', argumentsDelta: '{"prompt":"must not run"}' });
      yield failure(request, 2);
    } else {
      yield event(request, 0, 'text_delta', { delta: 'Recovered reply' });
      yield event(request, 1, 'response_completed', { finishReason: 'stop' });
    }
  } }, async delay => { waits.push(delay); if (waits.length === 1) await blocked; });
  t.after(release);
  f.send(); await until(() => Boolean(f.read().retry));
  assert.equal(f.read().busy, true); assert.equal(f.read().error, ''); assert.equal(f.read().retry.attempt, 2);
  assert.equal(f.read().retry.code, 'ECONNRESET'); assert.equal(f.delegated.length, 1);
  release(); await until(() => !f.read().busy);
  assert.equal(f.read().error, ''); assert.equal(f.read().retry, null);
  assert.deepEqual(waits, [1000, 2000]); assert.equal(requests.length, 4);
  assert.deepEqual(requests[2], requests[1]); assert.deepEqual(requests[3], requests[1]);
  assert.equal(f.delegated.length, 1);
  assert.deepEqual(f.journal.read(id).map(item => item.content), ['Inspect the files', 'Task accepted', 'Recovered reply']);
});

test('assistant caps transient retries at three attempts and retains user input on failure', async t => {
  let attempts = 0; const waits = [];
  const f = fixture(t, { async *stream(request) { attempts++; yield failure(request); } }, async ms => { waits.push(ms); });
  f.send(); await until(() => !f.read().busy);
  assert.equal(attempts, 3); assert.deepEqual(waits, [1000, 2000]);
  assert.match(f.read().error, /ECONNRESET/); assert.equal(f.read().retry, null);
  assert.equal(f.journal.read(id).length, 1); assert.equal(f.delegated.length, 0);
});

test('authentication and tool validation failures are not treated as transient connections', async t => {
  for (const error of [{ code: 'invalid_api_key', retryable: false, status: 401 }, { code: 'incomplete_tool_call', retryable: true }]) {
    let attempts = 0;
    const f = fixture(t, { async *stream(request) { attempts++; yield failure(request, 0, error); } }, async () => assert.fail('must not retry'));
    f.send(); await until(() => !f.read().busy);
    assert.equal(attempts, 1); assert.equal(f.read().retry, null); assert.ok(f.read().error);
  }
});

test('reset and shutdown interrupt server backoff and cannot dispatch or publish a late retry', async t => {
  for (const action of ['reset', 'close']) {
    let attempts = 0;
    const f = fixture(t, { async *stream(request) { attempts++; yield failure(request, 0, { retryAfterMs: 300000 }); } });
    f.send(); await until(() => Boolean(f.read().retry));
    assert.equal(f.read().retry.nextRetryMs, 300000);
    if (action === 'reset') f.assistant.command({ action, sessionId: id }); else f.assistant.close();
    await until(() => !f.read().busy);
    assert.equal(attempts, 1); assert.equal(f.delegated.length, 0); assert.equal(f.read().retry, null); assert.equal(f.read().error, '');
  }
});
