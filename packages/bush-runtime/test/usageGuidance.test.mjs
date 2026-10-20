import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { usageDefinitionSchema } from '@cardbush/bush-protocol';
import {
  UsageGuidance, USAGE_CONTEXT_MAX_CHARS, ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator,
  CoordinationStore, InMemoryRuntimeHost, registerCoordinationTools,
} from '../dist/index.js';
import { registerBuiltinToolDisclosure, projectBuiltinDefinitions } from '../dist/builtinToolDisclosure.js';
import { registerMcpDiscovery } from '../dist/mcpToolDiscovery.js';

const manifest = { effect_kind: 'observation', operation: 'fixture.observe', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false };
const definition = (nodes = []) => ({ protocol: 'bush.usage.v1', id: 'fixture', name: 'Editing methods', objective: 'Edit and check actual files', entry_node: 'work',
  constraints: [{ source: 'fixture Skill', text: 'Preserve unrelated content and verify the actual file.' }],
  nodes: [{ id: 'work', name: 'Observe and act', instruction: 'Choose actual paths and parameters. Check your work independently.',
    capabilities: [{ tool: 'inspect', purpose: 'Read the actual document' }],
    examples: [{ situation: 'Historical demonstration, not the live task', steps: [{ tool: 'inspect', arguments: { path: 'example-only.md' }, observation: 'Example text' }], lesson: 'Observe first; adapt the path.' }] },
  ...nodes] });
const repair = { id: 'repair', name: 'Recover', instruction: 'Observe existing effects before changing parameters.', priority: 8,
  when: [{ on: 'tool_result', outcome: 'failed' }] };
const verify = { id: 'verify', name: 'Verify', instruction: 'Read the actual file and self-check; then finish.', priority: 2,
  when: [{ on: 'tool_result', tools: ['write'], outcome: 'returned' }] };

function fixture(options = {}) {
  const registry = new ToolRegistry(), executions = options.executions ?? new ToolExecutionStore(), effects = [];
  const add = (name, execute = input => input, overrides = {}) => registry.register({
    definition: { name, description: name, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }, manifest,
    decodeInput: value => value, execute: context => { effects.push({ name, input: context.input }); return execute(context.input); }, ...overrides,
  });
  add('inspect', input => ({ ...(input.path ? { path: input.path } : {}), content: 'actual text' }));
  add('write', input => ({ ...(input.path ? { path: input.path } : {}), ok: true }));
  registerBuiltinToolDisclosure(registry); registerMcpDiscovery(registry);
  const coordination = options.coordination ?? new CoordinationStore(); registerCoordinationTools(registry, coordination);
  const manager = new UsageGuidance(registry, executions, options.directory, { coordination }); manager.register();
  const request = { protocol: 'bush.model_request.v1', requestId: 'req', sessionId: 's', turnId: 't', model: 'executor',
    messages: [{ role: 'user', content: 'Edit the actual document.' }], tools: registry.definitions(), metadata: options.metadata ?? {}, permissionMode: 'default' };
  const coordinator = new ToolExecutionCoordinator({ registry,
    permissions: options.permissions ?? { request: async () => { throw new Error('Unexpected permission request'); } },
  });
  let ordinal = 0;
  const call = async (input, name = 'usage', overrides = {}) => {
    request.tools = registry.definitions(); const current = { ...request, ...overrides };
    const sequence = ++ordinal;
    const toolCall = { protocol: 'bush.tool_call.v1', id: `call-${sequence}`, name, argumentsText: JSON.stringify(input) };
    const identity = { requestId: current.requestId, sessionId: current.sessionId, turnId: current.turnId, round: sequence, ordinal: 0 };
    const outcome = await coordinator.execute(toolCall, identity,
      undefined, { request: current, contextMessages: current.messages });
    // ModelRound journals root calls; the coordinator's completed observer is
    // reserved for nested calls. Mirror the root boundary in this fixture.
    executions.record(toolCall, identity, outcome);
    return outcome;
  };
  const returned = async (...args) => { const outcome = await call(...args); assert.equal(outcome.kind, 'returned', JSON.stringify(outcome)); return outcome.result; };
  const start = (usage = definition([repair, verify]), enabled = true) => returned({ action: 'import', expected_revision: 0, usage, enabled });
  const context = (messages = request.messages, overrides = {}) => manager.context({ ...request, tools: registry.definitions(), ...overrides }, messages);
  return { registry, executions, effects, add, coordination, manager, request, call, returned, start, context };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-usage-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

const plannedDefinition = () => ({ ...definition([verify, repair]), plan: ['work', 'verify'] });

test('native plan is the single progress state and selects current guidance after rename, reorder and patch', async () => {
  const f = fixture();
  const mounted = await f.start(plannedDefinition());
  assert.equal(f.coordination.getPlan('s'), undefined, 'loading supplies a template without silently changing the task');
  assert.equal(mounted.plan.phase, 'unbound');
  const template = mounted.plan.plan_template.input;
  let state = await f.returned({ ...template, nodes: template.nodes.map((node, index) => ({ ...node, status: index ? 'pending' : 'in_progress' })) }, 'update_task_plan');
  let view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.current_node, 'work');
  assert.equal(view.selected[0].reason.on, 'native_plan');
  assert.equal(view.plan.plan_template, undefined, 'a linked plan is not duplicated as another template');
  const [work, verifyNode] = state.plan.nodes;
  state = await f.returned({ action: 'patch', expected_revision: state.revision, updates: [
    { id: work.id, status: 'completed' }, { id: verifyNode.id, step: 'Inspect this task’s actual result', status: 'in_progress' },
  ] }, 'update_task_plan');
  view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.current_node, 'verify');
  assert.deepEqual(view.selected.map(node => node.id), ['verify']);
  assert.equal((await f.returned({ action: 'status' })).revision, 1, 'progress does not rewrite the manual');
  state = await f.returned({ action: 'replace', nodes: [...state.plan.nodes].reverse() }, 'update_task_plan');
  assert.equal(JSON.parse((await f.context()).content).plan.current_node, 'verify');
  state = await f.returned({ action: 'patch', expected_revision: state.revision, active: false, updates: [{ id: verifyNode.id, status: 'completed' }] }, 'update_task_plan');
  view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.phase, 'completed'); assert.deepEqual(view.selected, []);
  assert.equal(f.coordination.getPlan('s').revision, state.revision, 'guidance does not advance or verify a node');
});

