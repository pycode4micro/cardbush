import assert from 'node:assert/strict';
import test from 'node:test';
import { BUSH_MODEL_EVENT_PROTOCOL, BUSH_SESSION_TURN_REQUEST_PROTOCOL, STOP_RUNTIME_TURN_COMMAND } from '@cardbush/bush-protocol';
import { CoordinationStore, InMemoryRuntimeHost, SessionStore, ToolRegistry, registerCoordinationTools } from '../dist/index.js';

const catalog = new ToolRegistry();
registerCoordinationTools(catalog, new CoordinationStore());
const auth = { id: 'auth', step: 'Submit generation', status: 'waiting', waitingFor: 'User confirms submission' };
const verify = { id: 'verify', step: 'Download and verify', status: 'pending' };
const plan = nodes => ({ protocol: 'bush.task_plan.v1', plan_id: 'plan', session_id: 'session', nodes,
  active: nodes.some(node => node.status !== 'completed'), explanation: '' });
function setup(nodes, options) {
  const store = new CoordinationStore(options);
  store.setPlan({ sessionId: 'session', expectedRevision: 0, plan: plan(nodes) });
  store.createGoal({ goalId: 'goal', sessionId: 'session', objective: 'Deliver a verified result' });
  return store;
}
const request = turnId => ({ protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL, requestId: `request_${turnId}`, sessionId: 'session', turnId,
  model: 'model', prefixMessages: [{ role: 'system', content: 'Follow the user request.' }],
  inputMessages: [{ messageId: `user_${turnId}`, message: { role: 'user', content: 'Continue the work.' } }], tools: catalog.definitions(), metadata: { planEnabled: true } });
const event = (r, sequence, kind, payload = {}) => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: r.requestId, sequence,
  createdAt: '2026-09-16T00:00:00Z', kind, ...payload });
function* answer(r) {
  yield event(r, 0, 'text_delta', { delta: 'All steps are completed.' });
  yield event(r, 1, 'response_completed', { finishReason: 'stop' });
}

for (const nodes of [[auth, verify], [verify], [{ ...verify, status: 'in_progress' }]]) {
  test(`a final completion claim preserves recorded ${nodes.map(n => n.status).join('/')} plan states without another model call`, async () => {
    const events = [];
    const persistence = { load: () => structuredClone(events), append: event => events.push(structuredClone(event)) };
    const coordinationStore = setup(nodes, { persistence });
    const recorded = coordinationStore.getPlan('session');
    const sessionStore = new SessionStore();
    let calls = 0;
    const host = new InMemoryRuntimeHost({ coordinationStore, sessionStore, provider: { async *stream(r) { calls++; yield* answer(r); } } });
    const terminal = await host.runSessionTurn(request('handoff'));
    assert.equal(calls, 1, 'an unchanged plan must not force more model requests');
    assert.equal(terminal.payload.reason, nodes.some(node => node.status === 'waiting') ? 'task_plan_waiting' : 'model_response_completed');
    assert.equal(terminal.payload.status, 'completed');
    assert.deepEqual(coordinationStore.getPlan('session'), recorded);
    assert.deepEqual(new CoordinationStore({ persistence }).getPlan('session'), recorded, 'journal replay retains only the explicit plan update');
    assert.equal(events.filter(event => event.kind === 'plan_set').length, 1);
    assert.equal(coordinationStore.getGoal('session').status, 'active');
    assert.equal(terminal.payload.details.taskPlan, undefined);
    const final = sessionStore.snapshot('session').turns[0].messages.find(m => m.messageId === terminal.payload.finalMessageId);
    assert.equal(final.metadata?.taskPlan, undefined, 'the final reply must not create a second plan fact');
    assert.ok(!sessionStore.snapshot('session').turns[0].messages.some(m => m.message.name === 'task_plan_continuation'));
  });
}

