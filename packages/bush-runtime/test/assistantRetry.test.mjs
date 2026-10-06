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

function fixture(t, provider, wait) {
  const root = mkdtempSync(join(tmpdir(), 'assistant-retry-')), journal = new ConversationJournal(root), delegated = [];
  const assistant = new AssistantConversation(journal, { provider, wait, checkpoint: () => ({}), exists: () => true, tasks: () => [],
    delegate: async input => { delegated.push(input); return { taskId: 'child', status: 'running' }; } });
  t.after(() => { assistant.close(); rmSync(root, { force: true, recursive: true }); });
  const send = () => assistant.command({ action: 'turn', sessionId: id,
    entry: { id: 'user-input', role: 'user', content: 'Inspect the files', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() },
    profile: assistantProfileSchema.parse({}), parent: { protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: id,
      turnId: 'turn', model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Inspect the files' } }],
      tools: [], metadata: {}, permissionMode: 'task_free' } });
  return { assistant, journal, delegated, send, read: () => assistant.command({ action: 'read', sessionId: id }) };
}

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
