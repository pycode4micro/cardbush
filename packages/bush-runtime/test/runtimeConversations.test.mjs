import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeConversations } from '../dist/runtimeConversations.js';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry } from '../dist/index.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const request = (id = 'a', metadata = {}) => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${id}`, sessionId: id,
  turnId: `t-${id}`, model: 'fixture', metadata: { projectDir: '/work/project', ...metadata }, sessionMetadata: {},
  tools: [], prefixMessages: [], inputMessages: [{ messageId: 'human', message: { role: 'user', content: 'Own task' } }] });
function fixture() {
  const runs = [], signals = [], errors = [];
  const bus = new RuntimeConversations({ busy: () => false, signal: (...args) => signals.push(args),
    run: async req => { runs.push(req); }, error: error => errors.push(error) });
  return { bus, runs, signals, errors };
}

test('presence has no prompts and excludes child, delegated, shadow and automation turns', () => {
  const f = fixture(); f.bus.begin(request());
  for (const metadata of [{ agentRole: 'child' }, { parentSessionId: 'a' }, { shadowMode: 'fork' }, { automationRunId: 'job' }]) {
    assert.equal(f.bus.begin(request('child', metadata)), undefined);
  }
  const delegated = request('employee'); delegated.sessionMetadata.delegationOwner = 'parent';
  assert.equal(f.bus.begin(delegated), undefined);
  assert.equal(f.bus.list().length, 1);
  assert.doesNotMatch(JSON.stringify(f.bus.list()), /Own task|inputMessages|prefixMessages/);
  f.bus.begin(request('a', { agentRole: 'child' })); assert.equal(f.bus.list().length, 0);
});

test('room notices coalesce, wake active waits, and remain internal user data', () => {
  const f = fixture(); f.bus.begin(request());
  f.bus.notify('a', { key: 'plugin:room', content: 'first', wake: true });
  f.bus.notify('a', { key: 'plugin:room', content: 'latest', wake: true });
  assert.equal(f.signals.length, 2); assert.equal(f.bus.hasPending('a'), true);
  assert.deepEqual(f.bus.take('a', 'another-turn'), [], 'internal work in the same session cannot steal a peer notice');
  assert.equal(f.bus.hasPending('a', 'another-turn'), false, 'an unrelated turn cannot be woken by this notice');
  const messages = f.bus.take('a'); assert.equal(messages.length, 1);
  assert.equal(messages[0].message.role, 'user'); assert.equal(messages[0].message.visibility, 'internal');
  assert.match(messages[0].message.content, /untrusted/); assert.match(messages[0].message.content, /latest/);
  assert.deepEqual(f.bus.take('a'), []);
});

test('idle wake retains session config and uses at most three background turns until new human input', async () => {
  const f = fixture(); f.bus.begin(request());
  f.bus.end('a', 't-a', false);
  f.bus.notify('a', { key: 'presence', content: 'a peer exists' }); await tick(); assert.equal(f.runs.length, 0);
  for (let count = 1; count <= 4; count++) {
    f.bus.notify('a', { key: 'room', content: `message-${count}`, wake: true }); await tick();
    assert.equal(f.runs.length, Math.min(count, 3));
    const req = f.runs.at(-1); assert.equal(req.metadata.peerMessageWake, true); assert.equal(req.sessionId, 'a');
    assert.equal(req.inputMessages[0].message.visibility, 'internal');
    if (count <= 3) { f.bus.begin(req); f.bus.take('a'); f.bus.end('a', req.turnId, false); }
  }
  const human = request(); human.turnId = 'new-human'; f.bus.begin(human); f.bus.take('a'); f.bus.end('a', human.turnId, false);
  f.bus.notify('a', { key: 'room', content: 'after human', wake: true }); await tick(); assert.equal(f.runs.length, 4);
  f.bus.close();
});

test('stop, disable, leave, deletion and a racing human turn cancel scheduled idle wake', async () => {
  for (const action of ['stop', 'disable', 'leave', 'forget', 'human', 'close']) {
    const f = fixture(); f.bus.begin(request()); f.bus.end('a', 't-a', false);
    f.bus.notify('a', { key: 'plugin:room', content: 'pending', wake: true });
    if (action === 'stop') f.bus.stop('a');
    if (action === 'disable') f.bus.revoke('plugin:');
    if (action === 'leave') f.bus.dismiss('a', 'plugin:room');
    if (action === 'forget') f.bus.forget('a');
    if (action === 'human') f.bus.begin({ ...request(), turnId: 'human-next' });
    if (action === 'close') f.bus.close();
    await tick(); assert.equal(f.runs.length, 0, action);
    if (action === 'stop') { f.bus.end('a', 't-a', false); await tick(); assert.equal(f.runs.length, 0); assert.equal(f.bus.hasPending('a'), true); }
  }
});