test('adapted steps remain independent and old pack references cannot select guidance from a changed manual', async () => {
  const f = fixture();
  const mounted = await f.start(plannedDefinition());
  let state = await f.returned(mounted.plan.plan_template.input, 'update_task_plan');
  state = await f.returned({ action: 'patch', expected_revision: state.revision,
    append_nodes: [{ step: 'Extra work chosen for this task', status: 'in_progress' }] }, 'update_task_plan');
  let view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.phase, 'adapted'); assert.equal(view.plan.current_node, null); assert.deepEqual(view.selected, []);
  const extra = state.plan.nodes.at(-1);
  state = await f.returned({ action: 'patch', expected_revision: state.revision,
    updates: [{ id: extra.id, usage: state.plan.nodes[1].usage }] }, 'update_task_plan');
  assert.equal(JSON.parse((await f.context()).content).plan.current_node, 'verify');
  state = await f.returned({ action: 'patch', expected_revision: state.revision, updates: [{ id: extra.id, usage: null }] }, 'update_task_plan');
  assert.equal(state.plan.nodes.at(-1).usage, undefined);
  const changed = plannedDefinition(); changed.nodes[1].instruction = 'Changed teaching method.';
  await f.returned({ action: 'import', expected_revision: 1, usage: changed });
  view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.phase, 'unbound');
  assert.ok(view.plan.native_plan.nodes.filter(node => node.usage).every(node => node.matches_manual === false));
  assert.ok(view.plan.plan_template);
});

test('manual and native plan recover independently after restart or compaction without an extra progress write', async t => {
  const directory = await temporary(t), events = [];
  const persistence = { load: sessionId => structuredClone(events.filter(event => event.sessionId === sessionId)), append: event => events.push(structuredClone(event)) };
  const f = fixture({ directory, coordination: new CoordinationStore({ persistence }) });
  const mounted = await f.start(plannedDefinition());
  const template = mounted.plan.plan_template.input;
  const state = await f.returned({ ...template, nodes: template.nodes.map((node, index) => ({ ...node, status: index ? 'in_progress' : 'completed' })) }, 'update_task_plan');
  const original = await f.context();
  const next = fixture({ directory, coordination: new CoordinationStore({ persistence }) });
  const restored = await next.context([{ role: 'user', content: 'Continue after context compaction.' }]);
  assert.equal(JSON.parse(restored.content).plan.current_node, 'verify');
  assert.deepEqual(JSON.parse(restored.content).selected, JSON.parse(original.content).selected);
  assert.equal(next.coordination.getPlan('s').revision, state.revision);
  assert.equal(events.length, 1);
});

test('default plans reject unknown or duplicate nodes and native references reject malformed identities', async () => {
  assert.equal(usageDefinitionSchema.safeParse({ ...plannedDefinition(), plan: ['missing'] }).success, false);
  assert.equal(usageDefinitionSchema.safeParse({ ...plannedDefinition(), plan: ['work', 'work'] }).success, false);
  const f = fixture();
  assert.equal((await f.call({ nodes: [{ step: 'Bad reference', status: 'pending', usage: { usage_id: 'fixture', node_id: 'work', definition_sha256: 'old' } }] }, 'update_task_plan')).kind, 'failed');
  assert.equal(f.coordination.getPlan('s'), undefined);
});

test('the student can choose its own native plan without being repeatedly forced back to the default template', async () => {
  const f = fixture();
  await f.returned({ nodes: [{ step: 'Previous unrelated task', status: 'completed' }] }, 'update_task_plan');
  assert.equal((await f.start(plannedDefinition())).plan.phase, 'unbound', 'a pre-existing plan is not the new choice');
  await f.returned({ nodes: [{ step: 'A different approach for this task', status: 'in_progress' }] }, 'update_task_plan');
  const view = JSON.parse((await f.context()).content);
  assert.equal(view.plan.phase, 'adapted'); assert.equal(view.plan.plan_template, undefined); assert.deepEqual(view.selected, []);
  assert.equal((await f.returned({ action: 'status' })).revision, 1);
});

test('selecting the same manual for another task offers a fresh template without erasing the completed plan', async () => {
  const f = fixture(), pack = plannedDefinition();
  const mounted = await f.start(pack);
  const done = await f.returned({ nodes: mounted.plan.plan_template.input.nodes.map(node => ({ ...node, status: 'completed' })) }, 'update_task_plan');
  assert.equal(JSON.parse((await f.context()).content).plan.phase, 'completed');
  const next = await f.returned({ action: 'import', expected_revision: 1, usage: pack });
  assert.equal(next.plan.phase, 'unbound'); assert.equal(next.plan.plan_template.input.nodes.length, 2);
  assert.deepEqual(f.coordination.getPlan('s'), done);
});

test('large native plans defer plan details without dropping current-node teaching', async () => {
  const f = fixture(), pack = plannedDefinition();
  pack.id = 'x'.repeat(120);
  pack.nodes = Array.from({ length: 20 }, (_, index) => ({ id: `n${index}-` + 'x'.repeat(115), name: 'n'.repeat(120), instruction: 'i'.repeat(2800) }));
  pack.entry_node = pack.nodes[0].id; pack.plan = pack.nodes.map(node => node.id);
  pack.objective = 'o'.repeat(1000);
  pack.constraints = [{ source: 's'.repeat(900), text: 'c'.repeat(2000) }];
  await f.start(pack);
  let message = await f.context(), view = JSON.parse(message.content);
  assert.equal(view.enabled, true); assert.ok(view.deferred_plan); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  const status = await f.returned({ action: 'status' });
  assert.equal(status.plan.plan_template.input.nodes.length, 20);
  await f.returned({ ...status.plan.plan_template.input, nodes: status.plan.plan_template.input.nodes.map((node, i) => ({ ...node, step: 'Long task description '.repeat(100), status: i ? 'pending' : 'in_progress' })) }, 'update_task_plan');
  message = await f.context(); view = JSON.parse(message.content);
  assert.equal(view.enabled, true); assert.equal(view.plan.current_node, pack.entry_node); assert.ok(view.deferred_plan);
  assert.equal(view.selected[0].id, pack.entry_node); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  assert.equal((await f.returned({ action: 'status' })).plan.native_plan.nodes.length, 20);
});

test('disclosed usage schema describes minimal caller input and status distinguishes absent from disabled packs', async () => {
  const f = fixture();
  const empty = await f.returned({ action: 'status' });
  assert.equal(empty.installed, false); assert.equal(empty.scope, 'session'); assert.equal(empty.revision, 0);
  const loaded = await f.returned({ name: 'usage' }, 'get_tool_schema');
  const schema = loaded.matches[0].definition.inputSchema;
  const importer = (schema.oneOf ?? schema.anyOf).find(item => item.properties.action.const === 'import');
  assert.deepEqual(importer.required.sort(), ['action', 'expected_revision', 'usage']);
  assert.deepEqual(importer.properties.usage.required.sort(), ['entry_node', 'id', 'name', 'nodes', 'objective', 'protocol']);
  const node = importer.properties.usage.properties.nodes.items;
  assert.deepEqual(node.required.sort(), ['id', 'instruction', 'name']);
  assert.deepEqual(node.properties.decisions.items.required.sort(), ['choice', 'reason', 'situation']);
  const minimal = { protocol: 'bush.usage.v1', id: 'minimal', name: 'Observe before editing', objective: 'Preserve current content', entry_node: 'work',
    nodes: [{ id: 'work', name: 'Observe', instruction: 'Read the current file before editing.',
      decisions: [{ situation: 'A file may already contain user changes.', choice: 'Read it first.', reason: 'Use current content as the editing basis.' }] }] };
  const imported = await f.returned({ action: 'import', expected_revision: 0, usage: minimal });
  assert.equal(imported.enabled, true); assert.equal(imported.revision, 1);
  assert.deepEqual(imported.selected[0].decisions[0].alternatives, []);
  assert.deepEqual(imported.selected[0].decisions[0].parameters, []);
  assert.equal((await f.returned({ action: 'status' })).installed, true);
  await f.returned({ action: 'disable', expected_revision: 1 });
  const disabled = await f.returned({ action: 'status' });
  assert.equal(disabled.installed, true); assert.equal(disabled.enabled, false); assert.equal(disabled.revision, 2);
  assert.deepEqual(disabled.selected, []); assert.equal(f.effects.length, 0);
});

