import test from 'node:test';
import assert from 'node:assert/strict';
import { WebRemoteQuestions } from '../dist-electron/webRemoteQuestions.mjs';
import { remoteIdentity } from '../dist-electron/webRemoteAgents.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { csrfToken, WebError } from '../dist-electron/webCommon.mjs';

const session = 'web-' + 'a'.repeat(40), otherSession = 'web-' + 'b'.repeat(40), secret = 'questions-fixture-'.repeat(4);
function fixture() {
  const owner = 'webparent_' + remoteIdentity(secret, 'alice', session);
  const job = { id: 'child-task', sessionId: 'delegated-child', turnId: 'turn-child', status: 'running', delegation: { parentSessionId: owner } };
  const question = { selectionId: 'question-1', sessionId: job.sessionId, turnId: job.turnId, toolCallId: 'ask-1', createdAt: new Date().toISOString(), blocking: true, prompt: 'May I retry without the product image?', options: ['Retry', 'Keep blocked'] };
  const state = { questions: [question], jobs: [job], calls: [], enabled: true, agentId: 'worker', failAnswer: false, gate: undefined };
  const client = { info: async () => ({ id: state.agentId, capabilities: { delegation: true } }), close() {},
    async call(operation, input) {
      state.calls.push({ operation, input });
      if (operation === 'chat.jobs') return state.jobs;
      if (operation !== 'runtime.command') throw Error('Unexpected operation: ' + operation);
      if (input.kind === 'runtime.list_solution_selections') return state.questions;
      assert.equal(input.kind, 'runtime.answer_solution_selection');
      if (state.gate) await state.gate;
      if (state.failAnswer) throw Error('Transport unavailable');
      const index = state.questions.findIndex(q => q.selectionId === input.payload.selectionId);
      assert.notEqual(index, -1);
      state.questions.splice(index, 1); return input.payload;
    } };
  const registry = { secret, async list(user) { return user === 'alice' && state.enabled ? [{ id: 'connection' }] : []; },
    async authorized(user) { if (user !== 'alice' || !state.enabled) throw new WebError(403, 'Revoked'); return { agentId: 'worker' }; },
    async clientFactory() { return client; } };
  return { state, registry, relay: new WebRemoteQuestions(registry), question, job };
}

test('owned remote questions survive gateway reconstruction with stable IDs and no transcript or task replay', async () => {
  const f = fixture(), items = await f.relay.list('alice', session);
  assert.equal(items.length, 1); assert.equal(items[0].sessionId, session); assert.equal(items[0].prompt, f.question.prompt);
  assert.deepEqual(items, await new WebRemoteQuestions(f.registry).list('alice', session));
  assert.deepEqual(await f.relay.list('bob', session), []);
  assert.deepEqual(await f.relay.list('alice', otherSession), []);
  assert.ok(f.state.calls.every(c => ['chat.jobs', 'runtime.command'].includes(c.operation)));
});

for (const answer of [{ kind: 'option', optionIndex: 1 }, { kind: 'text', text: 'Keep this task blocked.' }, { kind: 'cancel' }]) {
  test('forward exactly the user answer: ' + answer.kind, async () => {
    const f = fixture(), [q] = await f.relay.list('alice', session);
    const input = { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, ...answer };
    await f.relay.answer('alice', input);
    const writes = f.state.calls.filter(c => c.input.kind === 'runtime.answer_solution_selection');
    assert.deepEqual(writes.map(c => c.input.payload), [{ ...answer, sessionId: f.question.sessionId, turnId: f.question.turnId, selectionId: f.question.selectionId }]);
    assert.deepEqual(await f.relay.list('alice', session), []);
    await assert.rejects(f.relay.answer('alice', input), e => e.status === 409);
    assert.equal(f.state.calls.filter(c => c.input.kind === 'runtime.answer_solution_selection').length, 1);
  });
}

test('multiple questions retain question IDs and the complete structured answer', async () => {
  const f = fixture(); delete f.question.prompt; delete f.question.options;
  f.question.questions = [{ id: 'retry', prompt: 'Retry?', options: ['Yes', 'No'] }, { id: 'account', prompt: 'Account?', options: [] }];
  const [q] = await f.relay.list('alice', session), answers = [{ questionId: 'retry', kind: 'option', optionIndex: 1 }, { questionId: 'account', kind: 'text', text: 'Test account' }];
  assert.deepEqual(q.questions, f.question.questions);
  await f.relay.answer('alice', { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, kind: 'answers', answers });
  assert.deepEqual(f.state.calls.at(-1).input.payload.answers, answers);
});

