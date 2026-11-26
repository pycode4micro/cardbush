import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentInteractions, SubagentTaskStore, LocalSubagentInteractions, InMemoryRuntimeEventLog,
  InMemoryRuntimeHost, ToolRegistry, FileSubagentTaskPersistence, registerSubagentTool } from '../dist/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const start = (tasks, taskId = 'child-task', extra = {}) => tasks.start({ taskId, parentSessionId: 'parent', parentTurnId: 'parent-turn',
  childSessionId: 'child', childTurnId: taskId, prompt: 'work', inheritContext: true, inheritedMessageCount: 0, ...extra });
const context = (sessionId = 'parent', metadata = {}) => ({ sessionId, turnId: 'parent-turn', turn: { request: { metadata } } });
const control = (task, operation, rest = {}) => ({ profile: 'subagent-remote-proton', version: '0.1', contextId: task.childSessionId, taskId: task.taskId, operation, ...rest });

test('remote queued admission stays queued until worker execution is observed', async () => {
  const tasks = new SubagentTaskStore(), registry = new ToolRegistry(), completion = Promise.withResolvers();
  const remote = { connectionId: 'remote', agentId: 'instance' };
  start(tasks, 'active', { remote });
  let submitted;
  const dispatcher = registerSubagentTool(registry, tasks, async () => assert.fail('local execution'), { asyncDispatch: true, remoteAgents: {
    list: async () => [{ id: 'remote', name: 'Remote', agentId: 'instance' }],
    run: async (request, signal, accepted) => { submitted = request; accepted(); await completion.promise; return { status: 'completed', finalResponse: 'done', errorMessage: '', usage: {} }; },
    control: async ({ control }) => ({ contextId: control.contextId, taskId: control.taskId, cursor: 1, state: 'queued',
      progress: { phase: 'queued', text: '', completedActions: 0, failedActions: 0 }, interactions: [] }),
  } });
  try {
    const result = await dispatcher.dispatch({ ...context(), toolCall: { id: 'queue-call' },
      input: { taskId: 'active', mode: 'fork', prompt: 'Follow-up', delivery: 'queue' } });
    assert.equal(submitted.queue, true); assert.equal(result.status, 'queued');
    assert.equal(result.delivery, 'queue'); assert.equal(result.executionStarted, false);
    let task = tasks.get('parent', result.taskId);
    assert.equal(task.queuedAfterTaskId, 'active'); assert.ok(task.remoteAcceptedAt); assert.equal(task.executionStartedAt, undefined);
    tasks.observe('parent', task.taskId, { ...task.observation, contextId: task.childSessionId, taskId: task.taskId, cursor: 2, state: 'working',
      progress: { phase: 'working', text: '', completedActions: 0, failedActions: 0 }, interactions: [] });
    task = tasks.get('parent', result.taskId);
    assert.ok(task.executionStartedAt, 'execution requires a worker observation, not admission');
    const startedAt = task.executionStartedAt;
    tasks.observe('parent', task.taskId, task.observation, 'connection interrupted');
    assert.equal(tasks.get('parent', task.taskId).executionStartedAt, startedAt);
  } finally { completion.resolve(); }
});

test('restored remote result subscriptions observe the original task without submitting it again', async () => {
  const events = [], persistence = { load: () => events, append: event => events.push(event) };
  let tasks = new SubagentTaskStore({ persistence });
  const task = start(tasks, 'remote-task', { remote: { connectionId: 'remote', agentId: 'instance' } });
  tasks.delivery.watch('parent', task); tasks = new SubagentTaskStore({ persistence });
  let submits = 0, reads = 0;
  const dispatcher = registerSubagentTool(new ToolRegistry(), tasks, async () => assert.fail('local dispatch'), { remoteAgents: {
    list: async () => [], run: async () => { submits++; throw Error('must not resubmit'); },
    control: async ({ control }) => ({ contextId: control.contextId, taskId: control.taskId, cursor: 9, state: 'completed',
      progress: { phase: 'completed', text: '', completedActions: 1, failedActions: 0 }, interactions: [] }),
    read: async () => { reads++; return { sessionId: 'child', turns: [{ turnId: 'remote-task', reason: 'completed', usage: {},
      messages: [{ messageId: 'final', message: { role: 'assistant', toolCalls: [], content: 'Original remote result' } }] }] }; },
  } });
  await dispatcher.refreshResults('parent');
  tasks.delivery.restoreWatching('parent', tasks.list('parent'));
  assert.equal(tasks.delivery.ready('parent').length, 1);
  assert.equal(tasks.get('parent', task.taskId).finalResponse, 'Original remote result');
  await dispatcher.refreshResults('parent');
  assert.equal(reads, 1); assert.equal(submits, 0); assert.equal(tasks.list('parent').length, 1);
});