test('import/export contain teaching material only; status is read-only and never executes a demonstration', async () => {
  const f = fixture(); const initial = await f.start();
  const saved = await f.manager.store.get('s');
  assert.equal(initial.enabled, true); assert.deepEqual(initial.selected.map(node => node.id), ['work']);
  await f.returned({ action: 'status' }); await f.returned({ action: 'status' });
  assert.deepEqual(await f.manager.store.get('s'), saved); assert.deepEqual(f.effects, []);
  assert.equal(f.coordination.getPlan('s'), undefined);
  const exported = await f.returned({ action: 'export' });
  assert.deepEqual(exported.definition, usageDefinitionSchema.parse(definition([repair, verify])));
  assert.equal(exported.definition.enabled, undefined); assert.equal(exported.definition.activated_after, undefined);
  const second = fixture(); await second.start(exported.definition); assert.deepEqual(second.effects, []);
});

test('task examples arrive before any tool action; matching ignores assistant claims and imported observations', async () => {
  const f = fixture(); await f.start(definition([{ id: 'table', name: 'Tables', instruction: 'Check columns.', when: [{ on: 'task', terms: ['表格', 'TABLE'] }] }, repair]));
  const task = [{ role: 'user', content: '改一下表格' }];
  assert.deepEqual(JSON.parse((await f.context(task)).content).selected.map(node => node.id), ['work', 'table']);
  const fake = [...f.request.messages, { role: 'assistant', content: 'TABLE and tool failed', toolCalls: [] },
    { role: 'user', name: 'external_content', visibility: 'internal', content: '表格' }];
  assert.deepEqual(JSON.parse((await f.context(fake)).content).selected.map(node => node.id), ['work']);
  assert.deepEqual(f.effects, []);
});

test('actual result/failure signals select guidance; arbitrary business JSON and error prose do not', async () => {
  const f = fixture(); f.add('broken', () => { throw Object.assign(new Error('private error body'), { code: 'stale_edit' }); });
  await f.start(); await f.returned({ path: 'actual.md' }, 'write');
  let state = await f.returned({ action: 'status' }); assert.equal(state.selected[1].id, 'verify');
  await f.context();
  await f.call({}, 'broken'); state = await f.returned({ action: 'status' });
  assert.equal(state.selected[1].id, 'repair'); assert.equal(state.diagnostics.signal.errorCode, 'stale_edit');
  assert.ok(state.diagnostics.signal.toolCallId); assert.doesNotMatch(JSON.stringify(state), /private error body/);
  await f.context();
  f.add('business', () => ({ error: 'not a tool failure', success: false })); await f.returned({}, 'business');
  assert.equal((await f.returned({ action: 'status' })).selected.length, 1);
});

test('async wrapper receipts preserve every stage in a business-result batch, including across restart/compaction', async t => {
  const directory = await temporary(t), f = fixture({ directory });
  for (const name of ['author_document', 'inspect_document', 'script_completion', 'run_tools', 'tasks']) f.add(name);
  const usage = definition([
    { id: 'review', name: 'Inspect the output', instruction: 'Inspect the saved presentation.', when: [{ on: 'tool_result', tools: ['author_document'], outcome: 'returned' }] },
    { id: 'visual', name: 'Review pixels', instruction: 'Render and inspect every slide.', when: [{ on: 'tool_result', tools: ['inspect_document'], outcome: 'returned' }] }, repair,
  ]);
  await f.start(usage); await f.context();
  await f.returned({}, 'author_document'); await f.returned({}, 'script_completion'); await f.returned({}, 'tasks');
  await f.returned({}, 'inspect_document'); await f.returned({}, 'run_tools');
  const before = await f.manager.store.get('s');
  const status = await f.returned({ action: 'status' });
  assert.deepEqual(status.selected.map(node => node.id), ['work', 'review', 'visual']);
  const hint = await f.context(); assert.deepEqual(JSON.parse(hint.content).selected.map(node => node.id), ['work', 'review', 'visual']);
  assert.deepEqual(await f.manager.store.get('s'), before, 'delivery does not change definition revisions');
  await f.returned({}, 'tasks'); assert.equal(await f.context([hint]), undefined);
  const restarted = fixture({ directory, executions: f.executions });
  assert.deepEqual(await restarted.context([]), hint, 'compaction restores the same batch, not just its last receipt');
  f.add('broken_wrapper', () => { throw Object.assign(Error('failed dispatch'), { code: 'dispatch_failed' }); });
  f.registry.resolve('run_tools').execute = () => { throw Object.assign(Error('failed dispatch'), { code: 'dispatch_failed' }); };
  await f.call({}, 'run_tools');
  assert.deepEqual(JSON.parse((await f.context([hint])).content).selected.map(node => node.id), ['work', 'repair']);
});

test('same-tool parallel success cannot conceal another failure; the next observed result batch replaces it', async () => {
  const f = fixture(); let failed = true;
  f.add('retry', () => { if (failed) throw Error('first attempt failed'); return {}; });
  await f.start(); await f.call({}, 'retry'); failed = false; await f.returned({}, 'retry');
  const first = await f.context();
  assert.deepEqual(JSON.parse(first.content).selected.map(node => node.id), ['work','repair']);
  await f.returned({}, 'retry');
  assert.deepEqual(JSON.parse((await f.context([first])).content).selected.map(node => node.id), ['work']);
});

test('parallel matches stay bounded without withdrawing the pack and deferred lessons remain discoverable', async () => {
  const f = fixture();
  await f.start(definition(Array.from({length:10}, (_, index) => ({ id:`review-${index}`, name:`Review ${index}`,
    instruction:'x'.repeat(2800), when:[{on:'tool_result',tools:['write'],outcome:'returned'}] }))));
  await f.returned({},'write');
  const message = await f.context(), view = JSON.parse(message.content);
  assert.equal(view.enabled,true); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  assert.equal(view.selected.length + view.deferred_lessons.length,11);
  assert.ok(view.selected.length > 1 && view.deferred_lessons.length > 0);
});

