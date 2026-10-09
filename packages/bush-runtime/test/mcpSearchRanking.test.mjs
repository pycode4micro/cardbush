import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, registerMcpDiscovery, projectMcpDiscoveryResult } from '../dist/index.js';

function fixture() {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const request = { sessionId: 'search-session', turnId: 'turn', tools: [], metadata: { mcpToolDiscovery: true } };
  const add = (server, tool, description) => {
    const name = `mcp__${server}__${tool}`;
    registry.register({ definition: { name, description, inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: input => input, execute: () => { throw Error('Search must not execute tools'); },
      mcpHook: { server, tool, call: async () => { throw Error('Search must not connect'); } } });
    request.tools = registry.definitions(); return name;
  };
  const search = input => {
    const tool = registry.resolve('mcp_search');
    return tool.execute({ input: tool.decodeInput(input), turn: { request, contextMessages: [] } });
  };
  add('blender', 'search_api_docs', 'Full-text search over the Blender Python API reference. The current scene and the docs for articles.');
  add('github', 'search', 'Search code in the current repository and issues for the project.');
  add('browser_use', 'export_image', 'Export a PNG/JPEG/WebP image from a canvas.');
  add('browser_use', 'new_page', 'Open a browser tab for web search, current news and internet research.');
  add('browser_use', 'take_snapshot', 'Read webpage text and web search results.');
  return { registry, request, add, search };
}

test('web/news discovery ranks browser capabilities ahead of document search and ignores grammatical filler', async () => {
  const { search } = fixture();
  for (const query of ['web search news', 'search the internet for current news articles']) {
    const result = await search({ query, limit: 5 });
    assert.equal(result.matches[0].name, 'mcp__browser_use__new_page');
    assert.ok(!result.matches.some(item => item.tool === 'export_image'), 'web must not match WebP');
  }
  assert.deepEqual((await search({ query: 'search the internet for current news articles' })).matches,
    (await search({ query: 'search internet current news articles' })).matches);
  assert.equal((await search({ query: 'take_snapshot' })).matches[0].tool, 'take_snapshot');
});

test('exact identity, Chinese words and camel-case tool names remain discoverable without substring noise', async () => {
  const { add, search } = fixture();
  add('documents', 'readFile', 'Read a local file.');
  add('threads', 'list_threads', 'Thread summaries.');
  add('news', '新闻查询', '查询最新新闻与网页内容。');
  add('notes', 'reference', 'Use readFile for documents.');
  add('images', 'exportWebP', 'Save a canvas as WebP.');
  assert.equal((await search({ query: 'readFile' })).matches[0].tool, 'readFile');
  assert.equal((await search({ query: 'read file' })).matches[0].tool, 'readFile');
  assert.ok(!(await search({ query: 'read' })).matches.some(item => item.server === 'threads'));
  assert.ok(!(await search({ query: 'web' })).matches.some(item => item.tool === 'exportWebP'));
  assert.equal((await search({ query: 'webp' })).matches[0].tool, 'exportWebP');
  assert.equal((await search({ query: '查询新闻' })).matches[0].server, 'news');
  assert.equal((await search({ query: 'no_matching_capability', server: 'browser_use' })).total, 0);
  assert.equal((await search({ query: '*', server: 'browser_use' })).total, 3);
});

test('cursor pages preserve all results without duplication, allow page-size changes and repeat explicit reads', async () => {
  const { search, request } = fixture();
  const first = await search({ query: '*', limit: 2 });
  const view = JSON.parse(projectMcpDiscoveryResult(JSON.stringify(first)));
  assert.equal(view.more, true); assert.equal(view.next_cursor, first.next_cursor);
  assert.equal(view.next_offset, undefined);
  const next = { cursor: first.next_cursor, limit: 1 };
  const second = await search(next);
  assert.deepEqual(await search(next), second);
  request.turnId = 'later-turn'; request.metadata = { mcpToolDiscovery: true };
  assert.deepEqual(await search(next), second, 'pagination does not depend on hidden per-turn state');
  const last = await search({ cursor: second.next_cursor, limit: 5 });
  assert.equal(last.more, false); assert.equal(last.next_cursor, undefined);
  assert.deepEqual([...first.matches, ...second.matches, ...last.matches].map(item => item.name),
    (await search({ query: '*', limit: 10 })).matches.map(item => item.name));
});

test('changing a search cannot silently reuse an old page offset or cursor', async () => {
  const { search } = fixture();
  const first = await search({ query: '*', limit: 1 });
  for (const input of [{ query: 'web', offset: 1 }, { query: 'web', cursor: first.next_cursor },
    { server: 'browser_use', cursor: first.next_cursor }, { action: 'load', query: 'new_page', cursor: first.next_cursor }]) {
    assert.throws(() => search(input), /cursor|offset/);
  }
  assert.equal((await search({ query: 'web', limit: 1 })).matches[0].tool, 'new_page');
  for (const cursor of ['', 'garbage', 'mcp-search:1:!invalid', 'mcp-search:1:e30', 'a'.repeat(16_385)]) {
    assert.throws(() => search({ cursor }), /Invalid MCP search cursor/);
  }
});

test('changed results and cross-session cursors require a new search; unrelated tools do not disturb paging', async () => {
  const { search, request, registry, add } = fixture();
  const first = await search({ query: 'web', limit: 1 });
  add('images', 'make_picture', 'Draw an image.');
  assert.equal((await search({ cursor: first.next_cursor })).matches[0].tool, 'take_snapshot');
  request.sessionId = 'another-session';
  await assert.rejects(() => search({ cursor: first.next_cursor }), { code: 'mcp_search_cursor_stale' });
  request.sessionId = 'search-session';
  registry.resolve('mcp__browser_use__take_snapshot').sessionScope = 'private-session';
  await assert.rejects(() => search({ cursor: first.next_cursor }), { code: 'mcp_search_cursor_stale' });
  const fresh = await search({ query: 'web' });
  assert.equal(fresh.total, 1); assert.equal(fresh.matches[0].tool, 'new_page');
});
