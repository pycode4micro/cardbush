import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, SubagentTaskStore } from '../dist/index.js';
import { AssistantMemory } from '../dist/assistantMemory.js';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { withToolDisplayTitle } from '../dist/toolDisplay.js';
import { bindResultDelivery } from '../dist/taskResultDelivery.js';
import { realtimeConversationRecord } from '../dist/realtimeConversationBridge.js';
import { PERSONAL_ASSISTANT_SESSION as sessionId, assistantProfileSchema } from '@cardbush/bush-protocol';
import { renderPromptTemplate } from '@cardbush/platform/prompts';

const until = async read => { for (let i = 0; i < 500; i++) { if (await read()) return; await new Promise(done => setTimeout(done, 5)); } assert.fail('Assistant did not settle.'); };
const call = (id, name, args = {}) => ({ id, name, args });
const invoke = (id, name, args) => call(id, 'call_tool', { name, arguments: args });
const load = (id, names) => call(id, 'get_tool_schema', Array.isArray(names) ? { names } : { name: names });
const agent = { id: 'clerk', name: 'Clerk', system_prompt: 'Inspect only verified inventory.' };
const workflow = { id: 'inventory', name: 'Inventory', nodes: [{ id: 'check', agent_id: 'clerk', prompt: 'Inspect inventory' }] };
async function* response(request, calls = [], text = 'Done.') {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() }; let sequence = 0;
  for (const [index, value] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index,
    toolCallId: value.id, nameDelta: value.name, argumentsDelta: JSON.stringify(value.args) };
  if (!calls.length) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}