test('MCP declared errors and unsuccessful terminal exits select failure guidance', async () => {
  for (const [name, result] of [['mcp__example__write', { isError: true, content: [{ type: 'text', text: 'failure' }] }],
    ['terminal_exec', { state: 'completed', exitCode: 1 }]]) {
    const f = fixture(); f.add(name, () => result); await f.start(); await f.returned({}, name);
    assert.equal((await f.returned({ action: 'status' })).selected[1].id, 'repair');
  }
});

test('specific error hints take precedence within the same priority and guidance stays bounded', async () => {
  const f = fixture(); f.add('broken', () => { throw Object.assign(new Error('bad edit'), { code: 'stale_edit' }); });
  await f.start(definition([repair, { id: 'specific', name: 'Read fresh content', instruction: 'Read before retry.', priority: 8,
    when: [{ on: 'tool_result', tools: ['broken'], outcome: 'failed', error_codes: ['stale_edit'] }] }]));
  await f.call({}, 'broken');
  const message = await f.context(); assert.equal(JSON.parse(message.content).selected[1].id, 'specific');
  assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
});

test('normal tool calls keep their live parameters and remain autonomous outside the examples', async () => {
  const f = fixture(); await f.start();
  const state = await f.manager.store.get('s');
  await f.returned({ path: 'chosen-from-current-request.md', content: 'new live input' }, 'write');
  assert.equal(f.effects[0].input.path, 'chosen-from-current-request.md');
  assert.deepEqual(await f.manager.store.get('s'), state, 'native tool execution is not a plan transition');
  assert.equal(f.coordination.getPlan('s'), undefined);
});

test('focus is optional, revision-protected and independent of ordinary task plans', async () => {
  const f = fixture(); const state = await f.start();
  const plan = await f.returned({ nodes: [{ id: 'task', step: 'Independent work', status: 'in_progress' }] }, 'update_task_plan');
  const focused = await f.returned({ action: 'focus', expected_revision: state.revision, node_id: 'verify' });
  assert.equal(focused.selected[0].id, 'verify'); assert.deepEqual(f.coordination.getPlan('s'), plan);
  assert.equal((await f.call({ action: 'disable', expected_revision: state.revision })).error.code, 'usage_revision_conflict');
  const bad = await f.call({ action: 'focus', expected_revision: focused.revision, node_id: 'missing' }); assert.equal(bad.kind, 'failed');
  assert.equal((await f.returned({ action: 'status' })).revision, focused.revision);
  const reset = await f.returned({ action: 'focus', expected_revision: focused.revision, node_id: null }); assert.equal(reset.selected[0].id, 'work');
});

test('schema hints expose only current capabilities and never grant discovered-schema authority', async () => {
  const f = fixture({ metadata: { mcpToolDiscovery: true } });
  f.add('mcp__fixture__read', () => ({ ok: true }), { mcpHook: { server: 'fixture', tool: 'read', modelVisible: true, readOnly: true, call: async () => ({}) } });
  const usage = definition(); usage.nodes[0].capabilities.push({ tool: 'mcp__fixture__read', purpose: 'Observe' }, { tool: 'missing', purpose: 'Missing' });
  await f.start(usage); const before = structuredClone(f.request.metadata);
  const context = JSON.parse((await f.context()).content); const capabilities = context.selected[0].capabilities;
  assert.deepEqual(capabilities[1].load, { name: 'mcp_search', arguments: { action: 'load', query: 'mcp__fixture__read' } });
  assert.equal(capabilities[2].available, false); assert.deepEqual(f.request.metadata, before);
  assert.equal((await f.call({}, 'mcp__fixture__read')).error.code, 'mcp_discovery_required');
  assert.deepEqual(f.effects, []);
  const scoped = JSON.parse((await f.context([], { tools: f.registry.definitions().filter(tool => tool.name !== 'mcp__fixture__read') })).content);
  assert.equal(scoped.selected[0].capabilities[1].available, false);
});

test('plugin removal/schema changes refresh hints without changing provider declarations', async () => {
  const f = fixture(); const candidate = { definition: { name: 'optional_read', description: 'v1', inputSchema: { type: 'object' } }, manifest,
    decodeInput: x => x, execute: () => ({}) };
  f.registry.replaceOwned('extension:fixture', [candidate]);
  const usage = definition(); usage.nodes[0].capabilities = [{ tool: 'optional_read', purpose: 'Observe' }];
  await f.start(usage); const first = await f.context();
  f.registry.replaceOwned('extension:fixture', [{ ...candidate, definition: { ...candidate.definition, description: 'v2' } }]);
  const changed = await f.context([first]); assert.ok(changed); assert.match(changed.content, /v2/);
  f.registry.setOwnerEnabled('extension:fixture', false);
  assert.equal(JSON.parse((await f.context([changed])).content).selected[0].capabilities[0].available, false);
});

test('permission denial remains effective; guidance does not dispatch or retry a protected action', async () => {
  let effects = 0;
  const f = fixture({ permissions: { request: async () => ({ decision: 'deny', grantedCapabilityIds: [] }) } });
  f.add('protected_write', () => { effects++; return {}; }, { authorize: () => ({ kind: 'ask', request: { reason: 'write', actions: ['write'], targets: [], capabilityIds: [] } }) });
  await f.start(); const outcome = await f.call({}, 'protected_write'); assert.notEqual(outcome.kind, 'returned');
  await f.context(); await f.returned({ action: 'status' }); assert.equal(effects, 0);
});

test('unchanged guidance is deduplicated; compaction restores source constraints and relevant result guidance', async () => {
  const f = fixture(); await f.start(); await f.returned({ path: 'actual.md' }, 'write');
  const context = await f.context(); assert.equal(context.visibility, 'internal');
  assert.equal(await f.context([...f.request.messages, context]), undefined);
  const restored = await f.context([{ role: 'assistant', content: 'History compressed', toolCalls: [] }]);
  assert.deepEqual(restored, context);
  assert.deepEqual(JSON.parse(restored.content).constraints, definition().constraints);
  assert.equal(JSON.parse(restored.content).selected[1].id, 'verify');
  assert.match(restored.content, /Demonstrations.*other situations.*never current observations/);
});

test('compaction preserves task selection from the original request; newer user input takes precedence', async () => {
  const f = fixture();
  f.request.messages = [{ role: 'user', content: 'Edit this table.' }];
  await f.start(definition([{ id: 'table', name: 'Tables', instruction: 'Check columns.', when: [{ on: 'task', terms: ['table'] }] }]));
  const compacted = [{ role: 'assistant', content: 'History compressed', toolCalls: [] }];
  assert.equal(JSON.parse((await f.context(compacted)).content).selected[1].id, 'table');
  assert.deepEqual(JSON.parse((await f.context([...compacted, { role: 'user', content: 'Now edit the heading.' }])).content).selected.map(node => node.id), ['work']);
});