test('shared admission rejects foreign owners, child callers, unsupported operations and duplicate mutations', async () => {
  const tasks = new SubagentTaskStore(), task = start(tasks); let calls = 0, queues = 0;
  const adapter = { capabilities: { operations: ['insert', 'queue', 'cancel'] }, control: async () => { calls++; return { accepted: true }; } };
  const channel = new SubagentInteractions(tasks, () => adapter, async () => { queues++; return { taskId: 'queued' }; });
  const insert = control(task, 'message', { delivery: 'insert', messageId: 'first', text: 'Stay read-only' });
  await assert.rejects(channel.control(context('other'), insert), /does not belong/);
  await assert.rejects(channel.control(context('parent', { agentRole: 'child' }), insert), /child|Child/);
  await assert.rejects(channel.control(context('parent', { toolExecutionPolicy: 'web_restricted' }), insert), /forbidden/);
  await assert.rejects(channel.control(context(), { ...insert, contextId: 'other' }), /does not belong/);
  await assert.rejects(channel.control(context(), control(task, 'observe', { waitMs: 0 })), /unavailable/);
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all([channel.control(context(), insert), channel.control(context(), insert)]), [{ accepted: true }, { accepted: true }]);
  assert.equal(calls, 1);
  await assert.rejects(channel.control(context(), { ...insert, text: 'Different instruction' }), /idempotency_conflict/);
  const queue = { ...insert, delivery: 'queue', messageId: 'next' };
  await Promise.all([channel.control(context(), queue), channel.control(context(), queue)]);
  assert.equal(queues, 1);
  const cancel = control(task, 'cancel', { messageId: 'stop' });
  await channel.control(context(), cancel); await channel.control(context(), cancel);
  assert.equal(calls, 3, 'repeated cancellation reconciles live state');
  await assert.rejects(channel.control(context(), { ...queue, messageId: 'stop' }), /idempotency_conflict/);
});

test('provider call IDs can repeat in later parent turns without losing messages', async () => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), task = start(tasks), messages = [];
  const dispatcher = registerSubagentTool(registry, tasks, async () => { throw Error('must not launch'); }, {
    guideChild: async request => { messages.push(request); return { accepted: true }; },
  });
  const send = (turnId, prompt) => dispatcher.dispatch({ ...context(), turnId, toolCall: { id: 'call-1' },
    input: { taskId: task.taskId, mode: 'fork', prompt, delivery: 'insert' } });
  await send('first', 'First guidance'); await send('next', 'Next guidance'); await send('next', 'Next guidance');
  assert.equal(messages.length, 2); assert.notEqual(messages[0].messageId, messages[1].messageId);
  await assert.rejects(send('next', 'Different payload'), /idempotency_conflict/);
});

test('local observations isolate routed permissions and canceling a wait never cancels the child', async () => {
  const tasks = new SubagentTaskStore(), task = start(tasks), events = new InMemoryRuntimeEventLog();
  let answers = 0, stops = 0;
  const adapter = new LocalSubagentInteractions(tasks, events, { answerQuestion: () => {}, answerPermission: () => { answers++; },
    hasPermission: () => true, stop: async () => { stops++; } });
  const append = (id, source, routing) => events.append({ requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn' }, {
    kind: 'permission_requested', payload: { permissionId: id, toolCallId: id, reason: 'Read protected content', actions: ['read'],
      targets: [{ kind: 'opaque', value: 'fixture://private' }], requestedCapabilityIds: ['fixture:read'], sourceSessionId: source,
      sourceTurnId: 'child-task', permissionRouting: routing } });
  append('sibling', 'sibling', 'parent'); append('human', 'child', 'user');
  let observation = await adapter.control(task, control(task, 'observe', { waitMs: 0 }));
  assert.deepEqual(observation.interactions.map(item => item.interactionId), ['human']);
  const permission = observation.interactions[0];
  const reply = control(task, 'respond', { messageId: 'reply', response: { kind: 'permission', interactionId: 'human', actionDigest: permission.actionDigest, decision: 'allow_once' } });
  await assert.rejects(adapter.control(task, reply), /human_authority_required/);
  await assert.rejects(adapter.control(task, { ...reply, response: { kind: 'answer', interactionId: 'human', text: 'approved' } }), /structured_permission_required/);
  await assert.rejects(adapter.control(task, { ...reply, response: { ...reply.response, actionDigest: 'sha256:' + '0'.repeat(64) } }), /action_changed/);
  assert.equal(answers, 0);
  const abort = new AbortController();
  const waiting = adapter.control(task, control(task, 'observe', { after: observation.cursor, waitMs: 30000 }), abort.signal);
  abort.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(stops, 0); assert.equal(tasks.get('parent', task.taskId).status, 'running');
  await adapter.control(task, { ...reply, response: { ...reply.response, decision: 'deny' } });
  assert.equal(answers, 1);
});

