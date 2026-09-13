import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  buildChildTurnRequest, InMemoryRuntimeHost, registerSubagentTool, SubagentTaskStore,
  ToolExecutionCoordinator, ToolRegistry,
} from '../dist/index.js';
import { PluginAgentEnvironment } from '../dist/pluginAgentEnvironment.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const registration = (name, overrides = {}) => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} } }, manifest, decodeInput: value => value, execute: () => ({ ok: true }), ...overrides });
const parent = registry => ({
  protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent-session', turnId: 'parent-turn',
  model: 'parent-model', providerBinding: { bindingId: 'parent-model', revision: '1' }, permissionMode: 'all_free',
  maxOutputTokens: 4096, temperature: 0.6, topP: 0.8, reasoningEffort: 'medium', tools: registry.definitions(),
  messages: [{ role: 'system', content: 'Parent policy' }, { role: 'user', content: 'Parent-only history' }],
  metadata: { contextWindowTokens: 32000, subagentChildPrefixMessages: [{ role: 'system', content: 'Legacy fallback policy' }] },
});
let serial = 0;
const invoke = (registry, request, name, input) => new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission'); } } }).execute(
  { protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) },
  { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: serial },
  undefined, { request, contextMessages: request.messages },
);
const result = request => ({
  terminal: { kind: 'turn_terminal', payload: { status: 'completed', finalMessageId: 'done' } },
  session: { turns: [{ turnId: request.turnId, usage: {}, messages: [{ messageId: 'done', message: { role: 'assistant', content: '完成。' } }] }] },
});
const fixture = (options = {}) => {
  const registry = new ToolRegistry(), requests = [], tasks = new SubagentTaskStore();
  for (const name of ['read_file', 'write_file', 'terminal_exec']) registry.register(registration(name));
  registry.register(registration('root_only', { visibleToChild: false }));
  registerSubagentTool(registry, tasks, async request => { requests.push(request); return result(request); }, options);
  return { registry, requests, tasks, request: parent(registry) };
};
const clean = { mode: 'clean', system_prompt: '你是审查助手，请用中文汇报。', prompt: '核实这个明确给出的事实。' };
const build = (f, overrides = {}) => buildChildTurnRequest({
  context: { sessionId: f.request.sessionId, turnId: f.request.turnId, turn: { request: f.request, contextMessages: f.request.messages } },
  registry: f.registry, ids: { requestId: 'child-r', sessionId: 'child-s', turnId: 'child-t', messageId: 'child-m' },
  prompt: clean.prompt, cleanSystemPrompt: clean.system_prompt, inherited: [], metadata: {}, ...overrides,
});

test('ordinary dispatch defaults to fork and retains the exact parent prefix and definitions', async () => {
  const f = fixture(), definition = f.registry.resolve('subagent').definition;
  assert.equal(definition.inputSchema.properties.mode.default, 'fork');
  assert.equal(definition.inputSchema.properties.inherit_context, undefined);
  assert.match(definition.description, /clean only when the user explicitly requests/);
  const outcome = await invoke(f.registry, f.request, 'subagent', { prompt: '我继续实现，你先核实接口。' });
  assert.equal(outcome.kind, 'returned');
  assert.equal(outcome.result.mode, 'fork');
  assert.deepEqual(f.requests[0].prefixMessages, f.request.messages);
  assert.deepEqual(f.requests[0].tools, f.request.tools);
  assert.match(f.requests[0].inputMessages[0].message.content, /^你当前处于子agent状态\n\n我继续实现/);
});

test('explicit clean supplies the actual system and user messages without inherited history or fallback policy', async () => {
  const f = fixture();
  const outcome = await invoke(f.registry, f.request, 'subagent', { ...clean, allowed_tools: [] });
  assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
  assert.equal(outcome.result.mode, 'clean');
  assert.equal(outcome.result.inheritedMessageCount, 0);
  const child = f.requests[0];
  assert.deepEqual(child.prefixMessages, [{ role: 'system', content: clean.system_prompt }]);
  assert.deepEqual(child.inputMessages.map(item => item.message), [{ role: 'user', content: `你当前处于子agent状态\n\n${clean.prompt}` }]);
  assert.deepEqual(child.tools, []);
  assert.deepEqual(child.metadata.childToolAllowlist, []);
  assert.equal(child.metadata.agentRole, 'child');
});