test('disable produces one withdrawal notice; reenabling ignores earlier and disabled-period actions', async () => {
  const f = fixture(); let state = await f.start(); const active = await f.context();
  state = await f.returned({ action: 'disable', expected_revision: state.revision });
  const disabled = await f.context([active]); assert.equal(JSON.parse(disabled.content).enabled, false);
  assert.equal(await f.context([active, disabled]), undefined); assert.equal(await f.context([]), undefined);
  await f.returned({}, 'write');
  state = await f.returned({ action: 'enable', expected_revision: state.revision });
  assert.deepEqual((await f.returned({ action: 'status' })).selected.map(node => node.id), ['work']);
  assert.equal(JSON.parse((await f.context([disabled])).content).enabled, true);
});

test('host A/B switch does not rewrite the stored pack or catalog', async () => {
  const f = fixture(); await f.start(); const saved = await f.manager.store.get('s'), active = await f.context();
  const disabled = await f.context([active], { metadata: { usageGuidanceEnabled: false } });
  assert.equal(JSON.parse(disabled.content).enabled, false); assert.deepEqual(await f.manager.store.get('s'), saved);
  assert.equal(JSON.parse((await f.context([disabled])).content).enabled, true);
});

test('sessions and child agents cannot inherit active usage state', async () => {
  const f = fixture(); await f.start();
  assert.equal(await f.context([], { sessionId: 'other' }), undefined);
  assert.equal(await f.context([], { metadata: { agentRole: 'child' } }), undefined);
  const child = await f.call({ action: 'status' }, 'usage', { metadata: { agentRole: 'child' } });
  assert.equal(child.error.code, 'child_agent_tool_unavailable');
});

test('persisted packs and focus survive restart; session removal removes the teaching state', async t => {
  const directory = await temporary(t), f = fixture({ directory }); let state = await f.start();
  state = await f.returned({ action: 'focus', expected_revision: state.revision, node_id: 'verify' });
  const restarted = fixture({ directory, executions: f.executions });
  const restored = await restarted.context(); assert.equal(JSON.parse(restored.content).selected[0].id, 'verify');
  await restarted.manager.removeSession('s'); assert.equal(await restarted.manager.store.get('s'), undefined);
  assert.equal(JSON.parse((await restarted.context([restored])).content).enabled, false);
});

test('a corrupt optional pack fails open with a deduplicated diagnostic', async t => {
  const directory = await temporary(t), f = fixture({ directory }); await f.start();
  const file = (await readdir(directory)).find(file => file.endsWith('.json')); await writeFile(join(directory, file), '{broken');
  const diagnostic = await f.context(); assert.equal(JSON.parse(diagnostic.content).unavailable, true);
  assert.equal(await f.context([diagnostic]), undefined);
  await f.returned({ path: 'still-allowed.md' }, 'inspect'); assert.equal(f.effects.length, 1);
  await f.manager.removeSession('s'); assert.equal(await f.manager.store.get('s'), undefined);
  await f.manager.removeSession('s');
});

test('schemas reject malformed packs, oversized lessons and imported runtime state', () => {
  for (const mutate of [value => { value.entry_node = 'missing'; }, value => { value.nodes.push(value.nodes[0]); },
    value => { value.enabled = true; }, value => { value.nodes[0].tool = 'fixed_dispatch'; },
    value => { value.nodes[0].when = [{ on: 'tool_result' }]; }, value => { value.nodes[0].instruction = 'x'.repeat(3001); }]) {
    const value = definition(); mutate(value); assert.equal(usageDefinitionSchema.safeParse(value).success, false);
  }
});

test('only selected lessons enter context; the default tool schema stays small', async () => {
  const f = fixture(); await f.start(definition(Array.from({ length: 23 }, (_, index) => ({ id: `n${index}`, name: `Lesson ${index}`,
    instruction: 'x'.repeat(2900), when: [{ on: 'task', terms: [`unmatched-${index}`] }] }))));
  const context = await f.context(); assert.ok(context.content.length < 5000); assert.equal(JSON.parse(context.content).selected.length, 1);
  const projected = projectBuiltinDefinitions(f.registry, f.request, f.registry.definitions()).find(tool => tool.name === 'usage');
  assert.ok(JSON.stringify(projected).length < 1800); assert.ok(JSON.stringify(f.registry.resolve('usage').definition).includes('demonstration') || JSON.stringify(f.registry.resolve('usage').definition).includes('examples'));
});

test('documented usage pack is portable and valid', async () => {
  const value = JSON.parse(await readFile(new URL('../../../docs/examples/document-edit.usage.json', import.meta.url), 'utf8'));
  assert.equal(usageDefinitionSchema.parse(value).entry_node, 'work');
  const design = JSON.parse(await readFile(new URL('../../../docs/examples/presentation-design-draft.usage.json', import.meta.url), 'utf8'));
  assert.equal(usageDefinitionSchema.parse(design).nodes[0].decisions.length, 1);
  const report = await fixture().returned({ action: 'review', usage: design });
  assert.equal(report.quality_verified, false);
  assert.ok(report.issues.some(issue => issue.code === 'outcome_not_assessed'));
});

test('teacher authoring is discoverable before import and transfers decisions without activating the draft', async t => {
  const directory = await temporary(t), teacher = fixture({ directory });
  const guide = await teacher.returned({ action: 'guide' });
  const pack = usageDefinitionSchema.parse(guide.template);
  assert.match(guide.template_note, /unassessed/);
  const methodDraft = structuredClone(guide.template);
  methodDraft.capabilities.push(...guide.recipe_example.capabilities);
  methodDraft.recipes = guide.recipe_example.recipes;
  Object.assign(methodDraft.nodes[0], guide.recipe_example.node_fields);
  const methodReview = await teacher.returned({ action: 'review', usage: methodDraft });
  assert.equal(methodReview.valid, true, 'the supplied method example must include its own dependency contract and lesson link');
  assert.ok(methodReview.issues.some(issue => issue.code === 'recipe_not_execution_verified'));
  assert.ok(!methodReview.issues.some(issue => ['missing_capability_contract', 'unreferenced_recipe', 'implementation_name_coupling'].includes(issue.code)));
  assert.equal((await teacher.returned({ action: 'status' })).revision, 0);
  await teacher.returned({ path: 'real-observation.md', private_argument: 'NEVER_EXPORT_ARGUMENT' }, 'inspect');
  const captured = await teacher.returned({ action: 'capture' });
  assert.equal(captured.evidence.length, 1);
  assert.doesNotMatch(JSON.stringify(captured), /NEVER_EXPORT_ARGUMENT|actual text|real-observation/);
  pack.evidence = captured.evidence;
  pack.nodes[0].examples[0].assessments[0].evidence_ids = [captured.evidence[0].id];
  const review = await teacher.returned({ action: 'review', usage: pack });
  assert.equal(review.valid, true); assert.equal(review.quality_verified, false);
  assert.equal(review.evidence[0].provenance, 'matched_local_receipt');
  assert.ok(review.issues.some(issue => issue.code === 'outcome_not_assessed'));
  assert.equal(await teacher.manager.store.get('s'), undefined);
  assert.equal(teacher.effects.length, 1, 'authoring must never execute the examples');
  const staged = await teacher.start(pack, false);
  assert.equal(staged.enabled, false); assert.equal(await teacher.context(), undefined);
  const snapshot = await teacher.manager.store.get('s');
  await teacher.returned({ action: 'review' });
  const exported = await teacher.returned({ action: 'export' });
  assert.deepEqual(await teacher.manager.store.get('s'), snapshot);
  assert.deepEqual(exported.definition, pack);
  assert.equal(teacher.coordination.getPlan('s'), undefined);
  const restarted = fixture({ directory, executions: teacher.executions });
  restarted.request.turnId = 'restarted-turn';
  assert.equal((await restarted.returned({ action: 'review' })).evidence[0].provenance, 'matched_local_receipt');
  assert.equal((await restarted.returned({ action: 'export' })).definition.nodes[0].decisions.length, 1);
  const student = fixture();
  await student.returned({ action: 'import', expected_revision: 0, usage: exported.definition }, 'usage', { sessionId: 'student' });
  const message = await student.context([], { sessionId: 'student' });
  const view = JSON.parse(message.content);
  assert.deepEqual(view.quality_criteria, pack.criteria);
  assert.deepEqual(view.selected[0].decisions, pack.nodes[0].decisions);
  assert.deepEqual(view.teaching_evidence, pack.evidence);
  assert.deepEqual(await student.context([{ role: 'assistant', content: 'History compacted', toolCalls: [] }], { sessionId: 'student' }), message);
  assert.equal(await student.context([message], { sessionId: 'student' }), undefined);
  assert.deepEqual(student.effects, []);
  assert.equal(student.coordination.getPlan('student'), undefined);
});