function* respond(request, name, args) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  yield name ? { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(), nameDelta: name, argumentsDelta: JSON.stringify(args) }
    : { ...base, sequence: 1, kind: 'text_delta', delta: 'finished' };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: name ? 'tool_calls' : 'stop' };
}
const parentRequest = registry => ({ protocol: 'bush.session_turn_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn', model: 'fixture',
  prefixMessages: [], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Work' } }], tools: registry.definitions(), permissionMode: 'ask_for_approval',
  metadata: { individuation: { habits: false, predictions: false } } });

for (const [routing, requiresHuman] of [['parent', false], ['user', false], ['parent', true]]) test(`local ${routing} permission authority (requires human: ${requiresHuman}) is enforced through the real broker`, { timeout: 15000 }, async t => {
  const delegated = routing === 'parent' && !requiresHuman;
  const tasks = new SubagentTaskStore(), registry = new ToolRegistry(); let parentRound = 0, childRound = 0, effects = 0, deniedHuman = false;
  registry.register({ definition: { name: 'protected_action', inputSchema: { type: 'object' } }, decodeInput: input => input, visibleToChild: true,
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    authorize: () => ({ kind: 'ask', request: { reason: 'Read one protected item', actions: ['read'], targets: [{ kind: 'opaque', value: 'fixture://item' }], capabilityIds: ['fixture:item'], requiresHuman } }),
    execute: () => { effects++; return { read: true }; } });
  const provider = { async *stream(request) {
    if (request.metadata.agentRole === 'child') { yield* respond(request, ++childRound === 1 ? 'protected_action' : undefined, {}); return; }
    if (++parentRound === 1) { yield* respond(request, 'subagent', { prompt: 'Read the item' }); return; }
    if (parentRound === 2) { yield* respond(request, 'await', { mode: 'all' }); return; }
    const task = tasks.list('parent')[0], permission = task.observation?.interactions.find(item => item.kind === 'permission');
    if (parentRound === 3) {
      assert.equal(permission.authority, delegated ? 'parent_delegate' : 'human_required');
      yield* respond(request, 'subagent', { task_id: task.taskId, response: { kind: 'permission', interactionId: permission.interactionId, actionDigest: permission.actionDigest, decision: 'allow_once' } }); return;
    }
    if (!delegated && parentRound === 4) {
      assert.equal(effects, 0); assert.match(request.messages.filter(m => m.role === 'tool').at(-1).content, /human_authority_required/); deniedHuman = true;
      yield* respond(request, 'subagent', { task_id: task.taskId, response: { kind: 'permission', interactionId: permission.interactionId, actionDigest: permission.actionDigest, decision: 'deny' } }); return;
    }
    if (task.status === 'running') yield* respond(request, 'await', { mode: 'all' }); else yield* respond(request);
  } };
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry, subagentTaskStore: tasks,
    subagentPermissionPolicy: { permissionRouting: routing === 'parent' ? 'user' : 'parent', childPermissionMode: 'ask_for_approval' } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const request = parentRequest(registry);
  request.metadata.subagentPermissionRouting = routing;
  const terminal = await host.runSessionTurn(request, { signal: AbortSignal.timeout(12000) });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(effects, delegated ? 1 : 0);
  assert.equal(deniedHuman, !delegated);
  const task = tasks.list('parent')[0];
  const answered = [...host.events('parent', 'parent-turn'), ...host.events(task.childSessionId, task.childTurnId)].filter(event => event.kind === (delegated ? 'permission_answered' : 'permission_rejected'));
  assert.equal(answered.length, 1);
  if (delegated) assert.deepEqual(answered[0].payload.grantedCapabilityIds, ['fixture:item']);
  else assert.equal(answered[0].payload.reason, 'user_rejected');
});

test('reopening local task journals settles interrupted queue entries without replaying work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'child-queue-'));
  let persistence = new FileSubagentTaskPersistence({ root }), tasks = new SubagentTaskStore({ persistence });
  t.after(() => { persistence.close(); assert.ok(root.startsWith(join(tmpdir(), 'child-queue-'))); rmSync(root, { recursive: true, force: true }); });
  const first = start(tasks); start(tasks, 'queued', { queuedAfterTaskId: first.taskId, resumedFromTaskId: first.taskId });
  persistence.close(); persistence = new FileSubagentTaskPersistence({ root });
  tasks = new SubagentTaskStore({ persistence });
  let round = 0;
  const registry = new ToolRegistry(), host = new InMemoryRuntimeHost({ toolRegistry: registry, subagentTaskStore: tasks, provider: { async *stream(request) {
    assert.notEqual(request.metadata.agentRole, 'child');
    if (++round === 1) yield* respond(request, 'tasks', { action: 'list' }); else yield* respond(request);
  } } });
  const result = await host.runSessionTurn(parentRequest(registry));
  assert.equal(result.payload.status, 'completed');
  assert.deepEqual(tasks.list('parent').map(task => task.status), ['stopped', 'stopped']);
  assert.match(tasks.get('parent', 'queued').errorMessage, /no work was replayed/);
});