async function fixture(t, { child, remoteAgents, root: existingRoot, hooks } = {}) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'cardbush-assistant-disclosure-'));
  const registry = new ToolRegistry(), sessions = new SessionStore(), tasks = new SubagentTaskStore();
  sessions.ensureSession(sessionId);
  const requests = [], children = [], results = new Map(), executed = [], forbidden = [];
  let steps = [], round = 0, turns = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, sessionStore: sessions, subagentTaskStore: tasks, remoteAgents,
    ...(hooks ? { loadPluginExtensions: async () => ({ commands: [], skills: [], agents: [], hooks }) } : {}),
    provider: { async *stream(request) {
      if (request.metadata.agentRole === 'child') {
        children.push(structuredClone(request));
        if (child) await child(request);
        yield* response(request, [], 'Inventory verified.'); return;
      }
      assert.equal(request.metadata.personalAssistant, true, 'no extra internal model work');
      requests.push(structuredClone(request));
      for (const message of request.messages) if (message.role === 'tool') results.set(message.toolCallId, JSON.parse(message.content));
      const step = steps[round++];
      yield* response(request, typeof step === 'function' ? await step(request) : step ?? []);
    } } });
  for (const name of ['subagent', 'team', 'tasks', 'list_subagent_options', 'summary_for_user', 'update_task_plan']) {
    const registration = registry.resolve(name), execute = registration.execute;
    registration.execute = context => { executed.push({ name, input: structuredClone(context.input) }); return execute(context); };
  }
  registry.register({ definition: { name: 'mcp__fixture__secret', description: 'Private tool', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false },
    mcpHook: { server: 'fixture', tool: 'secret', call: async () => ({}) }, decodeInput: input => input,
    execute: () => { forbidden.push('mcp'); return {}; } });
  const parent = () => ({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turns}`, sessionId, turnId: `turn-${turns}`, model: 'fixture',
    tools: registry.definitions(), prefixMessages: [{ role: 'system', content: 'Stable fixture policy.' }],
    inputMessages: [{ messageId: `input-${turns}`, message: { role: 'user', content: 'Manage the requested work.' } }],
    metadata: { planEnabled: true, workspaceDir: root, mcpToolDiscovery: true, individuation: { habits: false, predictions: false } }, permissionMode: 'task_free' });
  const command = payload => host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { sessionId, ...payload } });
  const read = () => command({ action: 'read' });
  const close = () => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  t.after(async () => { await close(); if (!existingRoot) { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); } });
  return { root, registry, tasks, requests, children, results, executed, forbidden, parent, command, read, close,
    answer: (permission, decision) => host.sendCommand({ kind: 'runtime.answer_permission', payload: {
      protocol: 'bush.runtime_permission_answer.v1', permissionId: permission.permissionId, answerId: `answer-${decision}`,
      decision, ...(decision === 'allow_once' ? { grantedCapabilityIds: permission.request.requestedCapabilityIds } : {}),
    } }),
    async run(plan, patch = {}, profile = {}, expectedError = '') {
      steps = plan; round = 0; turns++;
      const start = requests.length;
      await command({ action: 'turn', parent: { ...parent(), ...patch }, profile: assistantProfileSchema.parse(profile),
        entry: { id: `input-${turns}-${Date.now()}`, role: 'user', source: 'text', visibility: 'conversation', content: 'Manage the requested work.', createdAt: new Date().toISOString() } });
      await until(async () => !(await read()).busy);
      const error = (await read()).error;
      if (expectedError instanceof RegExp) assert.match(error, expectedError); else assert.equal(error, expectedError);
      return requests.slice(start);
    },
  };
}

test('Assistant projects the ordinary native definitions without changing memory or adding query rounds', async t => {
  const f = await fixture(t);
  const original = structuredClone(f.registry.definitions());
  const seen = await f.run([[call('options', 'list_subagent_options'), call('active', 'tasks', { action: 'list' })]]);
  assert.equal(seen.length, 2);
  const tools = seen[0].tools;
  assert.ok(seen[0].messages.some(message => message.role === 'system' && message.content.includes(renderPromptTemplate('coordination-tool-boundaries'))), 'Assistant receives the shared clean delegation policy');
  assert.deepEqual(tools.find(tool => tool.name === 'subagent').inputSchema.properties.action.enum, ['run']);
  assert.equal(tools.find(tool => tool.name === 'subagent').inputSchema.properties.agent, undefined);
  assert.equal(tools.find(tool => tool.name === 'subagent').inputSchema.properties.mode, undefined, 'clean is recalled with its required configuration');
  assert.equal(tools.find(tool => tool.name === 'subagent').inputSchema.properties.system_prompt, undefined);
  assert.equal(tools.find(tool => tool.name === 'team').inputSchema.properties.definition, undefined);
  assert.deepEqual(tools.find(tool => tool.name === 'team').inputSchema.properties.action.enum, ['list', 'get', 'run', 'resume']);
  for (const name of ['get_tool_schema', 'call_tool']) assert.ok(tools.some(tool => tool.name === name));
  const memory = new AssistantMemory({}, f.registry).definitions();
  for (const definition of memory) assert.deepEqual(tools.find(tool => tool.name === definition.name), definition);
  assert.deepEqual(f.registry.definitions(), original, 'projection never mutates native schemas');
  assert.deepEqual(seen[1].tools, tools, 'query results do not rewrite the provider catalog');
  const previous = tools.filter(tool => !['get_tool_schema', 'call_tool'].includes(tool.name)).map(tool =>
    ['subagent', 'team'].includes(tool.name) ? f.registry.resolve(tool.name).definition : tool);
  const size = values => { const json = JSON.stringify(values.map(withToolDisplayTitle)); return { bytes: Buffer.byteLength(json), estimatedTokens: Math.ceil(json.length / 4) }; };
  assert.ok(size(tools).bytes < size(previous).bytes);
  console.log(JSON.stringify({ assistantToolsBefore: size(previous), assistantToolsAfter: size(tools), tokenEstimate: 'JSON characters / 4' }));
});

test('complete recalled schemas preserve employee and Team create/update/delete with one execution per outer call', async t => {
  const f = await fixture(t);
  const seen = await f.run([
    [load('schemas', ['subagent', 'team'])],
    [invoke('save-agent', 'subagent', { action: 'save', expected_revision: 0, agent }),
      invoke('save-team', 'team', { action: 'save', expected_revision: 0, definition: workflow })],
    [invoke('edit-agent', 'subagent', { action: 'save', expected_revision: 1, agent: { ...agent, name: 'Updated clerk' } }),
      invoke('edit-team', 'team', { action: 'save', expected_revision: 1, definition: { ...workflow, name: 'Updated inventory' } })],
    [invoke('delete-team', 'team', { action: 'delete', team_id: workflow.id, expected_revision: 2 }),
      invoke('delete-agent', 'subagent', { action: 'delete', agent_id: agent.id, expected_revision: 2 })],
  ]);
  assert.equal(seen.length, 5, 'one round per planned batch, then the final reply');
  assert.equal(f.executed.filter(call => ['subagent', 'team'].includes(call.name)).length, 6);
  assert.equal(f.children.length, 0, 'editing definitions starts no child');
  for (const [id, value] of f.results) assert.notEqual(value.status, 'failed', `${id}: ${JSON.stringify(value)}`);
  for (const match of f.results.get('schemas').matches) assert.deepEqual(match.inputSchema, f.registry.resolve(match.name).definition.inputSchema);
  assert.ok(seen.every(request => JSON.stringify(request.tools) === JSON.stringify(seen[0].tools)));
  const history = new ConversationJournal(join(f.root, 'conversation-journal')).modelHistory(sessionId).read().messages;
  for (const id of ['schemas', 'save-agent', 'save-team', 'edit-agent', 'edit-team', 'delete-team', 'delete-agent'])
    assert.equal(history.filter(message => message.role === 'tool' && message.toolCallId === id).length, 1);
});

test('recalled schemas survive restart in the journal and reject changed definitions until reread', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-assistant-disclosure-restart-'));
  const first = await fixture(t, { root });
  await first.run([[load('load', 'subagent')]]); await first.close();
  const f = await fixture(t, { root: first.root });
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  assert.equal((await f.run([[invoke('saved', 'subagent', { action: 'save', expected_revision: 0, agent })]])).length, 2);
  assert.notEqual(f.results.get('saved').status, 'failed');
  f.registry.resolve('subagent').definition.description += ' Revised definition.';
  await f.run([[invoke('stale', 'subagent', { action: 'delete', agent_id: agent.id, expected_revision: 1 })]]);
  assert.equal(f.results.get('stale').code, 'builtin_schema_required');
  assert.equal(f.executed.filter(call => call.name === 'subagent').length, 1);
  await f.run([[load('reload', 'subagent')], [invoke('deleted', 'subagent', { action: 'delete', agent_id: agent.id, expected_revision: 1 })]]);
  assert.equal(f.results.get('deleted').deleted, true);
});

test('Assistant recall cannot expose execution tools, memory, invocation envelopes or disabled targets', async t => {
  const f = await fixture(t);
  const forbidden = ['read_file', 'terminal_exec', 'mcp__fixture__secret', 'summary_for_user', 'call_tool', 'get_tool_schema'];
  await f.run([[load('forbidden-schemas', forbidden)], forbidden.map((name, index) => invoke(`blocked-${index}`, name, {}))]);
  assert.deepEqual(f.results.get('forbidden-schemas').matches.map(match => match.name), ['call_tool', 'get_tool_schema']);
  for (let index = 0; index < forbidden.length; index++) assert.equal(f.results.get(`blocked-${index}`).status, 'failed');
  assert.equal(f.executed.length, 0); assert.equal(f.forbidden.length, 0);
  await f.run([[load('allowed', 'subagent')], () => {
    f.registry.resolve('subagent').modelAvailable = () => false;
    return [invoke('disabled', 'subagent', { action: 'save', expected_revision: 0, agent })];
  }]);
  assert.equal(f.results.get('disabled').code, 'tool_not_exposed');
  assert.equal(f.executed.length, 0);
});

test('schema loading and dependent invocation in one batch cannot execute unseen arguments', async t => {
  const f = await fixture(t);
  await f.run([[load('load', 'subagent'), invoke('premature', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(f.results.get('premature').code, 'builtin_schema_required'); assert.equal(f.executed.length, 0);
  await f.run([[invoke('retry', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(f.results.get('retry').revision, 1); assert.equal(f.executed.length, 1);
});

test('without both recall entry points the Assistant keeps full native capability definitions', async t => {
  const f = await fixture(t);
  const seen = await f.run([[call('direct-save', 'subagent', { action: 'save', expected_revision: 0, agent })]],
    { tools: f.parent().tools.filter(tool => tool.name !== 'call_tool') });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools.find(tool => tool.name === 'subagent').inputSchema.properties.agent);
  assert.ok(seen[0].tools.find(tool => tool.name === 'team').inputSchema.properties.definition);
  assert.ok(!seen[0].tools.some(tool => ['get_tool_schema', 'call_tool'].includes(tool.name)));
  assert.equal(f.results.get('direct-save').revision, 1);
});

for (const configured of [false, true]) test(`${configured ? 'recalled clean configuration' : 'direct delegation'} preserves child tools and delivers completion once`, async t => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, { child: () => gate.promise });
  const args = configured ? { prompt: 'Inspect inventory.', name: 'Inventory check', mode: 'clean', system_prompt: 'Inspect only verified facts.' }
    : { prompt: 'Inspect inventory.', name: 'Inventory check' };
  const plan = configured ? [[load('load', 'subagent')], [invoke('dispatch', 'subagent', args)]] : [[call('dispatch', 'subagent', args)]];
  const seen = await f.run(plan);
  assert.equal(seen.length, configured ? 3 : 2, 'only advanced configuration needs an initial schema read');
  await until(() => f.children.length === 1);
  if (configured) {
    const loaded = f.results.get('load').matches.find(match => match.name === 'subagent');
    assert.ok(loaded.inputSchema.properties.mode.enum.includes('clean'));
    assert.equal(loaded.inputSchema.properties.system_prompt.minLength, 1);
    assert.ok(f.children[0].messages.some(message => message.role === 'system' && message.content === args.system_prompt), 'clean instructions reach the child as its system message');
  } else assert.equal(f.executed.find(call => call.name === 'subagent').input.mode, 'fork');
  assert.ok(f.children[0].tools.some(tool => tool.name === 'read_file'), 'child execution tools are not replaced with the Assistant allowlist');
  assert.equal(f.tasks.list(sessionId).length, 1);
  assert.equal(f.results.get('dispatch').status, 'running');
  const requestsBefore = f.requests.length;
  gate.resolve();
  await until(async () => f.requests.length === requestsBefore + 1 && !(await f.read()).busy);
  assert.equal(f.requests.at(-1).messages.filter(message => message.name === 'background_task_result').length, 1);
  // A real next turn gives any stale result subscription another opportunity to
  // wake; it must still contain just its one requested model response.
  assert.equal((await f.run([])).length, 1);
  assert.equal(f.executed.filter(call => call.name === 'subagent').length, 1);
  assert.equal(f.children.length, 1);
});

test('a terminal remote receipt through call_tool is consumed without another completion request', async t => {
  let dispatches = 0;
  const f = await fixture(t, { remoteAgents: {
    list: async () => [{ id: 'remote-fixture', label: 'Remote fixture', agentId: 'service-fixture', status: 'connected' }],
    run: async () => { dispatches++; return { status: 'failed', finalResponse: '', errorMessage: 'credential_key_file_required', usage: {} }; },
  } });
  const seen = await f.run([[load('load', 'subagent')], [invoke('remote', 'subagent', { prompt: 'Read-only check.', target_agent: 'remote-fixture' })]]);
  assert.equal(seen.length, 3); assert.equal(dispatches, 1);
  assert.equal(f.results.get('remote').status, 'failed');
  assert.equal((await f.run([])).length, 1);
  assert.ok(f.requests.every(request => !request.messages.some(message => message.name === 'background_task_result')));
});

test('recalled workflow configuration keeps direct run/resume and normal asynchronous result delivery', async t => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, { child: () => gate.promise });
  const initial = await f.run([
    [load('load', ['subagent', 'team'])],
    [invoke('employee', 'subagent', { action: 'save', expected_revision: 0, agent }),
      invoke('workflow', 'team', { action: 'save', expected_revision: 0, definition: workflow })],
    [call('run', 'team', { action: 'run', team_id: workflow.id, input: 'Order 42' })],
  ]);
  assert.equal(initial.length, 4);
  await until(() => f.children.length === 1);
  gate.resolve();
  await until(async () => f.requests.length === 5 && !(await f.read()).busy);
  const runId = f.results.get('run').run_id;
  assert.ok(runId);
  assert.equal((await f.run([[call('resume', 'team', { action: 'resume', run_id: runId })]])).length, 2);
  assert.equal(f.results.get('resume').status, 'completed');
  assert.equal(f.children.length, 1, 'resuming a completed workflow does not rerun nodes');
  assert.equal(f.executed.filter(call => call.name === 'team').length, 3);
});

test('a wrapped foreground tasks receipt consumes Team completion without another model reply', async t => {
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await fixture(t, { child: () => gate.promise });
  const seen = await f.run([
    [load('load', ['subagent', 'team', 'tasks'])],
    [invoke('employee', 'subagent', { action: 'save', expected_revision: 0, agent }),
      invoke('workflow', 'team', { action: 'save', expected_revision: 0, definition: workflow })],
    [call('run', 'team', { action: 'run', team_id: workflow.id, input: 'Order 42' })],
    async () => {
      gate.resolve();
      const runId = f.results.get('run').run_id, tool = f.registry.resolve('tasks');
      await until(async () => (await tool.execute({ sessionId, turnId: 'observe',
        input: tool.decodeInput({ action: 'inspect', task_ids: [runId] }) })).tasks[0]?.status === 'completed');
      return [invoke('read', 'tasks', { action: 'inspect', task_ids: [runId] })];
    },
  ]);
  assert.equal(seen.length, 5);
  assert.equal(f.results.get('read').tasks[0].result.nodes[0].output, 'Inventory verified.');
  assert.equal((await f.run([])).length, 1);
  assert.ok(f.requests.every(request => !request.messages.some(message => message.name === 'background_task_result')));
  assert.equal(f.children.length, 1);
});

test('summary_for_user keeps its direct contract and runs after recalled business calls in the same batch', async t => {
  const f = await fixture(t);
  const seen = await f.run([[load('load', 'subagent')], [call('summary', 'summary_for_user'),
    invoke('save', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(seen.length, 3);
  assert.deepEqual(f.executed.map(item => item.name), ['subagent', 'summary_for_user']);
  assert.equal(f.results.get('summary').status, 'ok');
  assert.equal(f.results.get('summary').saved, false);
  assert.equal(f.results.get('save').revision, 1);
});

for (const decision of ['deny', 'allow_once']) test(`recalled management respects ${decision} with the original permission anchor and no model polling`, async t => {
  const f = await fixture(t);
  let authorizations = 0;
  f.registry.resolve('update_task_plan').authorize = () => {
    authorizations++;
    return { kind: 'ask', request: { reason: 'Fixture approval', actions: ['plan.update'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['plan.update'] } };
  };
  const running = f.run([[load('load', 'update_task_plan')], [invoke('plan', 'update_task_plan', { nodes: [{ step: 'Inspect inventory', status: 'pending' }] })]],
    { requestCapabilities: { interactiveRequests: true } });
  await until(async () => { const state = await f.read(); if (f.requests.length >= 2 && !state.busy) assert.fail(JSON.stringify(f.results.get('plan') ?? state.error)); return state.management.permissions.length === 1; });
  assert.equal(f.requests.length, 2);
  assert.equal(f.executed.length, 0);
  const permission = (await f.read()).management.permissions[0];
  assert.equal(permission.toolCallId, 'plan');
  await f.answer(permission, decision);
  assert.equal((await running).length, 3);
  assert.equal(authorizations, 1);
  assert.equal(f.executed.length, decision === 'allow_once' ? 1 : 0);
  assert.equal(f.results.get('plan').status === 'failed', decision === 'deny');
});

test('voice keeps its existing conversational tool scope', async t => {
  const f = await fixture(t);
  const seen = await f.run([], { metadata: { ...f.parent().metadata, assistantOutputMode: 'voice' } });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].tools.some(tool => ['get_tool_schema', 'call_tool', 'team'].includes(tool.name)));
  assert.equal(seen[0].tools.find(tool => tool.name === 'subagent').inputSchema.properties.system_prompt, undefined);
});

for (const [name, recalled] of [['subagent', true], ['subagent', false], ['update_task_plan', true]]) test(`${recalled ? 'recalled' : 'direct'} ${name} respects the existing pre-tool Hook without execution`, async t => {
  const hooks = [], f = await fixture(t, { hooks });
  const script = join(f.root, 'deny.cjs');
  await writeFile(script, `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'Blocked by fixture policy'}}));`);
  const command = `"${process.execPath}" "${script}"`;
  hooks.push({ id: 'deny-target', pluginId: 'fixture', root: f.root, event: 'PreToolUse', matcher: name,
    dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  const args = name === 'subagent' ? { action: 'save', expected_revision: 0, agent }
    : { nodes: [{ step: 'Inspect inventory', status: 'pending' }] };
  const seen = await f.run(recalled ? [[load('load', name)], [invoke('denied', name, args)]] : [[call('denied', name, args)]], { permissionMode: 'all_free' });
  assert.equal(f.results.get('denied').code, 'plugin_hook_blocked');
  assert.equal(f.executed.length, 0);
  assert.equal(seen.length, recalled ? 3 : 2);
});

test('recalled delegation applies pre-tool argument changes once through the original validator', async t => {
  const hooks = [], f = await fixture(t, { hooks }), script = join(f.root, 'rewrite.cjs');
  const updated = { action: 'save', expected_revision: 0, agent: { ...agent, name: 'Policy-checked clerk' } };
  await writeFile(script, `console.log(JSON.stringify(${JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated,
  } })}));`);
  const command = `"${process.execPath}" "${script}"`;
  hooks.push({ id: 'rewrite-target', pluginId: 'fixture', root: f.root, event: 'PreToolUse', matcher: 'subagent',
    dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  const seen = await f.run([[load('load', 'subagent')], [invoke('save', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(f.results.get('save').revision, 1);
  assert.equal(f.executed.length, 1);
  assert.equal(f.executed[0].input.registration.agent.name, updated.agent.name);
  assert.equal(seen.length, 3);
});

test('a post-tool Hook withholds recalled delegation output and releases unread result ownership', async t => {
  const hooks = [], f = await fixture(t, { hooks }), script = join(f.root, 'withhold.cjs');
  await writeFile(script, `console.log(JSON.stringify({decision:'block',reason:'Withheld by fixture policy'}));`);
  const command = `"${process.execPath}" "${script}"`;
  hooks.push({ id: 'withhold-target', pluginId: 'fixture', root: f.root, event: 'PostToolUse', matcher: 'subagent',
    dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  let released = 0, committed = 0;
  const tool = f.registry.resolve('subagent'), execute = tool.execute;
  tool.execute = async context => bindResultDelivery({ ...await execute(context), withheldValue: 'private result' }, {
    references: () => [], release: () => { released++; }, commit: () => { committed++; },
  });
  const seen = await f.run([[load('load', 'subagent')], [invoke('save', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(f.results.get('save').code, 'plugin_hook_result_blocked');
  assert.match(f.results.get('save').error, /Do not repeat the action/);
  assert.ok(!JSON.stringify(seen).includes('private result'));
  assert.equal(released, 1); assert.equal(committed, 0);
  assert.equal(f.executed.length, 1); assert.equal(seen.length, 3);
  assert.equal((await f.run([])).length, 1, 'withholding never replays the completed mutation');
  assert.equal(f.executed.length, 1);
});

test('a delegated Hook stop prevents queued actions and a further model request', async t => {
  const f = await fixture(t);
  const tool = f.registry.resolve('subagent');
  let attempted = 0;
  tool.execute = () => { attempted++; throw Object.assign(new Error('Fixture Hook stopped the turn.'), { code: 'plugin_hook_stopped' }); };
  const seen = await f.run([[load('load', 'subagent')], [invoke('first', 'subagent', { action: 'save', expected_revision: 0, agent }),
    invoke('queued', 'subagent', { action: 'save', expected_revision: 0, agent: { ...agent, id: 'second' } }), call('summary', 'summary_for_user')]],
    {}, {}, 'Fixture Hook stopped the turn.');
  assert.equal(attempted, 1);
  assert.equal(seen.length, 2);
  assert.equal(f.executed.length, 0, 'no queued operation or final-display signal runs after a stop');
});

test('stopping a recalled permission wait cancels its queue without executing or requesting a reply', async t => {
  const f = await fixture(t);
  f.registry.resolve('update_task_plan').authorize = () => ({ kind: 'ask', request: {
    reason: 'Fixture approval', actions: ['plan.update'], targets: [{ kind: 'path', value: f.root }], capabilityIds: ['plan.update'],
  } });
  const args = { nodes: [{ step: 'Inspect inventory', status: 'pending' }] };
  const pending = f.run([[load('load', 'update_task_plan')], [invoke('waiting', 'update_task_plan', args), invoke('queued', 'update_task_plan', args)]],
    { requestCapabilities: { interactiveRequests: true }, metadata: { ...f.parent().metadata, uiLanguage: 'en' } }, {}, /stopped/i);
  await until(async () => (await f.read()).management.permissions.length === 1);
  await f.command({ action: 'stop' });
  assert.equal((await pending).length, 2);
  await until(async () => (await f.read()).management.permissions.length === 0);
  assert.equal(f.executed.length, 0);
  assert.equal((await f.run([])).length, 1);
  assert.equal(f.executed.length, 0);
});

for (const blocked of ['call_tool', 'subagent']) test(`recalled delegation retains the active Command restriction on ${blocked}`, async t => {
  const f = await fixture(t);
  const seen = await f.run([[load('load', 'subagent')], [invoke('denied', 'subagent', { action: 'save', expected_revision: 0, agent })]],
    { metadata: { ...f.parent().metadata, pluginCommandDisallowedTools: [blocked] } });
  assert.equal(f.results.get('denied').code, 'plugin_command_tool_disallowed');
  assert.equal(f.executed.length, 0); assert.equal(seen.length, 3);
});

test('a compacted schema receipt cannot be replaced by summary text and is reread through the shared loader', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-assistant-disclosure-compaction-'));
  const first = await fixture(t, { root });
  await first.run([[load('load', 'subagent')]]); await first.close();
  const history = new ConversationJournal(join(root, 'conversation-journal')).modelHistory(sessionId);
  const state = history.read();
  history.checkpoint(state.through + state.messages.length, 'Previously loaded subagent schema.');
  const f = await fixture(t, { root });
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const args = { action: 'save', expected_revision: 0, agent };
  const seen = await f.run([[invoke('compacted', 'subagent', args)], [load('reread', 'subagent')], [invoke('saved', 'subagent', args)]]);
  assert.equal(f.results.get('compacted').code, 'builtin_schema_required');
  assert.equal(f.results.get('saved').revision, 1);
  assert.equal(f.executed.length, 1); assert.equal(seen.length, 4);
});

for (const name of ['subagent', 'update_task_plan']) test(`recalled ${name} delivers Hook context after the batch receipts without another request`, async t => {
  const hooks = [], f = await fixture(t, { hooks }), script = join(f.root, 'context.cjs');
  await writeFile(script, `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'Fixture checked the inventory policy.'}}));`);
  const command = `"${process.execPath}" "${script}"`;
  hooks.push({ id: 'context-target', pluginId: 'fixture', root: f.root, event: 'PostToolUse', matcher: `^${name}$`,
    dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  const args = name === 'subagent' ? { action: 'save', expected_revision: 0, agent } : { nodes: [{ step: 'Inspect inventory', status: 'pending' }] };
  const seen = await f.run([[load('load', name)], [invoke('operation', name, args), call('options', 'list_subagent_options')]]);
  const messages = seen.at(-1).messages;
  const feedback = messages.filter(message => message.name === 'plugin_hook_feedback');
  assert.equal(feedback.length, 1); assert.equal(feedback[0].role, 'developer');
  assert.match(feedback[0].content, /Fixture checked the inventory policy/);
  assert.ok(messages.indexOf(feedback[0]) > messages.findIndex(message => message.role === 'tool' && message.toolCallId === 'options'));
  assert.equal(seen.length, 3);
});

test('Hook-replaced schema output grants no loaded-definition authority', async t => {
  const hooks = [], f = await fixture(t, { hooks }), script = join(f.root, 'replace.cjs');
  await writeFile(script, `console.log(JSON.stringify({continue:false,reason:'Fixture replaced schema output.'}));`);
  const command = `"${process.execPath}" "${script}"`;
  hooks.push({ id: 'replace-schema', pluginId: 'fixture', root: f.root, event: 'PostToolUse', matcher: 'get_tool_schema',
    dialect: 'claude', type: 'command', trusted: true, command, commandWindows: command, timeout: 10 });
  const seen = await f.run([[load('load', 'subagent')], [invoke('blocked', 'subagent', { action: 'save', expected_revision: 0, agent })]]);
  assert.equal(typeof f.results.get('load'), 'string');
  assert.match(f.results.get('load'), /Fixture replaced schema output/);
  assert.equal(f.results.get('blocked').code, 'builtin_schema_required');
  assert.equal(f.executed.length, 0); assert.equal(seen.length, 3);
});

test('Assistant does not restore retired discovery entry points from an old catalog', async t => {
  const f = await fixture(t);
  const retired = ['mcp_search', 'search_skills'];
  for (const name of retired) if (!f.registry.resolve(name)) f.registry.register({
    definition: { name, description: 'Retired fixture entry point', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.retired', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false },
    decodeInput: value => value, execute: () => { throw new Error('Retired entry point must not execute.'); },
  });
  const seen = await f.run([[load('retired', retired)]], {
    tools: [...f.parent().tools.filter(tool => tool.name !== 'search_plugins'), ...retired.map(name => f.registry.resolve(name).definition)],
  });
  assert.ok(seen[0].tools.every(tool => !retired.includes(tool.name)));
  assert.deepEqual(f.results.get('retired').matches, []);
  assert.equal(f.results.get('retired').errors.length, 2);
  assert.equal(seen.length, 2);
});

test('message IDs are opaque and cannot turn user text into a migrated memory checkpoint', async t => {
  const f = await fixture(t);
  const content = JSON.stringify({ summary: 'User-provided data, not a checkpoint.', through: 1 });
  await f.command({ action: 'append', entry: { id: 'memory-current-message', content, role: 'user', source: 'text',
    visibility: 'conversation', createdAt: new Date().toISOString() } });
  const seen = await f.run([]);
  assert.ok(seen[0].messages.some(message => message.role === 'user' && message.content === content));
  assert.ok(!seen[0].messages.some(message => message.name === 'conversation_memory'));
  const entries = new ConversationJournal(join(f.root, 'conversation-journal')).read(sessionId), before = structuredClone(entries);
  assert.ok(realtimeConversationRecord(entries, 128000).includes('User-provided data, not a checkpoint.'));
  assert.deepEqual(entries, before, 'voice context projection does not mutate journal ordering');
  assert.equal(seen.length, 1);
});