test('review separates execution success from teacher quality and keeps legacy packs usable', async () => {
  const f = fixture(), pack = definition();
  const report = await f.returned({ action: 'review', usage: pack });
  assert.equal(report.valid, true); assert.equal(report.quality_verified, false);
  for (const code of ['missing_outcome_criteria', 'missing_decision', 'unassessed_example', 'no_comparison']) {
    assert.ok(report.issues.some(issue => issue.code === code), code);
  }
  await f.start(pack); assert.equal(JSON.parse((await f.context()).content).enabled, true);
  assert.equal((await f.returned({ action: 'export' })).definition.id, pack.id);
  const draft = (await f.returned({ action: 'guide' })).template;
  draft.criteria[0].kind = 'process';
  const processOnly = await f.returned({ action: 'review', usage: draft });
  assert.equal(processOnly.coverage.outcome_criteria, 0);
  assert.ok(processOnly.issues.some(issue => issue.code === 'missing_outcome_criteria'));
});

test('invalid drafts return actionable diagnostics without modifying an installed pack', async () => {
  const f = fixture(); await f.start(); const before = await f.manager.store.get('s');
  const draft = (await f.returned({ action: 'guide' })).template;
  draft.nodes[0].decisions[0].criteria = ['missing'];
  const result = await f.returned({ action: 'review', usage: draft });
  assert.equal(result.valid, false); assert.equal(result.quality_verified, false);
  assert.match(result.issues[0].path, /nodes.0.decisions.0.criteria/);
  assert.deepEqual(await f.manager.store.get('s'), before);
  const empty = fixture(); assert.equal((await empty.returned({ action: 'review' })).valid, false);
  const malformed = await empty.returned({ action: 'review', usage: null });
  assert.equal(malformed.valid, false); assert.equal(await empty.manager.store.get('s'), undefined);
});

test('capture stays within its session, excludes administration, preserves failure provenance and supports prior turns', async () => {
  const f = fixture();
  await f.returned({ secret: 'FOREIGN_PAYLOAD' }, 'write', { sessionId: 'foreign' });
  await f.returned({ secret: 'PRIOR_PAYLOAD' }, 'write', { turnId: 'prior' });
  f.add('mcp__fixture__bad', () => ({ isError: true, content: [{ type: 'text', text: 'PRIVATE_ERROR_BODY' }] }));
  await f.returned({}, 'mcp__fixture__bad');
  f.add('checkpoint_context', () => ({ ok: true }));
  await f.returned({}, 'checkpoint_context');
  await f.returned({ name: 'usage' }, 'get_tool_schema');
  await f.returned({ action: 'guide' });
  await f.call({ action: 'capture', tool_call_ids: ['missing'] });
  const latest = await f.returned({ action: 'capture' });
  assert.equal(latest.evidence.length, 1); assert.match(latest.evidence[0].description, /failed/);
  assert.doesNotMatch(JSON.stringify(latest), /FOREIGN_PAYLOAD|PRIOR_PAYLOAD|PRIVATE_ERROR_BODY/);
  const prior = await f.returned({ action: 'capture', turn_id: 'prior' });
  assert.equal(prior.evidence.length, 1); assert.equal(prior.evidence[0].source.turn_id, 'prior');
  const duplicate = await f.returned({ action: 'capture', turn_id: 'prior', tool_call_ids: Array(2).fill(prior.evidence[0].source.tool_call_id) });
  assert.deepEqual(duplicate.evidence, prior.evidence);
  assert.equal((await f.call({ action: 'capture', tool_call_ids: ['call-1'] })).error.code, 'usage_evidence_not_found');
  assert.equal((await f.call({ action: 'capture', session_id: 'foreign' })).kind, 'failed');
});

test('receipt fingerprints detect mismatches, foreign locators are not read and visual assessments need visible evidence', async () => {
  const f = fixture(); await f.returned({}, 'write');
  const pack = (await f.returned({ action: 'guide' })).template;
  const receipt = (await f.returned({ action: 'capture' })).evidence[0];
  pack.evidence = [receipt];
  const assessment = pack.nodes[0].examples[0].assessments[0];
  Object.assign(assessment, { verdict: 'pass', observation: 'Author claim only', evidence_ids: [receipt.id] });
  let report = await f.returned({ action: 'review', usage: pack });
  assert.equal(report.quality_verified, false);
  assert.ok(report.issues.some(issue => issue.code === 'visual_evidence_missing'));
  receipt.source.sha256 = '0'.repeat(64);
  report = await f.returned({ action: 'review', usage: pack });
  assert.ok(report.issues.some(issue => issue.code === 'receipt_mismatch'));
  assert.equal(report.evidence[0].provenance, 'missing_or_changed');
  receipt.source.session_id = 'foreign';
  const get = f.executions.get.bind(f.executions);
  f.executions.get = (session, ...args) => { assert.notEqual(session, 'foreign'); return get(session, ...args); };
  report = await f.returned({ action: 'review', usage: pack });
  assert.equal(report.evidence[0].provenance, 'external_receipt_not_checked');
  assert.equal(report.quality_verified, false);
});

