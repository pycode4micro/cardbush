import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { usageDefinitionSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator, UsageGuidance, InMemoryRuntimeHost } from '../dist/index.js';
import { RuntimeAsyncJobs } from '../dist/runtimeAsyncJobs.js';
import { registerToolScript } from '../dist/toolScript.js';
import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import { registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/mcpToolDiscovery.js';
import { usageDefinitionHash } from '../dist/usageRecipes.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false };
const teaching = () => ({ protocol: 'bush.usage.v1', id: 'portable-note', name: 'Make a note', objective: 'Write and verify the requested note.', entry_node: 'compose',
  capabilities: [{ id: 'save-text', kind: 'tool', purpose: 'Save text as a document', recommendation: 'Use a text-file writer that preserves supplied content.', query: 'save text document file', contract: 'Accepts {path:string,content:string}, returns an object identifying the saved file.' }],
  recipes: [{ id: 'make-note', name: 'Build a titled note', description: 'A test method, not a quality-certified sample.', requires: ['save-text'],
    parameters: ['path', 'title', 'body'].map(name => ({ name, type: 'string', description: `Current ${name}` })),
    code: 'return await caps["save-text"]({path:input.path, content:"# " + input.title + "\\n\\n" + input.body + "\\n"});' }],
  nodes: [{ id: 'compose', name: 'Compose', instruction: 'Adapt business inputs to the actual task.', recommendations: ['save-text'], recipes: ['make-note'] },
    { id: 'check', name: 'Check the real file', instruction: 'Read the actual file and check title/body before delivery.', when: [{ on: 'recipe_result', recipes: ['make-note'], outcome: 'returned' }] },
    { id: 'recover', name: 'Recover', instruction: 'Inspect actual effects before retrying.', when: [{ on: 'recipe_result', recipes: ['make-note'], outcome: 'failed' }] }] });

test('legacy method completion identities survive the added empty default plan', () => {
  const parsed = usageDefinitionSchema.parse(teaching());
  const { plan, ...historical } = parsed;
  const previous = createHash('sha256').update(JSON.stringify(historical)).digest('hex');
  assert.equal(usageDefinitionHash(parsed), previous);
  assert.notEqual(usageDefinitionHash({ ...parsed, plan: ['compose', 'check'] }), previous);
});

async function fixture(t, writerName = 'local_document_writer') {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-usage-method-'));
  t.after(async () => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); await rm(directory, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), executions = new ToolExecutionStore(), deliveries = new Map(), controller = new AbortController();
  t.after(() => controller.abort());
  const manager = new UsageGuidance(registry, executions, join(directory, 'state')); manager.register();
  const jobs = new RuntimeAsyncJobs(executions, (_session, _turn, id, message) => deliveries.set(id, message));
  registerBuiltinToolDisclosure(registry); registerMcpDiscovery(registry);
  registerToolScript(registry, jobs, (context, input) => manager.prepareRecipe(context, input));
  let effects = 0;
  const add = (name, execute, extra = {}) => registry.register({ definition: { name, description: 'Save text document file with the supplied path and content.', inputSchema: { type: 'object' } }, manifest,
    decodeInput: input => input, execute, ...extra });
  add(writerName, async context => { effects++; await writeFile(context.input.path, context.input.content); return { path: context.input.path }; });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: [], messages: [{ role: 'user', content: 'Make the requested note.' }], metadata: {}, permissionMode: 'all_free' };
  const coordinator = new ToolExecutionCoordinator({ registry, observer: { completed: (call, identity, outcome) => executions.record(call, identity, outcome) } });
  let sequence = 0;
  const call = async (name, input, overrides = {}) => {
    request.tools = registry.definitions(); const current = { ...request, ...overrides };
    const toolCall = { protocol: 'bush.tool_call.v1', id: `call-${++sequence}`, name, argumentsText: JSON.stringify(input) };
    const identity = { requestId: 'r', sessionId: current.sessionId, turnId: current.turnId, round: 1, ordinal: sequence };
    const result = await coordinator.execute(toolCall, identity, undefined, { request: current, contextMessages: current.messages, signal: controller.signal });
    executions.record(toolCall, identity, result); return result;
  };
  const returned = async (...args) => { const result = await call(...args); assert.equal(result.kind, 'returned', JSON.stringify(result)); return result.result; };
  const start = (pack = teaching(), extra = {}) => returned('usage', { action: 'import', usage: pack, expected_revision: 0, ...extra });
  const complete = async usage => {
    const task = await returned('run_tools', { usage });
    return JSON.parse((await deliveries.get(task.task_id)).content);
  };
  const args = (extra = {}) => ({ recipe_id: 'make-note', expected_revision: 1, parameters: { path: join(directory, 'result.md'), title: 'Current title', body: 'Current body' }, bindings: { 'save-text': writerName }, ...extra });
  const context = (messages = request.messages) => manager.context({ ...request, tools: registry.definitions() }, messages);
  return { directory, registry, executions, manager, jobs, controller, request, deliveries, add, call, returned, start, complete, args, context, get effects() { return effects; } };
}

