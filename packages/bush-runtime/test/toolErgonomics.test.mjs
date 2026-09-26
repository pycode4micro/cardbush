import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ToolRegistry, ToolExecutionCoordinator, CoordinationStore, registerCoordinationTools,
  registerWorkspaceTools, registerExtendedBuiltins, registerMcpDiscovery, projectMcpDiscoveryResult,
  synchronizeMcpDiscovery, mcpToolWasDiscovered } from '../dist/index.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false };
function fixture(root) {
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected permission'); } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'all_free',
    tools: registry.definitions(), metadata: { workspaceDir: root } };
  const run = (name, args) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name, argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, undefined, { request, contextMessages: [] });
  return { registry, run };
}
function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-ergonomics-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-ergonomics-')); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('line edits preserve exact boundaries and reject stale, mixed and out-of-range edits without writing', async t => {
  const root = temporary(t), path = join(root, 'source.py'), { registry, run } = fixture(root);
  const source = 'a\r\n  same\r\n  same\r\n尾😀'; writeFileSync(path, source);
  const read = await run('read_file', { path });
  assert.equal(read.kind, 'returned');
  const revised = await run('edit_file', { path, start_line: 3, end_line: 3, expected_sha256: read.result.sha256, new_text: '  changed\r\n' });
  assert.equal(revised.kind, 'returned', JSON.stringify(revised));
  assert.equal(readFileSync(path, 'utf8'), 'a\r\n  same\r\n  changed\r\n尾😀');
  assert.equal((await run('edit_file', { path, start_line: 2, end_line: 2, expected_sha256: read.result.sha256, new_text: 'lost' })).kind, 'failed');
  assert.equal((await run('edit_file', { path, start_line: 9, end_line: 9, expected_sha256: revised.result.sha256, new_text: '' })).kind, 'failed');
  for (const extra of [{ old_text: 'same' }, { replace_all: false }, { end_line: 0 }, { start_line: 1.5 }, { encoding: 'base64' }]) {
    assert.throws(() => registry.resolve('edit_file').decodeInput({ path, start_line: 2, end_line: 2, expected_sha256: revised.result.sha256, new_text: '', ...extra }));
  }
  assert.equal(readFileSync(path, 'utf8'), 'a\r\n  same\r\n  changed\r\n尾😀');
});

test('search context includes adjacent lines once, through ripgrep and Node fallback', async t => {
  const root = temporary(t), path = join(root, 'context.txt'), { registry, run } = fixture(root);
  writeFileSync(path, 'before\nneedle one\nbetween\nneedle two\nafter\nunrelated');
  for (const fallback of [false, true]) {
    const previousPath = process.env.PATH, previousRg = process.env.CARDBUSH_RG_PATH;
    try {
      if (fallback) { process.env.PATH = ''; delete process.env.CARDBUSH_RG_PATH; }
      const result = await run('search_file_content', { path, query: 'needle', context_before: 1, context_after: 1 });
      assert.equal(result.kind, 'returned', JSON.stringify(result));
      assert.equal(result.result.complete, true);
      for (const word of ['before', 'needle one', 'between', 'needle two', 'after']) assert.equal(result.result.output.split(word).length - 1, 1, word);
      assert.doesNotMatch(result.result.output, /unrelated/);
      const ending = join(root, 'ending.txt'); writeFileSync(ending, 'needle\n');
      const endResult = await run('search_file_content', { path: ending, query: 'needle', context_after: 3 });
      assert.equal(endResult.kind, 'returned', JSON.stringify(endResult));
      assert.equal(endResult.result.output.trimEnd().split('\n').length, 1);
      writeFileSync(ending, '');
      const empty = await run('search_file_content', { path: ending, query: '^$', regex: true, context_after: 3 });
      assert.equal(empty.kind, 'returned', JSON.stringify(empty));
      assert.equal(empty.result.output, '');
    } finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; if (previousRg === undefined) delete process.env.CARDBUSH_RG_PATH; else process.env.CARDBUSH_RG_PATH = previousRg; }
  }
  assert.throws(() => registry.resolve('search_file_content').decodeInput({ path, query: 'x', context_before: -1 }));
});

test('archive literal search paginates with exact Unicode offsets, budgets and replay-safe snippets', async () => {
  const text = '😀İ' + 'z'.repeat(2200) + 'A.*[X]' + 'q'.repeat(2200) + 'a.*[x]';
  const registry = new ToolRegistry(); registerExtendedBuiltins(registry, { readToolResultText: () => text });
  const tool = registry.resolve('read_archived_tool_result');
  const run = args => tool.execute({ input: tool.decodeInput({ locator: 'tool-result://s/t/c', ...args }), sessionId: 's' });
  const first = await run({ query: 'a.*[x]', limit: 1, context_chars: 2000, max_chars: 500 });
  assert.equal(first.matches.length, 1); assert.equal(first.matches[0].offset, text.indexOf('A.*[X]'));
  assert.ok(first.matches[0].text.includes('A.*[X]')); assert.ok(first.matches[0].text.length <= 500); assert.equal(first.complete, false);
  const next = await run({ query: 'a.*[x]', offset: first.next_offset });
  assert.equal(next.matches[0].offset, text.indexOf('a.*[x]')); assert.equal(next.complete, true);
  const exact = await run({ offset: first.matches[0].offset, max_chars: 500 });
  assert.equal(exact.text, text.slice(first.matches[0].offset, first.matches[0].offset + 500));
  assert.equal((await run({ query: 'absent' })).matches.length, 0);
  assert.throws(() => tool.decodeInput({ locator: 'tool-result://s/t/c', query: '' }));
});