test('controlled comparison and render references survive transfer without fabricated asset or quality verification', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.evidence = ['before', 'after'].map(id => ({ id, description: 'Synthetic test fixture, not an observed teacher sample.', source: { kind: 'asset', path: `renders/${id}.png` } }));
  const example = pack.nodes[0].examples[0];
  example.comparison = { before: 'before', after: 'after', held_constant: 'Same content, audience and page size.', changed: 'Rebalanced the title and supporting regions.' };
  example.assessments = [{ criterion: 'hierarchy', verdict: 'mixed', observation: 'Synthetic author observation for the contract test.', evidence_ids: ['before', 'after'] }];
  const result = await f.returned({ action: 'review', usage: pack });
  assert.equal(result.coverage.comparisons, 1); assert.equal(result.coverage.assessed_outcomes, 1);
  assert.equal(result.quality_verified, false); assert.ok(result.evidence.every(item => item.provenance === 'not_opened'));
  assert.ok(!result.issues.some(issue => ['no_comparison', 'unsupported_assessment', 'visual_evidence_missing'].includes(issue.code)));
  await f.start(pack, false); const exported = await f.returned({ action: 'export' });
  assert.equal(exported.assets_to_package.length, 2); assert.deepEqual(exported.definition.nodes[0].examples[0].comparison, example.comparison);
  assert.deepEqual(f.effects, [], 'review/export must not attempt to open or copy referenced assets');
});

test('teaching references reject dangling IDs and unsafe asset paths; drafts remain explicitly unreviewed', async () => {
  const f = fixture(), template = (await f.returned({ action: 'guide' })).template;
  for (const path of ['../before.png', '/before.png', 'C:/before.png', 'renders\\before.png', 'https://example.test/before.png', 'renders/./before.png']) {
    const pack = structuredClone(template); pack.evidence = [{ id: 'asset', description: 'Example', source: { kind: 'asset', path } }];
    assert.equal(usageDefinitionSchema.safeParse(pack).success, false, path);
  }
  for (const mutate of [
    pack => { pack.nodes[0].examples[0].assessments[0].evidence_ids = ['missing']; },
    pack => { pack.nodes[0].examples[0].assessments[0].criterion = 'missing'; },
    pack => { pack.criteria.push(pack.criteria[0]); },
    pack => { pack.nodes[0].examples[0].comparison = { before: 'missing', after: 'other', held_constant: 'Same', changed: 'Layout' }; },
  ]) {
    const pack = structuredClone(template); mutate(pack); assert.equal(usageDefinitionSchema.safeParse(pack).success, false);
  }
});

test('review detects unavailable target APIs even if an old request still declares them', async () => {
  const f = fixture();
  const registered = { definition: { name: 'teacher_api', description: 'Teacher only', inputSchema: { type: 'object' } }, manifest, decodeInput: x => x, execute: () => ({}) };
  f.registry.replaceOwned('extension:teacher', [registered]);
  const frozenTools = f.registry.definitions();
  const pack = (await f.returned({ action: 'guide' })).template;
  pack.nodes[0].capabilities = [{ tool: 'teacher_api', purpose: 'Read the actual result' }];
  assert.ok(!(await f.returned({ action: 'review', usage: pack })).issues.some(issue => issue.code === 'target_capability_unavailable'));
  f.registry.setOwnerEnabled('extension:teacher', false);
  const result = await f.returned({ action: 'review', usage: pack }, 'usage', { tools: frozenTools });
  assert.ok(result.issues.some(issue => issue.code === 'target_capability_unavailable'));
});

test('review warns about dead recall rules using the same policy as sampling and automatic guidance', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.nodes[0].when = [
    { on: 'tool_result', tools: ['run_tools'], outcome: 'returned' },
    { on: 'tool_result', tools: ['get_tool_schema'], outcome: 'failed' },
    { on: 'tool_result', tools: ['invented_author_api'], outcome: 'returned' },
    { on: 'tool_result', tools: ['run_tools'], outcome: 'failed' },
  ];
  const report = await f.returned({ action: 'review', usage: pack });
  assert.equal(report.issues.filter(issue => issue.code === 'ignored_trigger').length, 2);
  assert.ok(report.issues.some(issue => issue.code === 'trigger_tool_unavailable' && issue.message.includes('invented_author_api')));
});

test('only evidence referenced by selected examples enters student context', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.evidence = ['current', 'other'].map(id => ({ id, description: id, source: { kind: 'reference', locator: `${id}-example` } }));
  pack.nodes[0].examples[0].assessments[0].evidence_ids = ['current'];
  const other = structuredClone(pack.nodes[0]); other.id = 'other'; other.when = [{ on: 'task', terms: ['unmatched'] }];
  other.examples[0].assessments[0].evidence_ids = ['other']; pack.nodes.push(other);
  await f.start(pack); const view = JSON.parse((await f.context()).content);
  assert.deepEqual(view.teaching_evidence.map(item => item.id), ['current']);
  assert.doesNotMatch(JSON.stringify(view), /other-example/);
});

test('guide, capture and draft review remain usable when saved optional guidance is corrupt', async t => {
  const directory = await temporary(t), f = fixture({ directory }); await f.start();
  const file = (await readdir(directory)).find(file => file.endsWith('.json')); await writeFile(join(directory, file), '{broken');
  const guide = await f.returned({ action: 'guide' });
  assert.equal((await f.returned({ action: 'review', usage: guide.template })).valid, true);
  assert.deepEqual((await f.returned({ action: 'capture' })).evidence, []);
});

test('large teaching evidence stays bounded without losing baseline decisions or quality criteria', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.evidence = Array.from({ length: 12 }, (_, i) => ({ id: `asset-${i}`, description: 'Description '.repeat(38), source: { kind: 'reference', locator: 'relative-evidence-'.repeat(38) + i } }));
  pack.nodes[0].examples[0].assessments = [0, 1].map(group => ({ criterion: 'hierarchy', verdict: 'unreviewed', observation: 'Not assessed.', evidence_ids: pack.evidence.slice(group * 6, group * 6 + 6).map(item => item.id) }));
  pack.constraints = [{ source: 'fixture', text: 'constraint '.repeat(170) }];
  pack.criteria = Array.from({ length: 6 }, (_, i) => ({ ...pack.criteria[0], id: i === 0 ? 'hierarchy' : `criterion-${i}`, inspect: 'Inspect actual result. '.repeat(16) }));
  pack.nodes[0].instruction += ' Observe actual output.'.repeat(85);
  const parsed = usageDefinitionSchema.parse(pack);
  await f.start(parsed);
  const message = await f.context(), view = JSON.parse(message.content);
  assert.equal(view.enabled, true); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  assert.deepEqual(view.quality_criteria, parsed.criteria);
  assert.deepEqual(view.selected[0].decisions, parsed.nodes[0].decisions);
  assert.ok(view.deferred_evidence.length > 0);
  assert.equal(view.teaching_evidence.length + view.deferred_evidence.length, 12);
  assert.equal((await f.returned({ action: 'export' })).definition.evidence.length, 12);
});

