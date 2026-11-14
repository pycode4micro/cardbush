import { RuntimeTaskTools } from '../dist/taskTools.js';
import { RuntimeTurnSignals } from '../dist/turnSignals.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntimeHost, SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, registerSubagentTool } from '../dist/index.js';

function fixture(run, { autoAccept = true, control } = {}) {
  const registry = new ToolRegistry(); const tasks = new SubagentTaskStore(); let serial = 0;
  const results = new Map(); const requests = [];
  const target = { id: 'saved-http-agent', name: 'Build server', agentId: 'pinned-agent' };
  const dispatcher = registerSubagentTool(registry, tasks, async () => { throw Error('Must not run locally'); }, {
    inheritBrowserScope: async () => { assert.fail('Remote tasks must not inherit local browser grants'); },
    createTaskId: () => `remote-${++serial}`, asyncDispatch: true,
    remoteAgents: { list: async () => [target], ...(control ? { control } : {}), run: (input, signal, onAccepted) => { requests.push(input); if (autoAccept) onAccepted(); return run(input, signal, onAccepted); } },
    onAsyncResult: item => results.set(item.taskId, item.result),
  });
  const signals = new RuntimeTurnSignals();
  const observer = new RuntimeTaskTools((context, promises, mode, signal, duration) => signals.wait(context.sessionId, context.turnId, promises, mode, signal, duration));
  observer.addSource(context => tasks.list(context.sessionId).map(task => ({ task_id: task.taskId, kind: 'subagent', status: task.status, revision: String(task.revision), result: task.finalResponse,
    wait: signal => tasks.waitForCompletion(context.sessionId, task.taskId, signal) })));
  observer.register(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected permission'); } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent-session', turnId: 'parent-turn', model: 'local-model', permissionMode: 'task_free',
    messages: [], tools: registry.definitions(), metadata: { uiLanguage: 'en', secret: 'never-forward' } };
  let calls = 0;
  const invoke = (name, args, parent = request, signal) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++calls}`, name, argumentsText: JSON.stringify(args) },
    { requestId: parent.requestId, sessionId: parent.sessionId, turnId: parent.turnId, round: 1, ordinal: 0 }, signal,
    { request: parent, contextMessages: [{ role: 'system', content: 'private parent history' }] });
  return { tasks, requests, results, target, request, invoke, dispatcher };
}
const completed = text => ({ status: 'completed', finalResponse: text, errorMessage: '', usage: { inputTokens: 3, outputTokens: 2 } });

test('remote dispatch waits for acceptance, not completion, and never observes an unsubmitted task', async () => {
  let accept, finish, returned = false, observations = 0;
  const f = fixture((_input, _signal, onAccepted) => {
    accept = onAccepted; return new Promise(resolve => { finish = resolve; });
  }, { autoAccept: false, control: async () => { observations++; throw Error('fixture observer'); } });
  const dispatch = f.invoke('subagent', { prompt: 'Review', target_agent: f.target.id, run_in_background: true }).then(value => { returned = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(typeof accept, 'function');
  assert.equal(returned, false, 'a local handle is not a successful remote submission');
  assert.equal(observations, 0);
  assert.equal(f.tasks.list('parent-session')[0].remoteAcceptedAt, undefined);
  accept();
  const receipt = await dispatch;
  assert.equal(receipt.result.status, 'running');
  assert.ok(f.tasks.get('parent-session', receipt.result.taskId).remoteAcceptedAt);
  finish(completed('done'));
  await f.results.get(receipt.result.taskId);
});

test('remote admission rejection is returned immediately without a running receipt or duplicate notification', async () => {
  const f = fixture(async () => { throw Error('permission routing unsupported'); }, { autoAccept: false });
  const receipt = await f.invoke('subagent', { prompt: 'Review', target_agent: f.target.id });
  assert.equal(receipt.result.status, 'failed');
  assert.match(receipt.result.errorMessage, /permission routing unsupported/);
  assert.equal(f.results.size, 0);
  assert.equal(f.tasks.get('parent-session', receipt.result.taskId).remoteAcceptedAt, undefined);
});

for (const scenario of [
  { status: 'completed' }, { status: 'failed' }, { status: 'stopped' }, { status: 'unavailable' },
  { status: 'completed', asynchronous: true }, { status: 'failed', asynchronous: true },
]) test(`ordinary ${scenario.asynchronous ? 'asynchronous' : 'terminal'} ${scenario.status} receipt makes no duplicate model request`, async t => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), requests = [];
  const finish = Promise.withResolvers(), replyStarted = Promise.withResolvers(), releaseReply = Promise.withResolvers();
  const result = { status: scenario.status, finalResponse: scenario.status === 'completed' ? 'Verified probe result.' : '',
    errorMessage: scenario.status === 'failed' ? 'credential_key_file_required' : '', usage: {} };
  let dispatched = 0;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, subagentTaskStore: tasks,
    dataRoot: mkdtempSync(join(tmpdir(), 'ordinary-terminal-receipt-')),
    remoteAgents: { list: async () => [{ id: 'remote', name: 'Remote', agentId: 'worker' }],
      run: async (_input, _signal, onAccepted) => {
        dispatched++;
        if (!scenario.asynchronous) return result;
        onAccepted(); return finish.promise;
      } },
    provider: { async *stream(request) {
      const round = requests.length; requests.push(request);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      if (round === 1) { replyStarted.resolve(); await releaseReply.promise; }
      yield round === 0 ? { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'probe', nameDelta: 'subagent',
        argumentsDelta: JSON.stringify({ target_agent: 'remote', prompt: 'Read-only probe' }) }
        : { ...base, sequence: 0, kind: 'text_delta', delta: 'Receipt reported.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: round === 0 ? 'tool_calls' : 'stop' };
    } } });
  t.after(async () => { finish.resolve(result); releaseReply.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); });
  const turn = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: `request-${turnId}`, sessionId: 'parent', turnId,
    model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: `input-${turnId}`, message: { role: 'user', content: 'Check the probe' } }],
    tools: registry.definitions(), permissionMode: 'task_free', metadata: {} });
  const pending = host.runSessionTurn(turn('first'));
  await replyStarted.promise;
  const receipt = JSON.parse(requests[1].messages.find(message => message.toolCallId === 'probe').content);
  assert.equal(receipt.status, scenario.asynchronous ? 'running' : scenario.status);
  finish.resolve(result); await new Promise(resolve => setImmediate(resolve));
  releaseReply.resolve();
  assert.equal((await pending).payload.status, 'completed');
  const expected = scenario.asynchronous ? 3 : 2;
  assert.equal(requests.length, expected, 'terminal receipts do not schedule a second result response');
  assert.equal(dispatched, 1);
  const notices = requests.at(-1).messages.filter(message => message.name === 'subagent_result');
  assert.equal(notices.length, scenario.asynchronous ? 1 : 0);
  if (scenario.asynchronous) assert.match(notices[0].content, new RegExp(`status="${scenario.status}"`));
  assert.equal((await host.runSessionTurn(turn('next'))).payload.status, 'completed');
  assert.equal(requests.length, expected + 1, 'the next user turn must not replay a consumed completion');
  assert.equal(requests.at(-1).messages.filter(message => message.name === 'subagent_result').length, notices.length);
  assert.equal(dispatched, 1);
});

test('tasks inspect preserves a rejected submission without querying a nonexistent remote job', async t => {
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  let round = 0, observations = 0, inspected;
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, subagentTaskStore: tasks,
    remoteAgents: { list: async () => [{ id: 'remote', name: 'Remote', agentId: 'worker' }],
      run: async () => { throw Error('approval routing unsupported'); },
      control: async () => { observations++; throw Error('This worker task belongs to another parent.'); } },
    provider: { async *stream(request) {
      round++;
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      const call = round === 1 ? ['subagent', { target_agent: 'remote', prompt: 'Review' }]
        : round === 2 ? ['tasks', { action: 'inspect', task_ids: [tasks.list('parent')[0].taskId] }] : undefined;
      if (!call) inspected = JSON.parse(request.messages.filter(message => message.role === 'tool').at(-1).content);
      yield call ? { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `call-${round}`, nameDelta: call[0], argumentsDelta: JSON.stringify(call[1]) }
        : { ...base, sequence: 0, kind: 'text_delta', delta: 'Submission rejected.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'parent', turnId: 'turn',
    model: 'fixture', prefixMessages: [], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Delegate only' } }],
    tools: registry.definitions(), permissionMode: 'task_free', metadata: {} });
  assert.equal(result.payload.status, 'completed');
  assert.equal(round, 3);
  assert.equal(observations, 0);
  assert.match(inspected.tasks[0].result.error, /approval routing unsupported/);
  assert.equal(inspected.tasks[0].result.observation_error, undefined);
  assert.equal(inspected.tasks[0].controls.stop, false);
});

test('failed remote onStarted settles the journal without starting remote work', async () => {
  const f = fixture(async () => assert.fail('must not dispatch after persistence failure'));
  const result = await f.dispatcher.dispatch({ input: { prompt: 'Report', targetAgent: f.target.id },
    sessionId: 'parent-session', turnId: 'parent-turn', turn: { request: f.request, contextMessages: [] } }, {
    waitForResult: true, onStarted: async ({ taskId, sessionId }) => {
      assert.equal(f.tasks.get('parent-session', taskId).childSessionId, sessionId);
      throw Error('node persistence unavailable');
    },
  });
  assert.equal(result.status, 'failed'); assert.match(result.errorMessage, /node persistence unavailable/);
  assert.equal(f.requests.length, 0); assert.equal(f.tasks.list('parent-session')[0].status, 'failed');
});

test('remote subagents dispatch asynchronously, join any/all, and resume the same remote session', async () => {
  const pending = []; const f = fixture(input => new Promise(resolve => pending.push({ input, resolve })));
  const options = await f.invoke('list_subagent_options', {});
  assert.equal(options.result.remote_agents[0].id, f.target.id);
  const first = await f.invoke('subagent', { prompt: 'Review build', target_agent: f.target.id });
  assert.equal(first.kind, 'returned'); assert.equal(first.result.status, 'running');
  assert.equal(f.requests[0].language, 'en');
  assert.doesNotMatch(JSON.stringify(f.requests), /private parent history|never-forward|local-model/);
  const invalidResume = await f.invoke('subagent', { prompt: 'Continue', task_id: first.result.taskId });
  assert.equal(invalidResume.kind, 'failed');
  const second = await f.invoke('subagent', { prompt: 'Check docs', target_agent: f.target.id });
  pending[1].resolve(completed('Docs checked'));
  const any = await f.invoke('await', { task_ids: [first.result.taskId, second.result.taskId] });
  assert.deepEqual(any.result.tasks.filter(task => task.status === 'completed').map(task => task.task_id), [second.result.taskId]);
  assert.equal(f.tasks.get('parent-session', first.result.taskId).status, 'running');
  pending[0].resolve(completed('Build checked'));
  const all = await f.invoke('await', { task_ids: [first.result.taskId, second.result.taskId], mode: 'all' });
  assert.equal(all.result.tasks.filter(task => task.status === 'completed').length, 2);
  const resumed = await f.invoke('subagent', { prompt: 'Inspect follow-up', task_id: first.result.taskId });
  assert.equal(resumed.result.childSessionId, first.result.childSessionId);
  assert.notEqual(resumed.result.childTurnId, first.result.childTurnId);
  pending[2].resolve(completed('Follow-up checked')); await f.results.get(resumed.result.taskId);
  assert.equal(f.tasks.get('parent-session', resumed.result.taskId).remote.agentId, 'pinned-agent');
});

test('remote delegation rejects mixed configuration, cross-parent resume and changed identity', async () => {
  const f = fixture(async () => completed('done'));
  assert.equal((await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id, mode: 'fork' })).kind, 'failed');
  const result = await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id }); await f.results.get(result.result.taskId);
  assert.equal((await f.invoke('subagent', { prompt: 'x', task_id: result.result.taskId }, { ...f.request, sessionId: 'other-parent' })).kind, 'failed');
  f.target.agentId = 'changed-agent';
  assert.equal((await f.invoke('subagent', { prompt: 'x', task_id: result.result.taskId })).kind, 'failed');
  assert.equal(f.requests.length, 1);
});

test('an unconfirmed remote cancellation is a failure, not a false stopped result', async () => {
  const f = fixture(async () => { throw Error('Remote cancellation could not be confirmed'); });
  const result = await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id });
  await f.results.get(result.result.taskId);
  assert.equal(f.tasks.get('parent-session', result.result.taskId).status, 'failed');
});

test('remote delegation respects the configured child permission ceiling', async () => {
  const f = fixture(async () => completed('done'));
  const request = { ...f.request, permissionMode: 'user_free', metadata: { ...f.request.metadata, subagentPermissionRouting: 'parent', childAgentPolicy: { childPermissionMode: 'task_free' } } };
  const result = await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id }, request);
  await f.results.get(result.result.taskId);
  assert.equal(f.requests[0].permissionMode, 'task_free');
  assert.equal(f.requests[0].permissionRouting, 'parent');
  const resumed = await f.invoke('subagent', { prompt: 'Continue', task_id: result.result.taskId }, request);
  await f.results.get(resumed.result.taskId);
  assert.equal(f.requests[1].permissionRouting, 'parent');
  const userRequest = { ...request, metadata: { ...request.metadata, subagentPermissionRouting: 'user' } };
  const human = await f.invoke('subagent', { prompt: 'Continue with human approval', task_id: resumed.result.taskId }, userRequest);
  await f.results.get(human.result.taskId);
  assert.equal(f.requests[2].permissionRouting, 'user');
});
