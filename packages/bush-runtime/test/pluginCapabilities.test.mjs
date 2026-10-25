import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolRegistry, ToolExecutionCoordinator, SubagentTaskStore, InMemoryRuntimeHost } from '../dist/index.js';
import { registerMcpDiscovery, modelToolDefinitions, synchronizeMcpDiscovery } from '../dist/mcpToolDiscovery.js';
import { PluginHookScopes } from '../dist/pluginHookScopes.js';
import { PluginAgentEnvironment } from '../dist/pluginAgentEnvironment.js';
import { PluginBackgroundTasks } from '../dist/pluginBackgroundTasks.js';
import { pluginAgentTools } from '../dist/pluginExtensions.js';
import { TaskWorkspaceManager } from '../dist/taskWorkspace.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
const agent = { id: 'demo:reviewer', pluginId: 'demo', root: '.', name: 'reviewer', description: 'Review', prompt: 'Review files' };
const request = (registry, overrides = {}) => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: {}, requestCapabilities: { vision: false, interactiveRequests: false }, ...overrides });
const coordinator = (registry, ask = async () => { throw Error('Unexpected permission'); }) => new ToolExecutionCoordinator({ registry, permissions: { request: ask } });
let serial = 0;
const call = (coordinator, req, name, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) }, { ...req, round: 1, ordinal: serial }, undefined, { request: req, contextMessages: req.messages });
async function temp(t) { const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-cap-')); t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-plugin-cap-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root; }
const mcp = (name, server, execute = () => ({})) => ({ definition: { name, description: `${server} document lookup`, inputSchema: { type: 'object', properties: {} } }, manifest, decodeInput: x => x, execute, mcpHook: { server, tool: 'lookup', call: async () => ({}) } });

test('MCP discovery hides large catalogs, retains permission checks and cannot cross task scopes', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); let executions = 0, asks = 0;
  for (let i = 0; i < 1000; i++) registry.register({ ...mcp(`mcp__service${i}__lookup`, `service${i}`, () => { executions++; return { found: true }; }), authorize: () => ({ kind: 'ask', request: { reason: 'External tool', actions: ['read'], targets: [], capabilityIds: ['mcp'] } }) });
  const req = request(registry, { metadata: { mcpToolDiscovery: true } });
  assert.deepEqual(modelToolDefinitions(registry, req).map(tool => tool.name), ['mcp_search', 'get_tool_schema', 'call_tool']);
  const runner = coordinator(registry, async permission => { asks++; return { decision: 'deny', grantedCapabilityIds: [] }; });
  assert.equal((await call(runner, req, 'mcp__service42__lookup', {})).error.code, 'mcp_discovery_required');
  const searched = await call(runner, req, 'get_tool_schema', { name: 'mcp__service42__lookup' });
  assert.equal(searched.result.matches.length, 1); assert.ok(searched.result.matches[0].inputSchema);
  req.messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'get_tool_schema', argumentsText: '{"name":"mcp__service42__lookup"}' }] }, { role: 'tool', toolCallId: 'search', content: JSON.stringify(searched.result) }];
  synchronizeMcpDiscovery(registry, req, req.messages);
  const denied = await call(runner, req, 'call_tool', { name: searched.result.matches[0].name, arguments: {} });
  assert.equal(denied.kind, 'failed'); assert.equal(asks, 1); assert.equal(executions, 0);
  const other = request(registry, { sessionId: 'other', metadata: { mcpToolDiscovery: true }, tools: req.tools.filter(tool => !tool.name.includes('service42')) });
  assert.equal((await call(runner, other, 'mcp_search', { query: '*', server: 'service42' })).result.total, 0);
  assert.equal((await call(runner, other, 'call_tool', { name: 'mcp__service42__lookup', arguments: {} })).kind, 'failed');
  const recovered = request(registry, { metadata: structuredClone(req.metadata), messages: structuredClone(req.messages) });
  assert.equal((await call(runner, recovered, 'call_tool', { name: 'mcp__service42__lookup', arguments: {} })).error.code, 'permission_rejected');
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
  const root = await temp(t), registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); registry.register(mcp('mcp__docs__lookup', 'docs', () => ({ value: 42 })));
  const environment = new PluginAgentEnvironment(registry);
  const req = request(registry, { metadata: { mcpToolDiscovery: true } }); const lease = await environment.acquire(req, { ...agent, permissionMode: 'plan', tools: ['mcp__docs__*'] }); t.after(() => lease.release());
  assert.ok(req.tools.some(tool => tool.name === 'call_tool'));
  const events = [];
  const runner = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected approval'); } }, hooks: { before: async context => { events.push(['before', context.toolCall.name]); return { messages: [] }; }, after: async context => { events.push(['after', context.toolCall.name]); return { messages: [], ...(context.toolCall.name === 'mcp__docs__lookup' ? { toolFeedback: 'Scoped feedback' } : {}) }; } } });
  const searched = await call(runner, req, 'get_tool_schema', { name: 'mcp__docs__lookup' });
  req.messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'get_tool_schema', argumentsText: '{"name":"mcp__docs__lookup"}' }] }, { role: 'tool', toolCallId: 'search', content: JSON.stringify(searched.result) }];
  synchronizeMcpDiscovery(registry, req, req.messages);
  events.length = 0;
  const result = await call(runner, req, 'call_tool', { name: 'mcp__docs__lookup', arguments: {} });
  assert.deepEqual(events, [['before', 'mcp__docs__lookup'], ['after', 'mcp__docs__lookup']]); assert.equal(result.hookFeedback, 'Scoped feedback');
});