test('large criteria and long capability names cannot withdraw the baseline lesson', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.objective = 'o'.repeat(1000);
  pack.constraints = [{ source: 's'.repeat(900), text: 'c'.repeat(2000) }];
  pack.criteria = Array.from({ length: 8 }, (_, i) => ({ id: i === 0 ? 'hierarchy' : `criterion-${i}`, name: 'Quality', kind: 'outcome', method: 'visual', inspect: 'i'.repeat(200), accept: 'a'.repeat(200), revise: 'r'.repeat(60) }));
  pack.nodes[0].capabilities = Array.from({ length: 6 }, (_, i) => {
    const name = `tool-${i}-` + 'x'.repeat(193); f.add(name);
    f.registry.resolve(name).definition.description = 'd'.repeat(120);
    return { tool: name, purpose: 'p'.repeat(300) };
  });
  pack.nodes[0].instruction = 'i'.repeat(1000);
  pack.nodes.push(...Array.from({ length: 23 }, (_, i) => ({ id: `n${i}-` + 'x'.repeat(116), name: 'n'.repeat(120), instruction: 'i'.repeat(3000), when: [{ on: 'task', terms: ['edit'] }] })));
  await f.start(usageDefinitionSchema.parse(pack));
  const message = await f.context(), view = JSON.parse(message.content);
  assert.equal(view.enabled, true); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  assert.equal(view.selected.length + view.deferred_lessons.length, 24);
  assert.equal(view.quality_criteria.length, 8); assert.equal(view.selected[0].decisions.length, 1);
  assert.ok(view.selected[0].capabilities.every(item => item.available && item.invocation));
});

test('method and recommendation metadata cannot overflow the teaching budget', async () => {
  const f = fixture(), pack = (await f.returned({ action: 'guide' })).template;
  pack.criteria = Array.from({ length: 8 }, (_, i) => ({ id: i ? `c${i}` : 'hierarchy', name: 'Quality', kind: 'outcome', method: 'visual', inspect: 'i'.repeat(200), accept: 'a'.repeat(200), revise: 'r'.repeat(60) }));
  pack.objective = 'o'.repeat(1000); pack.constraints = [{ source: 's'.repeat(900), text: 'c'.repeat(2000) }];
  pack.capabilities = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}-` + 'x'.repeat(116), kind: 'tool', purpose: 'p'.repeat(300), recommendation: 'Choose a compatible local implementation.', query: 'document' }));
  pack.recipes = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}-` + 'x'.repeat(116), name: 'n'.repeat(120), description: 'Packaged implementation', parameters: [], code: 'return null;' }));
  pack.nodes[0].instruction = 'i'.repeat(1800); pack.nodes[0].recommendations = pack.capabilities.map(item => item.id); pack.nodes[0].recipes = pack.recipes.map(item => item.id);
  pack.nodes.push(...Array.from({ length: 23 }, (_, i) => ({ id: `n${i}-` + 'x'.repeat(116), name: 'n'.repeat(120), instruction: 'i'.repeat(3000), when: [{ on: 'task', terms: ['edit'] }] })));
  await f.returned({ action: 'import', expected_revision: 0, usage: usageDefinitionSchema.parse(pack), asset_root: 'C:/' + 'd'.repeat(1997) });
  const message = await f.context(), view = JSON.parse(message.content);
  assert.equal(view.enabled, true); assert.ok(message.content.length <= USAGE_CONTEXT_MAX_CHARS);
  assert.equal(view.quality_criteria.length, 8); assert.equal(view.selected[0].decisions.length, 1);
  assert.equal(view.methods.length, 6); assert.equal(view.recommended_capabilities.length, 6);
  assert.doesNotMatch(message.content, /return null/);
});

test('a real model loop autonomously reads, writes and checks a file with automatic hints and no teacher or completion gate', async t => {
  const directory = await temporary(t), source = join(directory, 'source.md'), output = join(directory, 'chosen-result.md');
  await writeFile(source, '# Original\nBody stays.\n');
  const registry = new ToolRegistry(), coordination = new CoordinationStore();
  const initialPlan = coordination.setPlan({ sessionId: 'live', expectedRevision: 0, plan: { protocol: 'bush.task_plan.v1', plan_id: 'manual', session_id: 'live', active: true,
    explanation: 'Separate progress', nodes: [{ id: 'edit', step: 'Edit document', status: 'in_progress' }] } });
  const pack = JSON.parse(await readFile(new URL('../../../docs/examples/document-edit.usage.json', import.meta.url), 'utf8'));
  const requests = [];
  const calls = [ ['get_tool_schema', { name: 'usage' }],
    ['call_tool', { name: 'usage', arguments: { action: 'import', expected_revision: 0, usage: pack } }],
    ['read_file', { path: source }], ['write_file', { path: output, content: '# Updated\nBody stays.\n' }], ['read_file', { path: output }] ];
  let host;
  t.after(async () => { await host?.sendCommand({ kind: 'runtime.shutdown', payload: {} }); });
  host = new InMemoryRuntimeHost({ toolRegistry: registry, coordinationStore: coordination, dataRoot: join(directory, 'runtime'), provider: {
    async *stream(request) {
      const index = requests.length; requests.push(structuredClone(request));
      const event = (sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: new Date().toISOString(), kind, ...extra });
      const action = calls[index];
      if (action) {
        yield event(0, 'tool_call_delta', { index: 0, toolCallId: `native-${index}`, nameDelta: action[0], argumentsDelta: JSON.stringify(action[1]) });
        yield event(1, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(0, 'text_delta', { delta: 'Updated the requested title and checked the saved file.' });
        yield event(1, 'response_completed', { finishReason: 'stop' });
      }
    },
  } });
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'live-request', sessionId: 'live', turnId: 'live-turn', model: 'executor-only',
    prefixMessages: [{ role: 'system', content: 'Fixed system prefix.' }],
    inputMessages: [{ messageId: 'live-input', message: { role: 'user', content: `Save an updated copy of ${source} to ${output}.` } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { projectDir: directory, planEnabled: true } });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result)); assert.equal(requests.length, 6);
  for (let index = 0; index < calls.length; index++) {
    const receipt = await host.sendCommand({ kind: 'runtime.get_tool_execution', payload: { sessionId: 'live', turnId: 'live-turn', toolCallId: `native-${index}` } });
    assert.equal(receipt.outcome, 'returned', JSON.stringify(receipt));
  }
  assert.equal(await readFile(output, 'utf8'), '# Updated\nBody stays.\n'); assert.equal(await readFile(source, 'utf8'), '# Original\nBody stays.\n');
  const hint = request => JSON.parse(request.messages.findLast(message => message.name === 'usage_guidance').content);
  assert.equal(hint(requests[2]).selected[0].id, 'work'); assert.equal(hint(requests[4]).selected[1].id, 'verify');
  assert.ok(requests.every(request => request.model === 'executor-only'));
  assert.ok(requests.every(request => JSON.stringify(request.tools) === JSON.stringify(requests[0].tools)));
  assert.ok(requests.every(request => request.messages[0].content === 'Fixed system prefix.'));
  assert.deepEqual(coordination.getPlan('live'), initialPlan);
  await host.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'live' } });
  assert.equal((await readdir(join(directory, 'runtime', 'usage-guidance'))).filter(file => file.endsWith('.json')).length, 0);
});