test('concurrent submits coalesce; conflicting, cross-session and revoked answers never reach the worker', async () => {
  const f = fixture(), [q] = await f.relay.list('alice', session);
  const input = { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, kind: 'text', text: 'No' };
  await assert.rejects(f.relay.answer('alice', { ...input, sessionId: otherSession }), e => e.status === 409);
  await assert.rejects(f.relay.answer('alice', { ...input, turnId: 'wrong' }), e => e.status === 409);
  let release; f.state.gate = new Promise(r => { release = r; });
  const first = f.relay.answer('alice', input), second = f.relay.answer('alice', input);
  await assert.rejects(f.relay.answer('alice', { ...input, text: 'Yes' }), e => e.status === 409);
  release(); await Promise.all([first, second]);
  assert.equal(f.state.calls.filter(c => c.input.kind === 'runtime.answer_solution_selection').length, 1);
  const revoked = fixture(); await revoked.relay.list('alice', session); revoked.state.enabled = false;
  await assert.rejects(revoked.relay.list('alice', session), e => e.status === 403);
  await assert.rejects(revoked.relay.answer('alice', input));
  assert.ok(!revoked.state.calls.some(c => c.input.kind === 'runtime.answer_solution_selection'));
});

test('completed jobs, mismatched turn IDs and changed worker identity cannot produce actionable questions', async () => {
  for (const change of [f => { f.job.status = 'completed'; }, f => { f.question.turnId = 'different-turn'; }]) {
    const f = fixture(); change(f); assert.deepEqual(await f.relay.list('alice', session), []);
  }
  const f = fixture(); f.state.agentId = 'replacement';
  await assert.rejects(f.relay.list('alice', session), e => e.status === 409);
});

test('failed delivery retains the question and never automatically repeats an answer', async () => {
  const f = fixture(), [q] = await f.relay.list('alice', session); f.state.failAnswer = true;
  await assert.rejects(f.relay.answer('alice', { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, kind: 'cancel' }));
  assert.equal((await f.relay.list('alice', session)).length, 1);
  assert.equal(f.state.calls.filter(c => c.input.kind === 'runtime.answer_solution_selection').length, 1);
});

test('authenticated web routes merge local questions and route remote answers without touching the parent wait', async t => {
  const f = fixture(), token = 'alice'.padEnd(54, '_'), localCalls = [];
  const local = { selectionId: 'local-question', sessionId: session, turnId: 'parent-turn', toolCallId: 'ask-local', createdAt: new Date().toISOString(), prompt: 'Local?', options: [] };
  const store = { authenticate: async value => value === token ? { id: 'alice', is_active: true } : null,
    conversation: async (user, id) => { if (user !== 'alice' || id !== session) throw new WebError(404, 'Not owned'); return { id }; } };
  const agent = { async call(op, input) { localCalls.push({ op, input }); return input.kind === 'runtime.list_solution_selections' ? [local] : input.payload; } };
  const server = await serveWeb({ modelSecret: secret, defaultModelId: 'm', models: [{ id: 'm' }], origin: 'http://fixture.test', host: '127.0.0.1', port: 0, staticRoot: 'dist-web' }, store, { get: async () => agent, close() {} }, undefined, f.registry);
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.port}/api/web/v1/sessions/${session}/solutions`;
  const headers = { Cookie: 'cardbush_web=' + token, Origin: 'http://fixture.test', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(token) };
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fetch(endpoint, { headers }); assert.equal(response.status, 200);
  const questions = await response.json(); assert.equal(questions.length, 2);
  const q = questions.find(q => q.selectionId.startsWith('remote_solution_'));
  const body = JSON.stringify({ selectionId: q.selectionId, turnId: q.turnId, kind: 'text', text: 'No retry' });
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body })).status, 200);
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), [local]);
  assert.ok(localCalls.every(c => c.input.kind === 'runtime.list_solution_selections'));
});