test('clean parent selections reach the child model, generation, skills, limits and permission route', async () => {
  let resolved;
  const selected = { id: 'reviewer', model: 'review-model', providerBinding: { bindingId: 'reviewer', revision: '2' }, maxContextTokens: 64000, maxOutputTokens: 16000 };
  const f = fixture({ models: { list: async () => [selected], resolve: async id => { resolved = id; return selected; } } });
  f.request.metadata.allowedSkills = ['review', 'format'];
  f.request.metadata.disabledSkills = ['host-disabled'];
  const outcome = await invoke(f.registry, f.request, 'subagent', {
    ...clean, allowed_tools: ['read_file', 'terminal_exec'], settings: {
      model_id: 'reviewer', reasoning_effort: 'high', max_context_tokens: 48000, max_output_tokens: 8000,
      temperature: 0, top_p: 1, max_turns: 7, permission_mode: 'task_free', permission_routing: 'parent',
      disabled_tools: ['terminal_exec'], allowed_skills: ['review', 'outside-parent'], disabled_skills: ['format'],
    },
  });
  assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
  const child = f.requests[0];
  assert.equal(resolved, 'reviewer');
  assert.equal(child.model, 'review-model');
  assert.deepEqual(child.providerBinding, selected.providerBinding);
  assert.equal(child.maxOutputTokens, 8000);
  assert.equal(child.metadata.contextWindowTokens, 48000);
  assert.equal(child.reasoningEffort, 'high');
  assert.equal(child.temperature, 0);
  assert.equal(child.topP, 1);
  assert.equal(child.metadata.pluginAgentMaxTurns, 7);
  assert.equal(child.permissionMode, 'task_free');
  assert.equal(child.metadata.permissionRouting, 'parent');
  assert.equal(child.metadata.permissionScopeSessionId, child.sessionId);
  assert.deepEqual(child.metadata.allowedSkills, ['review']);
  assert.deepEqual(child.metadata.disabledSkills, ['host-disabled', 'format']);
  assert.ok(child.metadata.disabledTools.includes('subagent'));
  assert.ok(child.metadata.disabledTools.includes('terminal_exec'));
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_file', 'terminal_exec']);
});

test('clean options enumerate configured choices without credentials and identify child-unavailable tools', async () => {
  const f = fixture({ models: { list: async () => [{ id: 'reviewer', model: 'review-model', apiKey: 'PRIVATE-FIXTURE', providerBinding: { bindingId: 'private', revision: '1' }, maxOutputTokens: 6000 }], resolve: async () => { throw Error('Listing must not prepare a provider'); } } });
  const outcome = await invoke(f.registry, f.request, 'list_subagent_options', {});
  assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
  assert.equal(outcome.result.default_mode, 'fork');
  assert.equal(outcome.result.defaults.permission_ceiling, 'all_free');
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.result.models)), [{ id: 'reviewer', model: 'review-model', maxOutputTokens: 6000 }]);
  assert.ok(!JSON.stringify(outcome.result).includes('PRIVATE-FIXTURE'));
  for (const name of ['subagent', 'root_only']) assert.equal(outcome.result.tools.find(tool => tool.name === name).child_available, false);
  assert.equal(outcome.result.tools.find(tool => tool.name === 'read_file').child_available, true);
});