test('a teacher-packaged method writes a real file with business parameters on two differently named tool environments', async t => {
  for (const name of ['local_document_writer', 'vendor_export_note']) {
    const f = await fixture(t, name); const pack = teaching();
    assert.ok(!JSON.stringify(pack).includes(name)); await f.start(pack);
    const recommendation = await f.returned('usage', { action: 'recommend', capability_id: 'save-text' });
    assert.ok(recommendation.candidates.some(item => item.tool === name)); assert.equal(f.effects, 0);
    const method = await f.returned('usage', { action: 'recipe', recipe_id: 'make-note' });
    assert.equal(method.parameters_schema.properties.title.type, 'string'); assert.equal(method.invocation.tool, 'run_tools');
    const saved = await f.manager.store.get('s');
    const completion = await f.complete(f.args());
    assert.equal(completion.status, 'completed', JSON.stringify(completion));
    assert.equal(completion.result.value.execution.calls, 1);
    assert.equal(await readFile(f.args().parameters.path, 'utf8'), '# Current title\n\nCurrent body\n');
    assert.equal(f.effects, 1); assert.deepEqual(await f.manager.store.get('s'), saved);
    assert.ok(f.executions.listTurn('s', 't').some(record => record.toolCall.name === name));
    const hint = await f.context(), view = JSON.parse(hint.content);
    assert.deepEqual(view.selected.map(item => item.id), ['compose', 'check']);
    assert.doesNotMatch(hint.content, /return await caps/);
    assert.equal(await f.context([hint]), undefined);
    const restarted = new UsageGuidance(f.registry, f.executions, join(f.directory, 'state'));
    assert.deepEqual(await restarted.context(f.request, [{ role: 'assistant', content: 'Compacted', toolCalls: [] }]), hint);
    const captured = await f.returned('usage', { action: 'capture' });
    assert.ok(captured.evidence.some(item => item.description.includes('script_completion')));
    const exported = await f.returned('usage', { action: 'export' });
    assert.deepEqual(exported.definition, usageDefinitionSchema.parse(pack));
    assert.ok(!JSON.stringify(exported.definition).includes(name));
  }
});

test('parameter, binding, scope and revision errors fail before any packaged side effects', async t => {
  const f = await fixture(t); await f.start();
  for (const change of [
    { parameters: { ...f.args().parameters, title: 123 } }, { parameters: { ...f.args().parameters, unexpected: true } },
    { bindings: {} }, { bindings: { 'save-text': 'missing' } }, { bindings: { 'save-text': 'run_tools' } },
    { bindings: { 'save-text': 'local_document_writer', extra: 'local_document_writer' } }, { expected_revision: 0 },
  ]) {
    const failure = await f.call('run_tools', { usage: f.args(change) });
    assert.equal(failure.kind, 'failed'); assert.equal(failure.execution.effects, 'none');
    assert.equal(failure.execution.dispatch, 'not_started');
  }
  assert.equal((await f.call('run_tools', { usage: f.args() }, { metadata: { agentRole: 'child' } })).kind, 'failed');
  assert.equal((await f.call('run_tools', { usage: f.args() }, { sessionId: 'other' })).kind, 'failed');
  assert.equal((await f.call('run_tools', { usage: f.args() }, { tools: f.registry.definitions().filter(item => item.name !== 'local_document_writer') })).kind, 'failed');
  assert.equal(f.effects, 0); assert.equal(f.deliveries.size, 0);
});

test('object-shaped run_tools input still enforces one execution mode and accepts UI titles in either mode', async t => {
  const f = await fixture(t); await f.start();
  for (const input of [{}, { code: 'return 1;', usage: f.args() }, { code: null }, { usage: null },
    { code: '' }, { code: 'return 1;', extra: true }, { usage: f.args(), extra: true }, []]) {
    const result = await f.call('run_tools', input);
    assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'tool_arguments_schema_invalid');
    assert.equal(result.execution.dispatch, 'not_started'); assert.equal(result.execution.effects, 'none');
  }
  assert.equal(f.effects, 0); assert.equal(f.deliveries.size, 0);
  const title = { zh: '执行并检查方法', en: 'Run and inspect method' };
  const script = await f.returned('run_tools', { code: 'return {value:7};', _display_title: title });
  const scriptResult = JSON.parse((await f.deliveries.get(script.task_id)).content);
  assert.equal(scriptResult.status, 'completed'); assert.deepEqual(scriptResult.result.value.result, { value: 7 });
  const method = await f.returned('run_tools', { usage: f.args(), _display_title: title });
  assert.equal(JSON.parse((await f.deliveries.get(method.task_id)).content).status, 'completed');
  assert.equal(await readFile(f.args().parameters.path, 'utf8'), '# Current title\n\nCurrent body\n');
});