test('plan patches are atomic, queryable and revision checked; omitted nodes survive', async () => {
  const store = new CoordinationStore(), registry = new ToolRegistry(); registerCoordinationTools(registry, store);
  const tool = registry.resolve('update_task_plan'), run = input => tool.execute({ sessionId: 's', input: tool.decodeInput(input) });
  assert.equal(run({ action: 'get' }), null);
  const created = run({ nodes: [{ step: 'inspect', status: 'in_progress' }, { step: 'verify', status: 'pending' }], active: true, explanation: 'first' });
  const [one, two] = created.plan.nodes;
  const patched = run({ action: 'patch', expected_revision: 1, updates: [{ id: one.id, status: 'completed' }, { id: two.id, status: 'in_progress' }] });
  assert.equal(patched.revision, 2); assert.equal(patched.plan.explanation, 'first'); assert.equal(patched.plan.nodes.length, 2);
  for (const extra of [ { expected_revision: 1 }, { updates: [{ id: 'foreign', status: 'completed' }] }, { remove_ids: [one.id] }, { updates: [{ id: one.id }, { id: one.id }] } ]) {
    assert.throws(() => run({ action: 'patch', expected_revision: 2, ...extra }));
    assert.deepEqual(run({ action: 'get' }), patched);
  }
  const appended = run({ action: 'patch', expected_revision: 2, append_nodes: [{ step: 'deliver', status: 'pending' }] });
  assert.ok(appended.plan.nodes[2].id); assert.equal(appended.plan.nodes[0].id, one.id);
  const completed = run({ action: 'patch', expected_revision: 3, updates: appended.plan.nodes.map(node => ({ id: node.id, status: 'completed' })), active: false });
  assert.equal(completed.plan.active, false);
});

test('MCP batch loads keep complete schemas, partial errors and current-scope admission', async () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  for (const name of ['one', 'two', 'large', 'large2']) registry.register({ definition: { name: `mcp__test__${name}`, description: name.startsWith('large') ? 'x'.repeat(60000) : name,
    inputSchema: { type: 'object', properties: { required: { type: 'string' } } } }, manifest, decodeInput: v => v, execute: () => ({}), mcpHook: { server: 'test', tool: name, call: async () => ({}) } });
  const request = { sessionId: 's', turnId: 't', metadata: { mcpToolDiscovery: true }, tools: registry.definitions() };
  const tool = registry.resolve('mcp_search');
  const run = args => tool.execute({ input: tool.decodeInput(args), turn: { request, contextMessages: [] } });
  const args = { action: 'load', names: ['mcp__test__one', 'mcp__test__two', 'missing', 'mcp__test__one'] };
  const result = await run(args), text = projectMcpDiscoveryResult(JSON.stringify(result));
  assert.equal(result.matches.length, 2); assert.equal(result.errors.length, 1);
  assert.equal(result.hostCapabilities, undefined);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__test__one'), false);
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'mcp_search', argumentsText: JSON.stringify(args) }] }, { role: 'tool', toolCallId: 'load', content: text }];
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__test__one'), true);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__test__two'), true);
  registry.resolve('mcp__test__one').mcpApp = { resourceUri: 'ui://test/view.html' };
  const appBatch = await run({ action: 'load', names: ['mcp__test__one', 'mcp__test__two'] });
  assert.ok(appBatch.hostCapabilities);
  assert.equal(appBatch.matches[0].interface.resourceUri, 'ui://test/view.html');
  const large = await run({ action: 'load', names: ['mcp__test__large', 'mcp__test__large2', 'mcp__test__two'] });
  assert.deepEqual(large.deferred, ['mcp__test__large2']); assert.equal(large.matches[0].description.length, 60000);
  registry.resolve('mcp__test__two').sessionScope = 'other';
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__test__two'), false);
  assert.equal((await run({ action: 'load', names: ['mcp__test__two'] })).errors.length, 1);
  synchronizeMcpDiscovery(registry, request, []);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__test__one'), false);
  for (const args of [{ names: ['one'] }, { action: 'load', names: [] }, { action: 'load', names: ['one'], query: 'two' }, { action: 'load', names: Array(17).fill('one') }]) assert.throws(() => tool.decodeInput(args));
});
