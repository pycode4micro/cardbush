import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ToolRegistry, RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore, registerMcpDiscovery,
  registerSkillTools, projectMcpDiscoveryResult, mcpToolWasDiscovered } from '../dist/index.js';
import { registerPluginCommandTools } from '../dist/pluginCommandTools.js';
import { registerSubagentOptions } from '../dist/subagentOptions.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { projectCatalogPage, discoveryDescription } from '../dist/catalogPage.js';
import { fitToolResultPage } from '../dist/toolResultBudget.js';
import { IndividuationStore } from '../dist/individuationStore.js';
import { registerIndividuationTools, deliveredMemoryIds } from '../dist/individuationTools.js';
import { normalizeIndividuation } from '@cardbush/bush-protocol';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false };
function fixture(count = 128) {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  for (let i = 0; i < count; i++) {
    const name = `mcp__photoshop__tool_${String(i).padStart(3, '0')}`;
    registry.register({ definition: { name, description: 'Edit Photoshop document layers and selections. '.repeat(30), inputSchema: { type: 'object', properties: {} } },
      manifest, decodeInput: input => input, execute: () => ({}), mcpHook: { server: 'photoshop', tool: name, call: async () => ({}) } });
  }
  const store = new ToolExecutionStore();
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), messages: [], metadata: { mcpToolDiscovery: true }, permissionMode: 'all_free' };
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
  let serial = 0;
  const run = async (calls, budget) => {
    request.tools = registry.definitions();
    const toolCalls = calls.map(([name, input]) => ({ protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(input) }));
    const result = await loop.execute(toolCalls, { round: serial, assistantMessageId: `a-${serial}`, request, contextMessages: [],
      ...(budget === undefined ? {} : { modelContextIngressBudgetTokens: budget }) });
    return { ...result, calls: toolCalls, pages: result.messages.map(message => JSON.parse(message.content)) };
  };
  return { registry, request, store, run };
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-page-delivery-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-page-delivery-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
function commands(count = 25) {
  return Array.from({ length: count }, (_, i) => ({ id: `fixture:command-${String(i).padStart(2, '0')}`, description: 'Plugin capability '.repeat(50),
    argumentHint: '[input]', userInvocable: true, disableModelInvocation: false, prompt: 'PRIVATE INSTRUCTIONS' }));
}

test('128-tool overview delivers three complete pages without archives or schemas', async () => {
  const { run, registry, request, store } = fixture();
  const names = []; let cursor, pages = 0, chars = 0;
  do {
    const result = await run([['mcp_search', cursor ? { cursor, limit: 50 } : { query: '*', server: 'photoshop', limit: 50 }]]);
    const page = result.pages[0], content = result.messages[0].content;
    assert.equal(page.archived, undefined); assert.equal(page.total, 128); assert.equal(page.server, 'photoshop');
    assert.equal(page._searchPage, undefined); assert.equal(page.protocol, undefined);
    assert.ok(content.length <= 16000); assert.ok(page.matches.length > 0);
    assert.ok(page.matches.every(item => item.description.length <= 180 && !item.inputSchema && item.loaded === false));
    assert.ok(store.get('s', 't', result.calls[0].id).result._searchPage, 'original paging provenance stays in the journal');
    names.push(...page.matches.map(item => item.name)); chars += content.length; pages++;
    cursor = page.next_cursor;
    assert.equal(page.more, Boolean(cursor));
  } while (cursor && pages < 10);
  assert.equal(pages, 3); assert.equal(names.length, 128); assert.equal(new Set(names).size, 128);
  assert.equal(mcpToolWasDiscovered(registry, request, names[0]), false);
  assert.ok(chars < 40000, `overview should remain compact: ${chars} chars`);
});

test('shared budget shortens complete pages and advances by delivered entries, including native last pages', async () => {
  const { registry, run, store } = fixture(12);
  registerPluginCommandTools(registry, async () => commands(12));
  const seen = [], seenCommands = []; let cursor, offset = 0, rounds = 0;
  do {
    const result = await run([
      ['mcp_search', cursor ? { cursor, limit: 50 } : { query: '*', limit: 50 }],
      ['list_plugin_commands', { offset, limit: 50 }],
    ], 2800);
    const [mcp, plugins] = result.pages;
    assert.ok(result.messages.reduce((n, m) => n + m.content.length, 0) <= 2800 - 128);
    for (const page of result.pages) assert.equal(page.archived, undefined);
    assert.ok(mcp.matches.length > 0); assert.ok(plugins.commands.length > 0);
    const native = store.get('s', 't', result.calls[0].id).result;
    assert.equal(native.more, false, 'requested page includes the entire tail');
    if (!rounds) { assert.ok(mcp.more, 'shortened last page gains a continuation'); assert.ok(native.matches.length > mcp.matches.length); }
    seen.push(...mcp.matches.map(item => item.name)); seenCommands.push(...plugins.commands.map(item => item.id));
    assert.equal(plugins.next_offset ?? plugins.total, offset + plugins.commands.length);
    cursor = mcp.next_cursor; offset = plugins.next_offset; rounds++;
    // Finish either list independently when their sizes differ.
    if (!cursor || offset === null) break;
  } while (rounds < 20);
  while (cursor) {
    const { pages: [page] } = await run([['mcp_search', { cursor }]], 1400);
    seen.push(...page.matches.map(item => item.name)); cursor = page.next_cursor;
  }
  while (offset !== null) {
    const { pages: [page] } = await run([['list_plugin_commands', { offset }]], 1400);
    seenCommands.push(...page.commands.map(item => item.id)); offset = page.next_offset;
  }
  assert.equal(seen.length, 12); assert.equal(new Set(seen).size, 12);
  assert.equal(seenCommands.length, 12); assert.equal(new Set(seenCommands).size, 12);
});

