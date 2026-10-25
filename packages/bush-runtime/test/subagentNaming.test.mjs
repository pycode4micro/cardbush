import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentToolActivity, resolveSubagentName } from '@cardbush/bush-protocol';
import { FileSubagentTaskPersistence, SubagentTaskStore, ToolExecutionCoordinator, ToolRegistry, registerSubagentTool } from '../dist/index.js';
import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import { summarizeExecution } from '../dist/executionHistory.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';

function childResult(request) {
  return { terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'answer' } },
    session: { turns: [{ turnId: request.turnId, messages: [{ messageId: 'answer', message: { role: 'assistant', content: 'Done' } }] }] } };
}

function fixture(options = {}, tasks = new SubagentTaskStore(), runChild = async request => childResult(request)) {
  const registry = new ToolRegistry(), saved = new Map(), requests = []; let sequence = 0;
  registerSubagentTool(registry, tasks, async request => { requests.push(request); return runChild(request); }, {
    createTaskId: () => `task-${++sequence}`,
    saveChildRequest: async request => { saved.set(request.sessionId, request); },
    loadChildRequest: async id => saved.get(id), ...options,
  });
  const prefix = [{ role: 'system', content: 'Frozen instructions' }, { role: 'user', content: 'Original user objective' }];
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission'); } } });
  const request = { requestId: 'r', sessionId: 'parent', turnId: 'turn', model: 'fixture', tools: registry.definitions(), metadata: {}, permissionMode: 'task_free' };
  const invoke = args => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'subagent', argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId: 'parent', turnId: 'turn', round: 1, ordinal: 0 }, undefined,
    { request, contextMessages: prefix });
  return { invoke, tasks, requests, prefix, request, registry };
}

test('the common model catalog exposes child naming without advanced schema recall', async () => {
  const f = fixture();
  registerBuiltinToolDisclosure(f.registry);
  f.request.tools = f.registry.definitions();
  const original = structuredClone(f.request.tools);
  const projected = modelToolDefinitions(f.registry, f.request);
  const subagent = projected.find(tool => tool.name === 'subagent');
  assert.deepEqual(subagent.inputSchema.properties.name, f.registry.resolve('subagent').definition.inputSchema.properties.name);
  assert.equal(subagent.inputSchema.properties.name.type, 'string');
  assert.match(subagent.description, /short responsibility name/);
  assert.equal(subagent.inputSchema.properties.system_prompt, undefined, 'advanced clean configuration stays deferred');
  const result = await f.invoke({ name: '接口检查', prompt: 'Inspect every changed API and report the findings.' });
  assert.equal(result.kind, 'returned');
  assert.equal(result.result.agentName, '接口检查');
  assert.deepEqual(modelToolDefinitions(f.registry, f.request), projected, 'dispatch does not change frozen declarations');
  assert.deepEqual(f.request.tools, original);
});

test('a named ad-hoc fork retains its exact inherited prefix, name and identity through continuation', async () => {
  const f = fixture();
  const first = await f.invoke({ name: '接口审查', prompt: 'Review the API boundaries' });
  assert.equal(first.kind, 'returned');
  assert.equal(first.result.agentName, '接口审查');
  assert.equal(first.result.agentProfileId, undefined, 'a label does not register an employee');
  assert.deepEqual(f.requests[0].prefixMessages, f.prefix);
  assert.equal(f.requests[0].metadata.subagentName, '接口审查');
  const second = await f.invoke({ task_id: first.result.taskId, prompt: 'Review the next change' });
  assert.equal(second.result.childSessionId, first.result.childSessionId);
  assert.equal(second.result.agentName, '接口审查');
  assert.equal(f.tasks.list('parent').length, 2);
  assert.ok(f.tasks.list('parent').every(task => task.agentName === '接口审查'));
  assert.equal(f.requests[1].metadata.subagentName, '接口审查');
  assert.deepEqual(f.requests[1].prefixMessages, f.prefix);
  const invalid = await f.invoke({ task_id: first.result.taskId, prompt: 'next', name: '偷偷改名' });
  assert.equal(invalid.kind, 'failed');
  assert.equal(f.tasks.list('parent').length, 2);
});

test('unsupported memory fails before dispatch and a corrected named clean call creates exactly one child', async () => {
  const f = fixture();
  const args = { name: '视觉设计', prompt: 'Design the palette', mode: 'clean', system_prompt: '你是视觉设计师。只做设计。', allowed_tools: [] };
  const rejected = await f.invoke({ ...args, memory: 'none' });
  assert.equal(rejected.kind, 'failed');
  assert.match(rejected.error.message, /unsupported subagent arguments: memory/);
  assert.equal(rejected.error.details.execution.dispatch, 'not_started');
  assert.equal(f.requests.length, 0);
  assert.equal(f.tasks.list('parent').length, 0);
  const accepted = await f.invoke(args);
  assert.equal(accepted.kind, 'returned');
  assert.equal(accepted.result.agentName, '视觉设计');
  assert.equal(f.tasks.list('parent').length, 1);
  assert.deepEqual(f.requests[0].prefixMessages, [{ role: 'system', content: args.system_prompt }]);
  assert.deepEqual(f.requests[0].tools, []);
  assert.equal(f.requests[0].metadata.registeredAgent, undefined);
});

