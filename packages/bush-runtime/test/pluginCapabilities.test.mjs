import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolRegistry, ToolExecutionCoordinator, SubagentTaskStore, InMemoryRuntimeHost } from '../dist/index.js';
import { registerMcpDiscovery, modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { PluginHookScopes } from '../dist/pluginHookScopes.js';
import { PluginAgentMemory } from '../dist/pluginAgentMemory.js';
import { PluginAgentEnvironment } from '../dist/pluginAgentEnvironment.js';
import { PluginBackgroundTasks } from '../dist/pluginBackgroundTasks.js';
import { pluginAgentTools } from '../dist/pluginExtensions.js';
import { TaskWorkspaceManager } from '../dist/taskWorkspace.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
const agent = { id: 'demo:reviewer', pluginId: 'demo', root: '.', name: 'reviewer', description: 'Review', prompt: 'Review files' };
const request = (registry, overrides = {}) => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: {}, requestCapabilities: { vision: false, interactiveRequests: false }, ...overrides });
const coordinator = (registry, ask = async () => { throw Error('Unexpected permission'); }) => new ToolExecutionCoordinator({ registry, permissions: { request: ask } });
let serial = 0;
const call = (coordinator, req, name, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) }, { ...req, round: 1, ordinal: serial }, undefined, { request: req, contextMessages: [] });
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-cap-')); t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-cap-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root; }
const mcp = (name, server, execute = () => ({})) => ({ definition: { name, description: `${server} document lookup`, inputSchema: { type: 'object', properties: {} } }, manifest, decodeInput: x => x, execute, mcpHook: { server, tool: 'lookup', call: async () => ({}) } });

test('MCP discovery hides large catalogs, retains permission checks and cannot cross task scopes', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); let executions = 0, asks = 0;
  for (let i = 0; i < 1000; i++) registry.register({ ...mcp(`mcp__service${i}__lookup`, `service${i}`, () => { executions++; return { found: true }; }), authorize: () => ({ kind: 'ask', request: { reason: 'External tool', actions: ['read'], targets: [], capabilityIds: ['mcp'] } }) });
  const req = request(registry, { metadata: { mcpToolDiscovery: true } });
  assert.deepEqual(modelToolDefinitions(registry, req).map(tool => tool.name), ['mcp_search', 'mcp_call']);
  const runner = coordinator(registry, async permission => { asks++; return { decision: 'deny', grantedCapabilityIds: [] }; });
  assert.equal((await call(runner, req, 'mcp__service42__lookup', {})).error.code, 'tool_not_exposed');
  const searched = await call(runner, req, 'mcp_search', { query: '*', server: 'service42' });
  assert.equal(searched.result.matches.length, 1); assert.ok(searched.result.matches[0].inputSchema);
  const denied = await call(runner, req, 'mcp_call', { name: searched.result.matches[0].name, arguments: {} });
  assert.equal(denied.kind, 'failed'); assert.equal(asks, 1); assert.equal(executions, 0);
  const other = request(registry, { sessionId: 'other', metadata: { mcpToolDiscovery: true }, tools: req.tools.filter(tool => !tool.name.includes('service42')) });
  assert.equal((await call(runner, other, 'mcp_search', { query: '*', server: 'service42' })).result.total, 0);
  assert.equal((await call(runner, other, 'mcp_call', { name: 'mcp__service42__lookup', arguments: {} })).kind, 'failed');
  const recovered = request(registry, { metadata: structuredClone(req.metadata) });
  assert.equal((await call(runner, recovered, 'mcp_call', { name: 'mcp__service42__lookup', arguments: {} })).error.code, 'permission_rejected');
});