test('exhausted budget keeps a complete entry and usable cursor, and stale cursors still fail closed', async () => {
  const { run, registry } = fixture(5); const seen = []; let cursor;
  for (let i = 0; i < 5; i++) {
    const { pages: [page] } = await run([['mcp_search', cursor ? { cursor, limit: 50 } : { query: '*', limit: 50 }]], 0);
    assert.equal(page.archived, undefined); assert.equal(page.matches.length, 1);
    seen.push(page.matches[0].name); cursor = page.next_cursor;
  }
  assert.equal(cursor, undefined); assert.equal(new Set(seen).size, 5);
  const { pages: [first] } = await run([['mcp_search', { query: '*', limit: 50 }]], 0);
  registry.resolve(seen[0]).definition.description = 'Changed catalog definition';
  const { pages: [stale] } = await run([['mcp_search', { cursor: first.next_cursor }]]);
  assert.match(JSON.stringify(stale), /cursor_stale|results changed/);
});

test('skill lookup adds budget-aware continuation without losing names, file locations, or visibility', async t => {
  const root = await temporary(t), { registry, request, run } = fixture(0);
  for (let i = 0; i < 14; i++) {
    const name = `drawing-${String(i).padStart(2, '0')}`, path = join(root, name);
    await mkdir(path);
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: "${'Drawing workflow '.repeat(80)} marker-${i}"\n---\nPRIVATE SKILL INSTRUCTIONS`);
  }
  registerSkillTools(registry, [root]); request.metadata.disabledSkills = ['drawing-13'];
  const seen = []; let offset = 0;
  do {
    const result = await run([['search_skills', { query: 'drawing', offset, limit: 50 }]], 1500), page = result.pages[0];
    assert.equal(page.total, 13); assert.equal(page.archived, undefined); assert.ok(page.matches.length > 0);
    assert.doesNotMatch(result.messages[0].content, /PRIVATE SKILL INSTRUCTIONS/);
    for (const match of page.matches) assert.equal(match.mainResource, join(root, match.name, 'SKILL.md'));
    seen.push(...page.matches.map(item => item.name)); offset = page.next_offset;
  } while (offset !== null && seen.length <= 13);
  assert.equal(offset, null); assert.equal(seen.length, 13); assert.equal(new Set(seen).size, 13);
  const { pages: [tailMatch] } = await run([['search_skills', { query: 'marker-12' }]]);
  assert.equal(tailMatch.matches[0].name, 'drawing-12', 'ranking still searches beyond the preview');
  assert.throws(() => registry.resolve('search_skills').decodeInput({ query: 'drawing', offset: -1 }));
});

test('grouped employee pages preserve native kind order across delivery cuts', async () => {
  const { registry, run } = fixture(0);
  registerSubagentOptions(registry, {
    agents: { list: async () => Array.from({ length: 4 }, (_, i) => ({ definition: { id: `employee-${i}`, name: `Employee ${i}`, description: 'Registered capability '.repeat(30), enabled: true } })) },
    loadPluginAgents: async () => Array.from({ length: 4 }, (_, i) => ({ id: `role-${i}`, description: 'Plugin role capability '.repeat(30) })),
  });
  let offset = 0; const seen = [];
  do {
    const { pages: [page] } = await run([['list_subagent_options', { section: 'agents', offset }]], 1300);
    assert.equal(page.archived, undefined);
    const items = [...page.agent_roles, ...page.registered_agents, ...page.remote_agents];
    assert.ok(items.length); seen.push(...items.map(item => item.id)); offset = page.next_offset;
  } while (offset !== null && seen.length <= 8);
  assert.deepEqual(seen, [...Array.from({ length: 4 }, (_, i) => `role-${i}`), ...Array.from({ length: 4 }, (_, i) => `employee-${i}`)]);
});

test('task revisions describe only delivered handles; explicit full reads remain full', async () => {
  const { registry, run, store } = fixture(0);
  const tasks = new RuntimeTaskTools(async () => 'snapshot');
  tasks.addSource(async () => Array.from({ length: 12 }, (_, i) => ({ task_id: `task-${i}`, kind: 'script', status: 'completed', revision: '1',
    summary: 'Task summary '.repeat(18), result: 'FULL TASK RESULT '.repeat(2000) })));
  tasks.register(registry);
  const { pages: [page] } = await run([['tasks', { action: 'list' }]], 1200);
  assert.equal(page.archived, undefined); assert.ok(page.tasks.length < 12);
  assert.deepEqual(Object.keys(page.after), page.tasks.map(task => task.task_id));
  const detail = await run([['tasks', { action: 'inspect', task_ids: ['task-0'] }]], 1200);
  assert.equal(detail.pages[0].archived, true);
  assert.equal(store.get('s', 't', detail.calls[0].id).result.tasks[0].result, 'FULL TASK RESULT '.repeat(2000));
});

test('memory lookup keeps omitted IDs addressable without advancing past unseen records silently', async t => {
  const root = await temporary(t), { registry, request, run, store: journal } = fixture(0);
  const settings = normalizeIndividuation({ habits: true, predictions: true });
  const memory = new IndividuationStore(join(root, 'memory.sqlite'));
  registerIndividuationTools(registry, memory.path, { store: memory, schedule() {} });
  request.metadata.individuation = settings;
  for (let i = 0; i < 7; i++) await memory.summarize({ habit: { text: `偏好 ${i}：` + '需要清晰完整的工作记录。'.repeat(12) } }, settings,
    { sessionId: 'source', turnId: 'source', operationId: `habit-${i}` });
  const known = new Set(), omitted = []; let cursor;
  do {
    const result = await run([['check_habit', { mode: 'list', kind: 'habit', ...(cursor ? { cursor } : {}) }]], 0);
    const page = result.pages[0], native = journal.get('s', 't', result.calls[0].id).result;
    assert.equal(page.archived, undefined); assert.equal(page.matched_count, 7);
    assert.equal(page.next_cursor, native.next_cursor, 'stable keyset cursor still identifies the next native page');
    const ids = [...page.memories, ...(page.omitted ?? [])].map(record => record.id);
    assert.equal(ids.length, new Set(ids).size);
    for (const id of ids) { assert.ok(!known.has(id)); known.add(id); }
    omitted.push(...(page.omitted ?? []).map(record => record.id));
    assert.deepEqual(deliveredMemoryIds([{ role: 'assistant', content: '', toolCalls: result.calls }, ...result.messages]), page.memories.map(record => record.id));
    cursor = page.next_cursor;
  } while (cursor && known.size <= 7);
  assert.equal(known.size, 7); assert.ok(omitted.length > 0);
  const full = await run([['check_habit', { ids: omitted.slice(0, 3) }]]);
  assert.equal(full.pages[0].memories.length, Math.min(omitted.length, 3));
  assert.equal(full.pages[0].memories[0].text.includes('需要清晰完整的工作记录。'.repeat(12)), true);
});

test('page projection preserves detail reads and complete Unicode entries, and honors trusted feedback', async () => {
  assert.equal(projectCatalogPage({ commands: ['full details'] }, 0, ['commands']), undefined);
  const excerpt = discoveryDescription('a'.repeat(178) + '😀'.repeat(10));
  assert.ok(excerpt.isWellFormed()); assert.ok(excerpt.length <= 180);
  const huge = { offset: 0, total: 1, matches: [{ name: 'huge', description: 'x'.repeat(20000) }] };
  assert.equal(projectCatalogPage(huge, 16000, ['matches']), undefined, 'a single irreducible record can still be archived');
  const render = count => JSON.stringify({ matches: ['one', 'two'].slice(0, count), ...(count < 2 ? { next_cursor: 'x'.repeat(5000) } : {}) });
  assert.equal(fitToolResultPage(2, 1000, render), render(2), 'a complete page that fits must not be rejected because its partial cursor is larger');
  assert.equal(fitToolResultPage(2, 0, render), render(2), 'minimum reservation uses the smaller complete page');
  assert.equal(projectMcpDiscoveryResult(JSON.stringify({ protocol: 'bush.mcp_discovery.v1', action: 'search', matches: [{}] })), undefined);
  const { registry, request } = fixture(0); registerPluginCommandTools(registry, async () => commands()); request.tools = registry.definitions();
  const loop = new RuntimeToolLoop({ registry, eventLog: new InMemoryRuntimeEventLog(), identity: { requestId: 'r', sessionId: 's', turnId: 't' },
    hooks: { before: async () => ({ messages: [] }), after: async () => ({ messages: [], toolFeedback: 'Trusted replacement.' }) } });
  const result = await loop.execute([{ protocol: 'bush.tool_call.v1', id: 'c', name: 'list_plugin_commands', argumentsText: '{}' }],
    { round: 1, assistantMessageId: 'a', request, contextMessages: [], modelContextIngressBudgetTokens: 1500 });
  assert.equal(result.messages[0].content, 'Trusted replacement.');
});