test('method input schemas keep default parameters and bindings optional for parameterless methods', async t => {
  const f = await fixture(t), pack = teaching();
  pack.recipes[0].parameters = []; pack.recipes[0].requires = []; pack.recipes[0].code = 'return {ok:true};';
  await f.start(pack);
  const schema = f.registry.resolve('run_tools').definition.inputSchema.properties.usage;
  assert.deepEqual(schema.required.sort(), ['expected_revision', 'recipe_id']);
  const completion = await f.complete({ recipe_id: 'make-note', expected_revision: 1 });
  assert.equal(completion.status, 'completed'); assert.deepEqual(completion.result.value.execution.result, { ok: true });
  assert.equal(f.effects, 0);
});

test('teacher wrappers cannot bypass declared capabilities or the selected tool permission policy', async t => {
  const denied = await fixture(t); denied.registry.resolve('local_document_writer').authorize = () => ({ kind: 'deny', code: 'denied', message: 'Denied' });
  await denied.start();
  const failure = await denied.complete(denied.args()); assert.equal(failure.status, 'failed'); assert.equal(denied.effects, 0);
  assert.deepEqual(JSON.parse((await denied.context()).content).selected.map(item => item.id), ['compose', 'recover']);
  const undeclared = await fixture(t); let extra = 0; undeclared.add('unexpected_tool', () => { extra++; return {}; });
  const pack = teaching(); pack.recipes[0].code = 'return await tools.unexpected_tool({});'; await undeclared.start(pack);
  assert.equal((await undeclared.complete(undeclared.args())).status, 'failed'); assert.equal(extra, 0); assert.equal(undeclared.effects, 0);
  const report = await undeclared.returned('usage', { action: 'review' });
  assert.ok(report.issues.some(issue => issue.code === 'recipe_implementation_coupling'));
});

test('recipe MCP bindings require current schema discovery and retain ordinary error handling', async t => {
  const f = await fixture(t, 'mcp__student__save');
  f.registry.resolve('mcp__student__save').mcpHook = { server: 'student', tool: 'save', modelVisible: true, readOnly: false, call: async () => ({}) };
  f.request.metadata.mcpToolDiscovery = true; await f.start();
  assert.equal((await f.call('run_tools', { usage: f.args() })).error.code, 'mcp_discovery_required'); assert.equal(f.effects, 0);
  const loaded = await f.returned('mcp_search', { action: 'load', query: 'mcp__student__save' });
  const record = f.executions.listTurn('s', 't').findLast(item => item.toolCall.name === 'mcp_search');
  f.request.messages.push({ role: 'assistant', content: '', toolCalls: [{ id: record.toolCall.id, name: record.toolCall.name, argumentsText: record.toolCall.argumentsText }] },
    { role: 'tool', toolCallId: record.toolCall.id, content: JSON.stringify(loaded) });
  synchronizeMcpDiscovery(f.registry, f.request, f.request.messages);
  assert.equal((await f.complete(f.args())).status, 'completed'); assert.equal(f.effects, 1);
});

test('method completion cannot recall a lesson for a replaced definition', async t => {
  const f = await fixture(t); const gate = Promise.withResolvers();
  f.registry.resolve('local_document_writer').execute = () => gate.promise;
  await f.start(); const task = await f.returned('run_tools', { usage: f.args() });
  const replacement = teaching(); replacement.nodes[0].instruction = 'New task and teaching definition';
  await f.returned('usage', { action: 'import', expected_revision: 1, usage: replacement });
  gate.resolve({ path: 'previous-task.md' });
  assert.equal(JSON.parse((await f.deliveries.get(task.task_id)).content).status, 'completed');
  assert.deepEqual(JSON.parse((await f.context()).content).selected.map(item => item.id), ['compose']);
});