test('Agent local MCP is scoped, supports exact Claude tool names, and releases once', async t => {
  const root = await temp(t), registry = new ToolRegistry(); registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry); let opens = 0, closes = 0;
  const name = 'mcp__plugin_demo_docs__scope_0123456789abcdef__lookup';
  const environment = new PluginAgentEnvironment(registry, undefined, async () => { opens++; return { registrations: [mcp(name, 'plugin_demo_docs__scope_0123456789abcdef')], close: async () => { closes++; } }; });
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
  const environment = new PluginAgentEnvironment(registry, workspaces);
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
    const name = ++round === 1 ? 'get_tool_schema' : 'call_tool';
    if (round <= 2) {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `tool-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(round === 1 ? { name: 'mcp__docs__lookup' } : { name: 'mcp__docs__lookup', arguments: {} }) };
    } else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'done' };
    yield { ...base, sequence: 4, kind: 'response_completed', finishReason: round <= 2 ? 'tool_calls' : 'stop' };
  } } });
  const terminal = await host.runModelTurn(request(registry)); assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal)); assert.equal(round, 3);
});

test('forked builtin roles stay read-only while a plugin named Plan follows its declared tools', async t => {
  for (const [label, profile, expectedChanges] of [
    ['builtin', undefined, 0],
    ['declared', { ...agent, id: 'demo:Plan', name: 'Plan', tools: ['change'], maxTurns: 7 }, 1],
    ['restricted', { ...agent, id: 'demo:Plan', name: 'Plan', tools: ['change', 'inspect'], disallowedTools: ['change'] }, 0],
  ]) await t.test(label, async t => {
    const root = await temp(t), registry = new ToolRegistry(); let changes = 0, childRounds = 0;
    registry.register({ definition: { name: 'change', description: 'Fixture change', inputSchema: { type: 'object' } },
      manifest: { ...manifest, mutating: true }, decodeInput: x => x, execute: () => { changes++; return {}; } });
    registry.register({ definition: { name: 'inspect', description: 'Fixture observation', inputSchema: { type: 'object' } },
      manifest, decodeInput: x => x, execute: () => ({}) });
    const skill = { id: 'demo:role', kind: 'skill', pluginId: 'demo', root, path: join(root, 'SKILL.md'), name: 'role',
      description: 'Role fixture', prompt: 'Perform fixture change', arguments: [], argumentHint: '', userInvocable: true,
      disableModelInvocation: false, shell: 'bash', context: 'fork', agent: 'Plan' };
    const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
      loadPluginExtensions: async () => ({ hooks: [], agents: profile ? [profile] : [], skills: [skill] }),
      provider: { async *stream(req) {
        const base = { protocol: 'bush.model_event.v1', requestId: req.requestId, createdAt: new Date().toISOString() };
        yield { ...base, sequence: 0, kind: 'response_started' };
        if (req.metadata.agentRole === 'child' && ++childRounds === 1) {
          if (profile?.maxTurns) assert.equal(req.metadata.pluginAgentMaxTurns, profile.maxTurns);
          yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'fixture-change', nameDelta: 'change', argumentsDelta: '{}' };
          yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
        } else {
          yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Finished fixture.' };
          yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
        }
      } },
    });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const terminal = await host.runModelTurn(request(registry, { permissionMode: 'all_free', messages: [{ role: 'user', content: '/demo:role' }] }));
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
    assert.ok(childRounds > 0); assert.equal(changes, expectedChanges);
  });
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