test('invalid mode combinations and clean configuration fail before starting a child', async () => {
  const f = fixture();
  for (const input of [
    { ...clean, system_prompt: undefined }, { ...clean, system_prompt: ' ' }, { ...clean, mode: 'fork' },
    { ...clean, mode: 'unknown' }, { ...clean, inherit_context: false },
    { prompt: 'work', settings: { temperature: 0 } },
    { ...clean, allowed_tools: ['missing'] }, { ...clean, allowed_tools: ['root_only'] },
    { ...clean, allowed_tools: ['read_file', 'read_file'] },
    ...[{ max_turns: 0 }, { temperature: 3 }, { top_p: -1 }, { max_context_tokens: 64000 }, { max_output_tokens: 5000 },
      { max_context_tokens: 1000 }, { extra: true }, { constructor: true }, { model_id: 'unavailable' }].map(settings => ({ ...clean, settings })),
  ]) {
    const outcome = await invoke(f.registry, f.request, 'subagent', input);
    assert.equal(outcome.kind, 'failed', JSON.stringify(input));
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.tasks.list(f.request.sessionId).length, 0);
});

test('legacy inherit_context calls remain decodable while the advertised API has one mode switch', async () => {
  const f = fixture();
  for (const inherit_context of [true, false]) {
    const outcome = await invoke(f.registry, f.request, 'subagent', { prompt: 'Saved task', inherit_context });
    assert.equal(outcome.kind, 'returned');
    assert.equal(outcome.result.mode, inherit_context ? 'fork' : 'clean');
    assert.deepEqual(f.requests.at(-1).prefixMessages, inherit_context ? f.request.messages : f.request.metadata.subagentChildPrefixMessages);
  }
});

test('clean cannot raise its permission ceiling by changing routing or override a profile execution limit', () => {
  const f = fixture();
  f.request.permissionMode = 'user_free';
  f.request.metadata.childAgentPolicy = { permissionRouting: 'parent', childPermissionMode: 'task_free' };
  assert.throws(() => build(f, { cleanSettings: { permission_mode: 'all_free', permission_routing: 'user' } }), /permission ceiling/);
  assert.throws(() => build(f, { cleanSettings: { permission_mode: 'user_free', permission_routing: 'user' } }), /permission ceiling/);
  const child = build(f, { cleanSettings: { max_turns: 50, permission_routing: 'user' }, metadata: { pluginAgentMaxTurns: 3 } });
  assert.equal(child.permissionMode, 'task_free');
  assert.equal(child.metadata.pluginAgentMaxTurns, 3);
  assert.deepEqual(build(f, { allowedToolNames: ['read_file'], toolAllowlist: ['read_file', 'write_file'] }).tools.map(tool => tool.name), ['read_file']);
});

test('clean tool restrictions and child identity still hold if a later catalog exposes more tools', async () => {
  const f = fixture();
  const child = build(f, { toolAllowlist: ['read_file', 'subagent'] });
  const request = { ...child, messages: [], tools: f.request.tools };
  assert.equal((await invoke(f.registry, request, 'read_file', {})).kind, 'returned');
  assert.equal((await invoke(f.registry, request, 'write_file', {})).error.code, 'child_agent_tool_unavailable');
  assert.equal((await invoke(f.registry, { ...request, metadata: { ...request.metadata, disabledTools: [] } }, 'subagent', clean)).error.code, 'child_agent_dispatch_unavailable');
  assert.equal(f.requests.length, 0);
});

test('plugin initialization cannot add MCP or memory tools outside an explicit clean selection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-clean-agent-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-clean-agent-')); await rm(root, { recursive: true, force: true }); });
  const f = fixture(); let closes = 0;
  const environment = new PluginAgentEnvironment(root, f.registry, undefined, async () => ({ registrations: [registration('agent_local_mcp')], close: async () => { closes++; } }));
  const child = build(f, { toolAllowlist: ['read_file'] });
  const lease = await environment.acquire(child, { id: 'fixture:review', name: 'review', pluginId: 'fixture', root, description: 'Review', prompt: 'Review', trusted: true, memory: 'user', mcpServers: [{ local: { command: 'fixture' } }] });
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_file']);
  assert.equal((await invoke(f.registry, { ...child, messages: [], tools: f.registry.definitions() }, 'agent_memory_write', {})).error.code, 'child_agent_tool_unavailable');
  await lease.release();
  assert.equal(closes, 1);
  assert.equal(f.registry.resolve('agent_local_mcp'), undefined);
});