test('packaged methods share cancellation and keep completed work in the native journal', async t => {
  const f = await fixture(t); const started = Promise.withResolvers();
  f.add('wait-tool', context => new Promise((resolve, reject) => { started.resolve(); context.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }); }));
  const pack = teaching(); pack.capabilities.push({ id: 'wait', purpose: 'Wait', recommendation: 'Observe completion', query: 'wait', contract: 'Waits until done.' });
  pack.recipes[0].requires.push('wait'); pack.recipes[0].code += '\n';
  pack.recipes[0].code = 'await caps["save-text"]({path:input.path,content:input.body}); return await caps.wait({});';
  await f.start(pack); const task = await f.returned('run_tools', { usage: f.args({ bindings: { 'save-text': 'local_document_writer', wait: 'wait-tool' } }) });
  await started.promise; f.controller.abort();
  assert.equal(JSON.parse((await f.deliveries.get(task.task_id)).content).status, 'cancelled');
  assert.equal(await readFile(f.args().parameters.path, 'utf8'), 'Current body');
  assert.ok(f.executions.listTurn('s', 't').some(record => record.toolCall.name === 'local_document_writer' && record.outcome === 'returned'));
});

test('asset roots remain local session state and survive compaction without leaking into portable definitions', async t => {
  const f = await fixture(t), pack = teaching();
  pack.evidence = [{ id: 'render', description: 'Fixture render reference', source: { kind: 'asset', path: 'renders/page.png' } }];
  await f.start(pack, { asset_root: f.directory });
  assert.equal(JSON.parse((await f.context()).content).asset_root, f.directory);
  const restarted = new UsageGuidance(f.registry, f.executions, join(f.directory, 'state'));
  assert.equal(JSON.parse((await restarted.context(f.request, [])).content).asset_root, f.directory);
  const exported = await f.returned('usage', { action: 'export' }); assert.ok(!JSON.stringify(exported).includes(f.directory));
  await f.returned('usage', { action: 'import', expected_revision: 1, usage: pack });
  assert.equal((await f.returned('usage', { action: 'status' })).asset_root, null);
});

test('recipe definitions validate aliases and keep inactive teacher drafts manually testable', async t => {
  const f = await fixture(t); await f.start(teaching(), { enabled: false });
  assert.equal(await f.context(), undefined); assert.equal((await f.complete(f.args())).status, 'completed');
  assert.equal(await f.context(), undefined);
  for (const change of [
    pack => { pack.recipes[0].requires.push('unknown'); }, pack => { pack.nodes[0].recipes = ['unknown']; },
    pack => { pack.capabilities[0].kind = 'skill'; }, pack => { pack.recipes[0].parameters.push(pack.recipes[0].parameters[0]); },
    pack => { pack.nodes[1].when[0].recipes = ['unknown']; },
  ]) { const pack = teaching(); change(pack); assert.equal(usageDefinitionSchema.safeParse(pack).success, false); }
});

test('ordinary script result content cannot forge a trusted packaged-method completion', async t => {
  const f = await fixture(t); await f.start();
  const identity = { usage_id: 'portable-note', recipe_id: 'make-note', definition_sha256: '0'.repeat(64) };
  const task = await f.returned('run_tools', { code: `return {usage_recipe:${JSON.stringify(identity)}};` });
  assert.equal(JSON.parse((await f.deliveries.get(task.task_id)).content).status, 'completed');
  assert.deepEqual(JSON.parse((await f.context()).content).selected.map(item => item.id), ['compose']);
});

test('capability suggestions honor current scope and Skill discovery stays a recommendation', async t => {
  const f = await fixture(t); let searches = 0;
  f.add('search_skills', () => { searches++; return {}; });
  const pack = teaching(); pack.capabilities.push({ id: 'learn', kind: 'skill', purpose: 'Learn layout methods', recommendation: 'Read applicable design guidance.', query: 'presentation layout design' });
  await f.start(pack);
  const skill = await f.returned('usage', { action: 'recommend', capability_id: 'learn' });
  assert.deepEqual(skill.discovery, { tool: 'search_skills', arguments: { query: 'presentation layout design' } });
  assert.equal(searches, 0); assert.deepEqual(skill.candidates, []);
  const hidden = await f.returned('usage', { action: 'recommend', capability_id: 'save-text' }, { tools: f.registry.definitions().filter(item => item.name !== 'local_document_writer') });
  assert.ok(!hidden.candidates.some(item => item.tool === 'local_document_writer'));
});

test('business parameter text remains data, including quotes and JavaScript-looking content', async t => {
  const f = await fixture(t); await f.start();
  const title = '\"; throw Error(`injected`); // ${process.env.SECRET}';
  const completion = await f.complete(f.args({ parameters: { ...f.args().parameters, title } }));
  assert.equal(completion.status, 'completed');
  assert.equal(await readFile(f.args().parameters.path, 'utf8'), `# ${title}\n\nCurrent body\n`);
});

