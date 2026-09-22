import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentTaskStore, ToolRegistry, ToolExecutionCoordinator, registerSubagentTool } from '../dist/index.js';

function fixture(run) {
  const registry = new ToolRegistry(); const tasks = new SubagentTaskStore(); let serial = 0;
  const results = new Map(); const requests = [];
  const target = { id: 'saved-http-agent', name: 'Build server', agentId: 'pinned-agent' };
  registerSubagentTool(registry, tasks, async () => { throw Error('Must not run locally'); }, {
    createTaskId: () => `remote-${++serial}`, asyncDispatch: true,
    remoteAgents: { list: async () => [target], run: (input, signal) => { requests.push(input); return run(input, signal); } },
    onAsyncResult: item => results.set(item.taskId, item.result),
    awaitAsyncResults: async ({ taskIds, mode }) => {
      const promises = taskIds.map(taskId => results.get(taskId).then(message => ({ taskId, message })));
      return mode === 'all' ? Promise.all(promises) : [await Promise.race(promises)];
    },
  });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected permission'); } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent-session', turnId: 'parent-turn', model: 'local-model', permissionMode: 'task_free',
    messages: [], tools: registry.definitions(), metadata: { uiLanguage: 'en', secret: 'never-forward' } };
  let calls = 0;
  const invoke = (name, args, parent = request, signal) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++calls}`, name, argumentsText: JSON.stringify(args) },
    { requestId: parent.requestId, sessionId: parent.sessionId, turnId: parent.turnId, round: 1, ordinal: 0 }, signal,
    { request: parent, contextMessages: [{ role: 'system', content: 'private parent history' }] });
  return { tasks, requests, results, target, request, invoke };
}
const completed = text => ({ status: 'completed', finalResponse: text, errorMessage: '', usage: { inputTokens: 3, outputTokens: 2 } });

test('remote subagents dispatch asynchronously, join any/all, and resume the same remote session', async () => {
  const pending = []; const f = fixture(input => new Promise(resolve => pending.push({ input, resolve })));
  const options = await f.invoke('list_subagent_options', {});
  assert.equal(options.result.remote_agents[0].id, f.target.id);
  const first = await f.invoke('subagent', { prompt: 'Review build', target_agent: f.target.id });
  assert.equal(first.kind, 'returned'); assert.equal(first.result.status, 'running');
  assert.equal(f.requests[0].language, 'en');
  assert.doesNotMatch(JSON.stringify(f.requests), /private parent history|never-forward|local-model/);
  const invalidResume = await f.invoke('subagent', { prompt: 'Continue', resume_task_id: first.result.taskId });
  assert.equal(invalidResume.kind, 'failed');
  const second = await f.invoke('subagent', { prompt: 'Check docs', target_agent: f.target.id });
  pending[1].resolve(completed('Docs checked'));
  const any = await f.invoke('await_subagents', { task_ids: [first.result.taskId, second.result.taskId] });
  assert.deepEqual(any.result.taskIds, [second.result.taskId]);
  assert.equal(f.tasks.get('parent-session', first.result.taskId).status, 'running');
  pending[0].resolve(completed('Build checked'));
  const all = await f.invoke('await_subagents', { task_ids: [first.result.taskId, second.result.taskId], mode: 'all' });
  assert.equal(all.result.count, 2);
  const resumed = await f.invoke('subagent', { prompt: 'Inspect follow-up', resume_task_id: first.result.taskId });
  assert.equal(resumed.result.childSessionId, first.result.childSessionId);
  assert.notEqual(resumed.result.childTurnId, first.result.childTurnId);
  pending[2].resolve(completed('Follow-up checked')); await f.results.get(resumed.result.taskId);
  assert.equal(f.tasks.get('parent-session', resumed.result.taskId).remote.agentId, 'pinned-agent');
});

test('remote delegation rejects mixed configuration, cross-parent resume and changed identity', async () => {
  const f = fixture(async () => completed('done'));
  assert.equal((await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id, mode: 'fork' })).kind, 'failed');
  const result = await f.invoke('subagent', { prompt: 'x', target_agent: f.target.id }); await f.results.get(result.result.taskId);
  assert.equal((await f.invoke('subagent', { prompt: 'x', resume_task_id: result.result.taskId }, { ...f.request, sessionId: 'other-parent' })).kind, 'failed');
  f.target.agentId = 'changed-agent';
  assert.equal((await f.invoke('subagent', { prompt: 'x', resume_task_id: result.result.taskId })).kind, 'failed');
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
});