test('the real runtime sends clean settings to the provider and enforces the selected model-round limit', async () => {
  const requests = [], counts = new Map();
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const round = (counts.get(request.sessionId) ?? 0) + 1; counts.set(request.sessionId, round);
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-12T00:00:00Z' };
    yield { ...base, sequence: 0, kind: 'response_started' };
    if (request.metadata.agentRole === 'child') {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `read-${round}`, nameDelta: 'read_fixture', argumentsDelta: '{}' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } else if (round === 1) {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: 'dispatch', nameDelta: 'subagent', argumentsDelta: JSON.stringify({ ...clean, allowed_tools: ['read_fixture'], settings: { model_id: 'reviewer', temperature: 0, reasoning_effort: 'high', max_turns: 2, max_output_tokens: 2000, max_context_tokens: 16000 } }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      yield { ...base, sequence: 1, kind: 'text_delta', delta: '已收到子任务执行限制结果。' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    }
  } };
  const registry = new ToolRegistry(); registry.register(registration('read_fixture'));
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry, subagentModels: {
    list: async () => [], resolve: async id => ({ id, model: 'review-model', providerBinding: { bindingId: id, revision: '1' }, maxOutputTokens: 8000, maxContextTokens: 64000 }),
  } });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await host.runModelTurn({ ...parent(registry), tools });
  assert.equal(terminal.payload.status, 'completed');
  const children = requests.filter(request => request.metadata.agentRole === 'child');
  assert.equal(children.length, 2);
  const child = children[0];
  assert.deepEqual(child.messages.filter(message => message.role === 'system'), [{ role: 'system', content: clean.system_prompt }]);
  assert.ok(!child.messages.some(message => /Parent-only|Legacy fallback|Parent policy/.test(message.content)));
  assert.equal(child.model, 'review-model');
  assert.equal(child.temperature, 0);
  assert.equal(child.reasoningEffort, 'high');
  assert.equal(child.maxOutputTokens, 2000);
  assert.equal(child.metadata.contextWindowTokens, 16000);
  assert.deepEqual(child.tools.map(tool => tool.name), ['read_fixture']);
  assert.ok(requests.filter(request => request.sessionId === 'parent-session').some(request => request.messages.some(message => message.content.includes('plugin_agent_turn_limit'))));
});

test('an empty clean tool scope survives runtime setup and fabricated checkpoint calls use ordinary admission', async () => {
  const requests = [], counts = new Map();
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const round = (counts.get(request.sessionId) ?? 0) + 1; counts.set(request.sessionId, round);
    const child = request.metadata.agentRole === 'child';
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-12T00:00:00Z' };
    yield { ...base, sequence: 0, kind: 'response_started' };
    if (round === 1) {
      yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: `call-${request.sessionId}`, nameDelta: child ? 'checkpoint_context' : 'subagent', argumentsDelta: JSON.stringify(child ? {} : { ...clean, allowed_tools: [] }) };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      yield { ...base, sequence: 1, kind: 'text_delta', delta: '根据提供的信息完成检查。' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    }
  } };
  const host = new InMemoryRuntimeHost({ provider });
  const tools = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const terminal = await host.runModelTurn({ ...parent(new ToolRegistry()), tools });
  assert.equal(terminal.payload.status, 'completed');
  const children = requests.filter(request => request.metadata.agentRole === 'child');
  assert.equal(children.length, 2);
  assert.ok(children.every(request => request.tools.length === 0));
  assert.ok(children[1].messages.some(message => message.role === 'tool' && message.content.includes('tool_not_exposed')));
  assert.ok(!children[1].messages.some(message => message.name === 'context_compaction_correction'));
});