test('Scoped Hooks persist Skill activation across turns but only load current trusted definitions', async t => {
  const root = await temp(t), scopes = new PluginHookScopes(root), registry = new ToolRegistry();
  const base = { id: 'global', event: 'PreToolUse', trusted: true }, skill = { ...base, id: 'skill', scope: { kind: 'skill', id: 'demo:skill' } }, role = { ...base, id: 'role', scope: { kind: 'agent', id: agent.id } };
  const req = request(registry);
  await Promise.all([scopes.activate('s', 'demo:skill'), scopes.select([base, skill], req)]);
  assert.deepEqual((await new PluginHookScopes(root).select([base, skill, role], req)).map(hook => hook.id), ['global', 'skill']);
  assert.deepEqual((await scopes.select([base, skill, role], request(registry, { sessionId: 'other', metadata: { pluginAgentId: agent.id } }))).map(hook => hook.id), ['global', 'role']);
  assert.equal((await scopes.select([{ ...skill, trusted: false }], req))[0].trusted, false);
  assert.equal((await scopes.select([skill], { ...req, metadata: { disabledSkills: ['demo:skill'] } })).length, 0);
  await scopes.remove('s'); assert.equal((await scopes.select([skill], req)).length, 0);
});

test('MCP dispatch applies Hooks once to the real tool and remains usable in a read-only role', async t => {
  const root = await temp(t), registry = new ToolRegistry(); registerMcpDiscovery(registry); registry.register(mcp('mcp__docs__lookup', 'docs', () => ({ value: 42 })));
  const environment = new PluginAgentEnvironment(root, registry);
  const req = request(registry, { metadata: { mcpToolDiscovery: true } }); const lease = await environment.acquire(req, { ...agent, permissionMode: 'plan', tools: ['mcp__docs__*'] }); t.after(() => lease.release());
  assert.ok(req.tools.some(tool => tool.name === 'mcp_call'));
  const events = [];
  const runner = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected approval'); } }, hooks: { before: async context => { events.push(['before', context.toolCall.name]); return { messages: [] }; }, after: async context => { events.push(['after', context.toolCall.name]); return { messages: [], toolFeedback: 'Scoped feedback' }; } } });
  await call(runner, req, 'mcp_search', { query: 'docs' }); events.length = 0;
  const result = await call(runner, req, 'mcp_call', { name: 'mcp__docs__lookup', arguments: {} });
  assert.deepEqual(events, [['before', 'mcp__docs__lookup'], ['after', 'mcp__docs__lookup']]); assert.equal(result.hookFeedback, 'Scoped feedback');
});