test('unnamed children use their role or a stable identity, never assignment text', async () => {
  const f = fixture();
  const result = await f.invoke({ prompt: 'Draft three palettes', mode: 'clean', system_prompt: '你是服装视觉与材质设计。后面是完整任务配置。', allowed_tools: [] });
  assert.equal(result.result.agentName, '服装视觉与材质设计');
  const first = await f.invoke({ prompt: 'Review compatibility\nPrivate supporting details' });
  assert.equal(first.result.agentName, `子 Agent ${first.result.childSessionId.slice(-8)}`);
  const second = await f.invoke({ prompt: 'A different assignment', task_id: first.result.taskId });
  assert.equal(second.result.agentName, first.result.agentName);
  assert.equal(second.result.childSessionId, first.result.childSessionId);
  f.request.metadata.uiLanguage = 'en';
  const another = await f.invoke({ prompt: 'Review compatibility\nOther private details' });
  assert.equal(another.result.agentName, `Subagent ${another.result.childSessionId.slice(-8)}`);
  assert.notEqual(another.result.agentName, first.result.agentName);
  assert.equal(f.requests.at(-1).metadata.subagentName, another.result.agentName);
  assert.equal(resolveSubagentName({ name: 'Explicit', systemPrompt: 'You are a reviewer.' }), 'Explicit');
  assert.equal(resolveSubagentName({ systemPrompt: 'You are an API reviewer. Keep it concise.' }), 'API reviewer');
  assert.equal(resolveSubagentName({ name: 'a'.repeat(200) }).length, 80);
  assert.equal(resolveSubagentName({ prompt: 'This message is not an agent name' }), undefined);
  const record = { toolCall: { name: 'subagent', argumentsText: JSON.stringify({ prompt: 'Private assignment text' }) } };
  assert.equal(agentToolActivity(record).name, undefined, 'running activity does not invent a name from the prompt');
  assert.equal(agentToolActivity({ ...record, result: first.result }).name, first.result.agentName);
});

test('invalid labels never start a child', async () => {
  const f = fixture();
  for (const name of ['', '  ', 'a\nb', 'a'.repeat(81), 123, null]) {
    assert.equal((await f.invoke({ name, prompt: 'work' })).kind, 'failed');
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.tasks.list('parent').length, 0);
});

test('async submission, guidance and result messages identify the same named child', async () => {
  let release, completion;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture({ asyncDispatch: true, onAsyncResult: input => { completion = input.result; }, guideChild: async () => ({ status: 'queued' }) },
    undefined, async request => { await pending; return childResult(request); });
  const name = '审查 "接口" & <布局>';
  const started = await f.invoke({ name, prompt: 'Review interfaces' });
  assert.equal(started.result.status, 'running');
  assert.equal(started.result.agentName, name);
  const guidance = await f.invoke({ task_id: started.result.taskId, prompt: 'Also check layouts' });
  assert.equal(guidance.result.agentName, name);
  assert.equal(guidance.result.status, 'message_queued');
  assert.equal(f.tasks.list('parent').length, 1);
  release();
  const message = await completion;
  assert.match(message.content, /agent_name="审查 &quot;接口&quot; &amp; &lt;布局&gt;"/);
  assert.equal(f.tasks.list('parent')[0].agentName, name);
});

test('remote tasks use a connection or task name and keep it when the connection is renamed', async () => {
  let connectionName = '远程审查员';
  const f = fixture({ remoteAgents: { list: async () => [{ id: 'remote', name: connectionName, agentId: 'server' }],
    run: async () => ({ status: 'completed', finalResponse: 'Done', errorMessage: '', usage: {} }) } });
  const first = await f.invoke({ prompt: 'review', target_agent: 'remote' });
  assert.equal(first.result.agentName, '远程审查员');
  connectionName = 'Changed connection';
  const second = await f.invoke({ prompt: 'next', task_id: first.result.taskId });
  assert.equal(second.result.agentName, '远程审查员');
  assert.equal(second.result.childSessionId, first.result.childSessionId);
  assert.equal((await f.invoke({ name: '发布检查', prompt: 'review release', target_agent: 'remote' })).result.agentName, '发布检查');
});

test('names survive task persistence and appear in searchable execution summaries without full instructions', async t => {
  const prefix = join(tmpdir(), 'cardbush-agent-name-');
  const root = mkdtempSync(prefix);
  t.after(() => { assert.ok(root.startsWith(prefix)); rmSync(root, { recursive: true, force: true }); });
  const persistence = new FileSubagentTaskPersistence({ root });
  const f = fixture({}, new SubagentTaskStore({ persistence }));
  const args = { name: '概念策划', prompt: 'Prepare concepts', mode: 'clean', system_prompt: 'PRIVATE_SYSTEM_INSTRUCTIONS', allowed_tools: [] };
  const result = await f.invoke(args);
  persistence.close();
  const reopened = new FileSubagentTaskPersistence({ root });
  try { assert.equal(new SubagentTaskStore({ persistence: reopened }).get('parent', result.result.taskId).agentName, '概念策划'); }
  finally { reopened.close(); }
  const record = { sessionId: 'parent', turnId: 'turn', recordedAt: new Date().toISOString(), outcome: 'returned', workspaceChanges: [],
    toolCall: { id: 'dispatch', name: 'subagent', argumentsText: JSON.stringify(args) }, result: result.result };
  assert.equal(agentToolActivity(record).name, '概念策划');
  const summary = summarizeExecution(record);
  assert.match(summary.summary, /agent: 概念策划/);
  assert.ok(summary.references.includes(result.result.taskId));
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_SYSTEM_INSTRUCTIONS/);
});