test('idle wake reruns the original request, without duplicating prepared workspace context', async () => {
  const f = fixture(), original = request();
  const prepared = structuredClone(original);
  prepared.prefixMessages.push({ role: 'developer', name: 'workspace_binding', content: 'Bound workspace' });
  prepared.metadata.workspaceDir = '/actual/worktree';
  f.bus.begin(prepared, original);
  assert.equal(f.bus.list()[0].workspaceDir, '/actual/worktree');
  f.bus.end('a', 't-a', false); f.bus.notify('a', { key: 'room', content: 'new message', wake: true }); await tick();
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0].prefixMessages, original.prefixMessages);
  f.bus.close();
});

test('a late message after the last boundary is delivered by a new turn instead of being dropped', async () => {
  const f = fixture(); f.bus.begin(request()); assert.deepEqual(f.bus.take('a'), []);
  f.bus.notify('a', { key: 'room', content: 'late', wake: true });
  f.bus.end('a', 't-a', false); await tick(); assert.equal(f.runs.length, 1);
  f.bus.begin(f.runs[0]); assert.match(f.bus.take('a')[0].message.content, /late/); f.bus.close();
});

test('host maintenance postpones wake until its guard is released, without polling', async () => {
  let busy = true; const runs = [];
  const bus = new RuntimeConversations({ busy: () => busy, signal() {}, error(error) { throw error; }, run: async request => { runs.push(request); } });
  bus.begin(request()); bus.end('a', 't-a', false); bus.notify('a', { key: 'room', content: 'pending', wake: true });
  await tick(); assert.equal(runs.length, 0);
  busy = false; bus.settled(); await tick(); assert.equal(runs.length, 1); bus.close();
});

test('a failed automatic admission cannot stop a newer human turn', async () => {
  const gate = Promise.withResolvers(); const errors = [];
  const bus = new RuntimeConversations({ busy: () => false, signal() {}, error: error => errors.push(error), run: () => gate.promise });
  bus.begin(request()); bus.end('a', 't-a', false); bus.notify('a', { key: 'room', content: 'pending', wake: true }); await tick();
  bus.begin({ ...request(), turnId: 'human-new' }); gate.reject(Error('Human won admission')); await tick();
  assert.equal(bus.list()[0].status, 'running'); assert.deepEqual(errors, []); bus.close();
});

const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence,
  kind, createdAt: '2026-10-18T04:00:00Z', ...payload });

test('peer wake and child budgets exclude incremental checkpoint rounds and resume actual work', async t => {
  for (const limits of [{ peerMessageWake: true }, { pluginAgentMaxTurns: 1 }]) {
    const store = new SessionStore();
    for (let i = 0; i < 9; i++) store.commitTurn('audit', { turnId: `old-${i}`, turnSequence: i + 1,
      createdAt: '2026-10-18T04:00:00Z', completedAt: '2026-10-18T04:00:00Z', status: 'completed', reason: 'model_response_completed', usage: {},
      messages: [{ messageId: `old-user-${i}`, turnId: `old-${i}`, turnSequence: i + 1, messageIndex: 0, createdAt: '2026-10-18T04:00:00Z', message: { role: 'user', content: `Inspect source ${i}` } }] });
    let checkpointCalls = 0, taskCalls = 0;
    const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
      countInputTokens: async req => ({ source: 'provider', inputTokens: req.messages.some(m => m.role === 'tool' && m.content.includes('summarized_turns')) ? 1000 : 260000 }),
      async *stream(req) {
        if (req.messages.some(m => m.name === 'context_pressure')) {
          const source = checkpointCalls++;
          yield event(req, 0, 'tool_call_delta', { index: 0, toolCallId: `checkpoint-${source}`, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ updates: [{ source, summary: `Source ${source} was inspected.` }] }) });
          yield event(req, 1, 'response_completed', { finishReason: 'tool_calls' });
        } else {
          taskCalls++; yield event(req, 0, 'text_delta', { delta: 'Coordination handled.' }); yield event(req, 1, 'response_completed', { finishReason: 'stop' });
        }
      },
    } });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const terminal = await host.runSessionTurn({ ...request('audit', { contextWindowTokens: 400000, ...limits }), maxOutputTokens: 128000 });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
    assert.equal(checkpointCalls, 9); assert.equal(taskCalls, 1);
  }
});

test('exhausting the peer work budget stops the turn instead of reporting completed coordination', async t => {
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'observe', inputSchema: { type: 'object' } }, decodeInput: value => value, execute: () => ({ checked: true }),
    manifest: { effect_kind: 'observation', operation: 'fixture.observe', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: false } });
  let calls = 0;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, provider: { async *stream(req) {
    calls++; yield event(req, 0, 'tool_call_delta', { index: 0, toolCallId: `check-${calls}`, nameDelta: 'observe', argumentsDelta: '{}' });
    yield event(req, 1, 'response_completed', { finishReason: 'tool_calls' });
  } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn({ ...request('budget', { peerMessageWake: true }), tools: registry.definitions() });
  assert.equal(calls, 8); assert.equal(terminal.payload.status, 'stopped');
  assert.equal(terminal.payload.reason, 'peer_coordination_turn_limit');
});