test('Agent memory is persistent, revision protected and confined including symlinks', async t => {
  const root = await temp(t), project = join(root, 'project'), copy = join(root, 'copy'); await mkdir(project); await mkdir(copy);
  const registry = new ToolRegistry(), memory = new PluginAgentMemory(join(root, 'memory'), registry), runner = coordinator(registry);
  const req = request(registry, { prefixMessages: [], metadata: { projectDir: copy, pluginAgentSourceDir: project } });
  await memory.prepare({ ...agent, memory: 'project' }, req, registry);
  const read = await call(runner, req, 'agent_memory_read', {}); assert.equal(read.result.revision, null);
  const write = await call(runner, req, 'agent_memory_write', { content: 'Stable notes', expected_revision: null }); assert.equal(write.kind, 'returned'); assert.ok(write.result.path.startsWith(project));
  assert.equal((await call(runner, req, 'agent_memory_write', { content: 'Lost update', expected_revision: null })).kind, 'failed');
  assert.equal((await call(runner, req, 'agent_memory_read', { path: '../escape' })).kind, 'failed');
  memory.release('s'); assert.equal((await call(runner, req, 'agent_memory_read', {})).kind, 'failed');
  const next = request(registry, { sessionId: 'next', prefixMessages: [], metadata: { projectDir: project }, tools: [] });
  await memory.prepare({ ...agent, memory: 'project', permissionMode: 'plan' }, next, registry);
  assert.ok(next.prefixMessages.every(message => !message.content.includes('Stable notes')));
  assert.match(next.inputMessages.at(-1).message.content, /Stable notes/); assert.deepEqual(next.tools.map(tool => tool.name), ['agent_memory_read']);
  const outside = join(root, 'outside'); await mkdir(outside);
  const unsafe = join(root, 'unsafe'); await mkdir(unsafe); await symlink(outside, join(unsafe, '.cardbush'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(memory.prepare({ ...agent, memory: 'project' }, request(registry, { metadata: { projectDir: unsafe } }), registry), /escapes/);
});

test('Agent local MCP is scoped, supports exact Claude tool names, and releases once', async t => {
  const root = await temp(t), registry = new ToolRegistry(); registerMcpDiscovery(registry); let opens = 0, closes = 0;
  const name = 'mcp__plugin_demo_docs__scope_0123456789abcdef__lookup';
  const environment = new PluginAgentEnvironment(root, registry, undefined, async () => { opens++; return { registrations: [mcp(name, 'plugin_demo_docs__scope_0123456789abcdef')], close: async () => { closes++; } }; });
  const profile = { ...agent, trusted: true, mcpServers: [{ docs: { command: 'fixture' } }], tools: ['mcp__docs__lookup'] };
  const req = request(registry);
  await assert.rejects(environment.acquire(req, { ...profile, trusted: false }), /trust/); assert.equal(opens, 0);
  const lease = await environment.acquire(req, profile);
  assert.equal(opens, 1); assert.ok(req.tools.some(tool => tool.name === name));
  assert.ok(!registry.definitions().some(tool => tool.name === name));
  assert.ok(!registry.catalog().some(tool => tool.definition.name === name));
  assert.deepEqual(pluginAgentTools({ ...profile, disallowedTools: ['mcp__*'] }, [name]), []);
  const runner = coordinator(registry); assert.equal((await call(runner, req, name, {})).kind, 'returned');
  assert.equal((await call(runner, { ...req, sessionId: 'another' }, name, {})).kind, 'failed');
  await lease.release(); await lease.release(); assert.equal(closes, 1); assert.equal(registry.resolve(name), undefined);
});

test('Worktree Agent edits stay isolated and modified copies are kept for review', async t => {
  const root = await temp(t), project = join(root, 'project'); await mkdir(project); await writeFile(join(project, 'note.txt'), 'original');
  const git = (...args) => promisify(execFile)('git', ['-C', project, ...args], { windowsHide: true });
  await git('init'); await git('add', 'note.txt'); await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=NUL', 'commit', '-m', 'Fixture');
  const registry = new ToolRegistry(), workspaces = new TaskWorkspaceManager(join(root, 'workspaces'));
  const environment = new PluginAgentEnvironment(join(root, 'memory'), registry, workspaces);
  const req = request(registry, { metadata: { projectDir: project }, sessionMetadata: {} });
  const lease = await environment.acquire(req, { ...agent, isolation: 'worktree' });
  assert.notEqual(req.metadata.workspaceDir, project);
  await writeFile(join(req.metadata.workspaceDir, 'note.txt'), 'changed'); await lease.release();
  assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'original');
  assert.equal(await readFile(join(req.metadata.workspaceDir, 'note.txt'), 'utf8'), 'changed');
  assert.equal((await workspaces.descriptor(req.sessionId)).status, 'ready');
});

test('Background Agents persist results, deliver once, stop on cancellation and recover interruption', async t => {
  const root = await temp(t), registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  const manager = new PluginBackgroundTasks(root, tasks, registry);
  const startRecord = id => tasks.start({ taskId: id, parentSessionId: 's', parentTurnId: 't', childSessionId: `child-${id}`, childTurnId: 'ct', prompt: 'task', inheritContext: false, inheritedMessageCount: 0, background: true });
  startRecord('one'); let release;
  const pending = manager.start('s', 't', 'one', async () => { await new Promise(resolve => { release = resolve; }); tasks.finish({ parentSessionId: 's', taskId: 'one', status: 'completed', finalResponse: 'done', errorMessage: '', usage: {} }); });
  await Promise.resolve(); assert.equal(tasks.get('s', 'one').status, 'running'); release(); await pending;
  assert.equal((await manager.results('s'))[0].finalResponse, 'done'); await manager.acknowledge('s', ['one']); assert.deepEqual(await manager.results('s'), []);
  startRecord('orphan'); const recovered = new PluginBackgroundTasks(root, tasks, new ToolRegistry());
  assert.equal((await recovered.results('s')).find(task => task.taskId === 'orphan').status, 'stopped');
  startRecord('cancel'); const cancelled = manager.start('s', 't', 'cancel', async signal => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); tasks.finish({ parentSessionId: 's', taskId: 'cancel', status: 'stopped', finalResponse: '', errorMessage: '', usage: {} }); });
  await Promise.resolve(); manager.stop('s', 't'); await cancelled; assert.equal(tasks.get('s', 'cancel').status, 'stopped');
});