test('documented layout method runs without implementation names and rejects unusable geometry', async t => {
  const f = await fixture(t), pack = JSON.parse(await readFile(new URL('../../../docs/examples/presentation-design-draft.usage.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(JSON.stringify(pack), /mcp__|plugin_pptx|"tool":/);
  await f.start(pack);
  const parameters = { width: 960, height: 540, margin: 32, gutter: 24, columns: 3 };
  const completion = await f.complete({ recipe_id: 'column-regions', expected_revision: 1, parameters, bindings: {} });
  assert.equal(completion.status, 'completed'); assert.equal(completion.result.value.execution.calls, 0);
  const regions = completion.result.value.execution.result.regions;
  assert.equal(regions.length, 3); assert.equal(regions[0].x, 32);
  for (let i = 1; i < regions.length; i++) assert.ok(Math.abs(regions[i].x - regions[i - 1].x - regions[i - 1].width - 24) < 1e-8);
  assert.ok(Math.abs(regions.at(-1).x + regions.at(-1).width - 928) < 1e-8);
  assert.ok(JSON.parse((await f.context()).content).selected.some(item => item.id === 'check-regions'));
  assert.equal((await f.complete({ recipe_id: 'column-regions', expected_revision: 1, parameters: { ...parameters, margin: 500 }, bindings: {} })).status, 'failed');
  assert.equal(f.effects, 0);
});

test('the host loop accepts a packaged method, delivers its completion and recalls inspection without a teacher model', async t => {
  const f = await fixture(t), registry = new ToolRegistry(), requests = [], output = join(f.directory, 'host-note.md');
  const setup = [['get_tool_schema', { name: 'usage' }],
    ['call_tool', { name: 'usage', arguments: { action: 'import', expected_revision: 0, usage: teaching() } }],
    ['usage', { action: 'recommend', capability_id: 'save-text' }], ['usage', { action: 'recipe', recipe_id: 'make-note' }],
    ['run_tools', { usage: { recipe_id: 'make-note', expected_revision: 1, parameters: { path: output, title: 'Host title', body: 'Host body' }, bindings: { 'save-text': 'write_file' } } }]];
  let read = false, host;
  t.after(async () => { await host?.sendCommand({ kind: 'runtime.shutdown', payload: {} }); });
  host = new InMemoryRuntimeHost({ toolRegistry: registry, dataRoot: join(f.directory, 'host'), provider: {
    async *stream(request) {
      const index = requests.length; assert.ok(index < 20, 'method completion must not loop indefinitely'); requests.push(structuredClone(request));
      const event = (sequence, kind, extra = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: new Date().toISOString(), kind, ...extra });
      let action = setup[index];
      if (!action && !read) {
        const completion = request.messages.findLast(item => item.name === 'background_tool_result' && item.content.includes('portable-note'));
        if (completion) { assert.equal(JSON.parse(completion.content).status, 'completed'); action = ['read_file', { path: output }]; read = true; }
        else {
          const task = request.messages.filter(item => item.role === 'tool').map(item => { try { return JSON.parse(item.content); } catch { return {}; } }).find(item => typeof item.task_id === 'string');
          assert.ok(task, 'script launch must expose the ordinary task handle'); action = ['tasks', { action: 'wait', task_ids: [task.task_id], yield_time_ms: 1000 }];
        }
      }
      if (action) {
        yield event(0, 'tool_call_delta', { index: 0, toolCallId: `host-${index}`, nameDelta: action[0], argumentsDelta: JSON.stringify(action[1]) });
        yield event(1, 'response_completed', { finishReason: 'tool_calls' });
      } else { yield event(0, 'text_delta', { delta: 'Saved and checked the note.' }); yield event(1, 'response_completed', { finishReason: 'stop' }); }
    },
  } });
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'host-request', sessionId: 'host-session', turnId: 'host-turn', model: 'executor-only',
    prefixMessages: [{ role: 'system', content: 'Fixed prefix.' }], inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Write and check the note.' } }],
    tools: registry.definitions(), permissionMode: 'all_free', metadata: { projectDir: f.directory } });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result));
  assert.equal(await readFile(output, 'utf8'), '# Host title\n\nHost body\n');
  assert.ok(requests.some(request => request.messages.some(item => item.name === 'usage_guidance' && JSON.parse(item.content).selected?.some(node => node.id === 'check'))));
  assert.ok(requests.every(request => request.model === 'executor-only' && JSON.stringify(request.tools) === JSON.stringify(requests[0].tools)));
});
