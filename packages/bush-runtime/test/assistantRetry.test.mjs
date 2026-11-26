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
      tools: [], metadata: {}, permissionMode: 'ask_for_approval', ...options } });
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
    f.send({ metadata: { uiLanguage: 'zh' } }); await until(() => !f.read().busy);
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

test('retained assistant failures follow the reading locale without another model request', async t => {
  let calls = 0;
  const f = fixture(t, { async *stream(request) { calls++; yield event(request, 0, 'response_completed', { finishReason: 'stop' }); } });
  f.send({ metadata: { uiLanguage: 'zh-CN' } }); await until(() => !f.read().busy);
  assert.match(f.read().error, /未返回回复/);
  const read = language => f.assistant.command({ action: 'read', sessionId: id, language });
  assert.match(read('en-US').error, /returned no reply/);
  assert.match(read('zh-CN').error, /未返回回复/);
  assert.match(read('invalid_locale!').error, /returned no reply/);
  f.assistant.command({ action: 'stop', sessionId: id });
  assert.match(read('en').error, /Reply stopped/); assert.match(read('zh').error, /已停止回复/);
  assert.equal(calls, 1); assert.equal(f.journal.read(id).length, 1);
});

test('a reopened assistant reports unfinished input in the requested locale', t => {
  const f = fixture(t, { async *stream() { throw Error('Read must never start inference'); } });
  f.journal.append(id, { id: 'saved', role: 'user', content: 'Continue', source: 'text', visibility: 'conversation', createdAt: new Date().toISOString() });
  assert.match(f.assistant.command({ action: 'read', sessionId: id, language: 'en' }).error, /previous reply did not complete/);
  assert.match(f.assistant.command({ action: 'read', sessionId: id, language: 'zh' }).error, /上次回复未完成/);
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
  f.send({ metadata: { uiLanguage: 'zh' } }); await until(() => attempts === 1);
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

for (const running of [false, true]) test(`tool budget closes with a read-only reply and ${running ? 'correlated' : 'no'} background work`, async t => {
  const calls = [], terminal = [];
  const subagent = { name: 'subagent', description: 'Save an agent', inputSchema: { type: 'object' } };
  const team = { name: 'team', description: 'Save or run a team', inputSchema: { type: 'object' } };
  const other = { originMessageIds: ['other-request'], parentTurnId: 'another-turn', status: 'running' };
  const current = { originMessageIds: ['user-input'], parentTurnId: 'turn', status: 'running' };
  const f = fixture(t, { async *stream(request) {
    const round = calls.push(request);
    if (round <= 10) {
      const name = round === 10 ? 'team' : 'subagent';
      const action = name === 'team' && running ? 'run' : 'save';
      yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: `call-${round}`, nameDelta: name, argumentsDelta: JSON.stringify({ action }) });
      yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
      return;
    }
    assert.deepEqual(request.tools, []);
    const receipts = request.messages.filter(message => message.role === 'tool');
    assert.equal(receipts.length, 10);
    assert.equal(JSON.parse(receipts.at(-1).content).team_id, 'saved-team');
    const fact = request.messages.at(-1);
    assert.equal(fact.name, 'assistant_round_limit');
    assert.deepEqual(JSON.parse(fact.content), { reason: 'tool_round_limit', toolRoundsExecuted: 10, toolExecutionAvailable: false,
      subagentTasks: running ? [{ taskId: 'current-child', status: 'running' }] : [],
      teamRuns: running ? [{ runId: 'current-run', teamId: 'saved-team', status: 'running' }] : [] });
    yield event(request, 0, 'text_delta', { delta: running ? 'The team has started.' : 'The team definition was saved.' });
    yield event(request, 1, 'response_completed', { finishReason: 'stop' });
  } }, undefined, {
    delegationTools: () => [subagent, team],
    tasks: () => [{ ...other, taskId: 'unrelated-child' }, ...(running ? [{ ...current, taskId: 'current-child' },
      { ...current, taskId: 'team-node', origin: 'team' }] : [])],
    teamRuns: async () => [{ ...other, id: 'unrelated-run', teamId: 'another-team' },
      ...(running ? [{ ...current, id: 'current-run', teamId: 'saved-team' }] : [])],
    delegate: async input => {
      f.delegated.push(input);
      return input.action === 'team' ? { team_id: 'saved-team', ...(running ? { run_id: 'current-run', status: 'running' } : { revision: 1 }) }
        : { agent_id: `agent-${f.delegated.length}`, revision: 1 };
    },
    observeOutcome: observation => { if (observation.kind === 'turn_terminal') terminal.push(observation.status); },
  });
  f.send({ tools: [subagent, team] });
  await until(() => !f.read().busy);
  assert.equal(calls.length, 11);
  assert.equal(f.delegated.length, 10);
  assert.deepEqual(terminal, ['stopped']);
  assert.equal(f.read().error, '');
  const reply = f.journal.read(id).at(-1);
  assert.equal(reply.content, running ? 'The team has started.' : 'The team definition was saved.');
  assert.deepEqual(reply.responseTo, ['user-input']);
  assert.equal(f.journal.modelHistory(id).read().messages.some(message => message.name === 'assistant_round_limit'), false);
});

test('an invalid closeout leaves a retryable report without executing its calls or replaying prior receipts', async t => {
  let calls = 0;
  const f = fixture(t, { async *stream(request) {
    const round = ++calls;
    if (round <= 11) {
      if (round === 11) assert.deepEqual(request.tools, []);
      yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: `call-${round}`, nameDelta: 'subagent', argumentsDelta: '{"prompt":"Inspect files"}' });
      yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
      return;
    }
    assert.equal(request.messages.filter(message => message.role === 'tool').length, 10);
    assert.ok(request.tools.some(tool => tool.name === 'subagent'));
    yield event(request, 0, 'text_delta', { delta: 'Recovered from the saved receipts.' });
    yield event(request, 1, 'response_completed', { finishReason: 'stop' });
  } });
  f.send({ metadata: { uiLanguage: 'zh' } });
  await until(() => !f.read().busy);
  assert.equal(calls, 11);
  assert.equal(f.delegated.length, 10);
  assert.equal(f.read().canRetry, true);
  assert.match(f.read().error, /工具回执已保留/);
  assert.doesNotMatch(f.read().error, /后台任务继续/);
  assert.deepEqual(f.journal.modelHistory(id).replyInputs(), ['user-input']);
  assert.equal(f.journal.modelHistory(id).toolCallIds().includes('call-11'), false);
  f.retry();
  await until(() => !f.read().busy);
  assert.equal(calls, 12);
  assert.equal(f.delegated.length, 10);
  assert.equal(f.read().error, '');
  assert.deepEqual(f.journal.read(id).map(entry => entry.content), ['Inspect the files', 'Recovered from the saved receipts.']);
});

test('an unfinished persisted message offers recovery after restarting assistant', async t => {
  const f = fixture(t, { async *stream(request) { yield failure(request, 0, { status: 401 }); } });
  f.send(); await until(() => !f.read().busy); f.assistant.close();
  const restored = new AssistantConversation(f.journal, { provider: { async *stream() {} }, checkpoint: () => ({}),
    exists: () => true, tasks: () => [], delegate: async () => ({}) });
  t.after(() => restored.close());
  const snapshot = restored.command({ action: 'read', sessionId: id, language: 'zh' });
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
  f.send({ metadata: { assistantOutputMode: 'voice' } }); await until(() => Boolean(f.read().retry));
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