test('Real host projects MCP schemas only through discovery to the provider', async t => {
  const root = await temp(t), registry = new ToolRegistry(); registry.register(mcp('mcp__docs__lookup', 'docs'));
  let round = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false, provider: { async *stream(req) {
    assert.ok(!req.tools.some(tool => tool.name.startsWith('mcp__')));
    const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'response_started' };
    const name = ++round === 1 ? 'mcp_search' : 'mcp_call';
    if (round <= 2) {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `tool-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(round === 1 ? { query: 'docs' } : { name: 'mcp__docs__lookup', arguments: {} }) };
    } else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'done' };
    yield { ...base, sequence: 4, kind: 'response_completed', finishReason: round <= 2 ? 'tool_calls' : 'stop' };
  } } });
  const terminal = await host.runModelTurn(request(registry)); assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal)); assert.equal(round, 3);
});

test('Background child continues after parent completion and asks through its own host UI route', async t => {
  const root = await temp(t), registry = new ToolRegistry(); let releaseChild, changed = 0, approvals = 0, childRounds = 0;
  registry.register({ definition: { name: 'change', description: 'Fixture change', inputSchema: { type: 'object' } }, manifest: { ...manifest, mutating: true }, decodeInput: x => x,
    authorize: () => ({ kind: 'ask', request: { reason: 'Background action', actions: ['change'], targets: [], capabilityIds: ['fixture'] } }), execute: () => { changed++; return {}; } });
  const profile = { ...agent, background: true, tools: ['change'] };
  const skill = { id: 'demo:job', kind: 'skill', pluginId: 'demo', root, path: join(root, 'SKILL.md'), name: 'job', description: 'Background', prompt: 'Do a change', arguments: [], argumentHint: '', userInvocable: true, disableModelInvocation: false, shell: 'bash', context: 'fork', agent: 'reviewer', background: true };
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false, loadPluginExtensions: async () => ({ hooks: [], agents: [profile], skills: [skill] }),
    requestBackgroundPermission: async input => { approvals++; assert.equal(host.events('s', 't').at(-1).kind, 'turn_terminal'); assert.notEqual(input.sessionId, 's'); return true; },
    provider: { async *stream(req) {
      const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      if (req.metadata.agentRole === 'child' && ++childRounds === 1) {
        await new Promise(resolve => { releaseChild = resolve; });
        yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'background-change', nameDelta: 'change', argumentsDelta: '{}' };
        yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
      } else { yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Completed fixture.' }; yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' }; }
    } },
  });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runModelTurn(request(registry, { messages: [{ role: 'user', content: '/demo:job' }] }));
  assert.equal(terminal.payload.status, 'completed'); assert.equal(changed, 0);
  for (let i = 0; !releaseChild && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(releaseChild); releaseChild();
  let task;
  for (let i = 0; i < 100; i++) { [task] = await host.sendCommand({ kind: 'runtime.list_subagent_tasks', payload: { parentSessionId: 's' } }); if (task?.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(changed, 1); assert.equal(approvals, 1);
});
