import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { WebRemoteQuestions } from '../dist-electron/webRemoteQuestions.mjs';
import { remoteIdentity } from '../dist-electron/webRemoteAgents.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { csrfToken, WebError } from '../dist-electron/webCommon.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from 'undici';

const dispatcher = new Agent();
const fetch = (url, options) => globalThis.fetch(url, { ...options, dispatcher });
after(() => dispatcher.close());

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

test('offline sources do not hide healthy remote questions or prevent their answers', async () => {
  const f = fixture(), factory = f.registry.clientFactory;
  f.registry.list = async () => [{ id: 'offline' }, { id: 'connection' }];
  f.registry.authorized = async (_user, id) => ({ agentId: 'worker', id });
  f.registry.clientFactory = async connection => {
    if (connection.id === 'offline') throw Error('Disconnected');
    return factory();
  };
  const result = await f.relay.read('alice', session);
  assert.equal(result.unavailable, true);
  assert.equal(result.items.length, 1);
  const q = result.items[0];
  await f.relay.answer('alice', { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, kind: 'text', text: 'Keep blocked' });
  assert.equal(f.state.calls.filter(c => c.input.kind === 'runtime.answer_solution_selection').length, 1);
});

test('a hung factory is bounded and its late SSH client is closed without being used', async () => {
  const f = fixture(); let closed = 0, used = 0;
  f.registry.clientFactory = async () => {
    await delay(80);
    return { info: async () => { used++; }, close() { closed++; } };
  };
  const relay = new WebRemoteQuestions(f.registry, 20), start = Date.now();
  assert.deepEqual(await relay.read('alice', session), { items: [], unavailable: true });
  assert.ok(Date.now() - start < 500);
  await delay(100);
  assert.equal(closed, 1); assert.equal(used, 0);
});

test('an offline answer target reports unavailability and never consumes or retries the answer', async () => {
  const f = fixture(), [q] = await f.relay.list('alice', session);
  f.registry.clientFactory = async () => { throw Error('Offline'); };
  await assert.rejects(f.relay.answer('alice', { sessionId: session, turnId: q.turnId, selectionId: q.selectionId, kind: 'cancel' }), e => e.status === 503);
  assert.equal(f.state.questions.length, 1);
  assert.ok(!f.state.calls.some(c => c.input.kind === 'runtime.answer_solution_selection'));
});

test('cached failure recovers on the next read window; revocation removes cached questions', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const f = fixture(), factory = f.registry.clientFactory; let offline = true, opens = 0;
  f.registry.clientFactory = async () => { opens++; if (offline) throw Error('Offline'); return factory(); };
  assert.equal((await f.relay.read('alice', session)).unavailable, true);
  offline = false;
  assert.equal((await f.relay.read('alice', session)).unavailable, true);
  assert.equal(opens, 1);
  t.mock.timers.tick(5_001);
  assert.equal((await f.relay.read('alice', session)).items.length, 1);
  f.state.enabled = false;
  assert.deepEqual(await f.relay.read('alice', session), { items: [], unavailable: false });
});

test('local routes and answers remain available during a remote outage, including older clients', async t => {
  const f = fixture(), token = 'alice'.padEnd(54, '_'); let remoteOpens = 0, localOpens = 0, answers = 0;
  f.registry.clientFactory = async () => { remoteOpens++; throw Error('Worker offline'); };
  const local = { selectionId: 'local-question', sessionId: session, turnId: 'parent-turn', toolCallId: 'ask-local', createdAt: new Date().toISOString(), prompt: 'Local?', options: [] };
  const store = { authenticate: async value => value === token ? { id: 'alice', is_active: true } : null,
    conversation: async (user, id) => { if (user !== 'alice' || id !== session) throw new WebError(404, 'Not owned'); return { id }; } };
  const agent = { async call(_op, input) {
    if (input.kind === 'runtime.list_solution_selections') return [local];
    assert.equal(input.kind, 'runtime.answer_solution_selection'); answers++; return input.payload;
  } };
  const server = await serveWeb({ modelSecret: secret, defaultModelId: 'm', models: [{ id: 'm' }], origin: 'http://fixture.test', host: '127.0.0.1', port: 0, staticRoot: 'dist-web' }, store,
    { get: async () => { localOpens++; return agent; }, close() {} }, undefined, f.registry);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/web/v1/sessions/${session}/solutions`;
  const headers = { Cookie: 'cardbush_web=' + token, Origin: 'http://fixture.test', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken(token) };
  assert.equal((await fetch(url + '?scope=remote')).status, 401);
  assert.deepEqual(await (await fetch(url + '?scope=local', { headers })).json(), [local]);
  assert.equal(remoteOpens, 0);
  const before = localOpens;
  assert.deepEqual(await (await fetch(url + '?scope=remote', { headers })).json(), { items: [], unavailable: true });
  assert.equal(localOpens, before);
  const legacy = await fetch(url, { headers });
  assert.equal(legacy.status, 200); assert.deepEqual(await legacy.json(), [local]);
  const answer = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ selectionId: local.selectionId, turnId: local.turnId, kind: 'text', text: 'Continue locally' }) });
  assert.equal(answer.status, 200); assert.equal(answers, 1);
  assert.equal(remoteOpens, 1);
});