test('a successful tool update records the model statuses without verifying the work', async () => {
  const coordinationStore = setup([auth, verify]);
  const finished = [auth, verify].map(({ waitingFor, ...node }) => ({ ...node, status: 'completed' }));
  let calls = 0;
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) {
    if (++calls === 1) {
      yield event(r, 0, 'tool_call_delta', { index: 0, toolCallId: 'plan_update', nameDelta: 'update_task_plan',
        argumentsDelta: JSON.stringify({ nodes: finished, active: false, explanation: 'I consider these steps complete.' }) });
      yield event(r, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else yield* answer(r);
  } } });
  const terminal = await host.runSessionTurn(request('done'));
  assert.equal(terminal.payload.reason, 'model_response_completed');
  assert.deepEqual(coordinationStore.getPlan('session').plan.nodes, finished);
  assert.equal(coordinationStore.getPlan('session').revision, 2);
  assert.equal(coordinationStore.getPlan('session').plan.active, false);
  assert.equal(calls, 2);
});

test('a final reply leaves the last successful progress update unchanged', async () => {
  const coordinationStore = setup([auth, verify]);
  let calls = 0;
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) {
    if (++calls === 1) {
      yield event(r, 0, 'tool_call_delta', { index: 0, toolCallId: 'progress', nameDelta: 'update_task_plan',
        argumentsDelta: JSON.stringify({ nodes: [auth, verify], active: true, explanation: 'Still working.' }) });
      yield event(r, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      assert.equal(coordinationStore.getPlan('session').plan.active, true);
      assert.equal(coordinationStore.getPlan('session').revision, 2);
      yield* answer(r);
    }
  } } });
  const terminal = await host.runSessionTurn(request('tools'));
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(coordinationStore.getPlan('session').revision, 2);
  assert.equal(coordinationStore.getPlan('session').plan.active, true);
  assert.deepEqual(coordinationStore.getPlan('session').plan.nodes, [auth, verify]);
  assert.equal(coordinationStore.getPlan('session').plan.explanation, 'Still working.');
});

test('a failed update and a final completion claim do not change the recorded plan', async () => {
  const coordinationStore = setup([verify]);
  const recorded = coordinationStore.getPlan('session');
  let calls = 0;
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) {
    if (++calls === 1) {
      yield event(r, 0, 'tool_call_delta', { index: 0, toolCallId: 'invalid', nameDelta: 'update_task_plan',
        argumentsDelta: JSON.stringify({ nodes: [{ ...verify, status: 'invalid' }], active: false, explanation: 'Done.' }) });
      yield event(r, 1, 'response_completed', { finishReason: 'tool_calls' });
    } else yield* answer(r);
  } } });
  const terminal = await host.runSessionTurn(request('invalid'));
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(calls, 2);
  assert.deepEqual(coordinationStore.getPlan('session'), recorded);
});

test('a final reply with no plan does not invent one', async () => {
  const coordinationStore = new CoordinationStore();
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) { yield* answer(r); } } });
  assert.equal((await host.runSessionTurn(request('no-plan'))).payload.status, 'completed');
  assert.equal(coordinationStore.getPlan('session'), undefined);
});

test('explicit stop preserves the last reported plan states', async () => {
  const nodes = [auth, verify];
  const coordinationStore = setup(nodes);
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) {
    yield event(r, 0, 'text_delta', { delta: 'Still working.' });
    entered();
    await new Promise(() => {});
  } } });
  const pending = host.runSessionTurn(request('stop'));
  await started;
  await host.sendCommand({ kind: STOP_RUNTIME_TURN_COMMAND, payload: { sessionId: 'session', turnId: 'stop' } });
  assert.equal((await pending).payload.status, 'stopped');
  assert.deepEqual(coordinationStore.getPlan('session').plan.nodes, nodes);
  assert.equal(coordinationStore.getPlan('session').revision, 1);
});

test('an empty failed response does not close the plan', async () => {
  const coordinationStore = setup([verify]);
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream(r) {
    yield event(r, 0, 'response_completed', { finishReason: 'stop' });
  } } });
  assert.equal((await host.runSessionTurn(request('empty'))).payload.status, 'failed');
  assert.equal(coordinationStore.getPlan('session').revision, 1);
});

test('provider execution errors still fail and do not change plan states', async () => {
  const nodes = [auth, verify];
  const coordinationStore = setup(nodes);
  const host = new InMemoryRuntimeHost({ coordinationStore, provider: { async *stream() { throw new Error('Provider connection failed'); } } });
  const terminal = await host.runSessionTurn(request('provider-failure'));
  assert.equal(terminal.payload.status, 'failed');
  assert.notEqual(terminal.payload.reason, 'open_task_plan_not_resolved');
  assert.deepEqual(coordinationStore.getPlan('session').plan.nodes, nodes);
});
