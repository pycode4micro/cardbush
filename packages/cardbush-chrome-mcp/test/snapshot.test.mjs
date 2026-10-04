import assert from 'node:assert/strict';
import test from 'node:test';
import { PageSnapshots, snapshotSchema } from '../dist/pageSnapshot.js';
import { createCardbushChromeServer } from '../dist/index.js';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

function node(id, role, name = '', children = [], more = {}) {
  return { nodeId: String(id), backendDOMNodeId: id, ignored: false, role: { value: role }, name: { value: name }, childIds: children.map(String), ...more };
}
function fixture(nodes) {
  let loader = 'first', reads = 0;
  const snapshots = new PageSnapshots();
  const command = async name => {
    if (name === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: loader, url: 'https://fixture.test/' } } };
    if (name === 'Accessibility.enable') return {};
    assert.equal(name, 'Accessibility.getFullAXTree'); reads++; return { nodes };
  };
  return { snapshots, command, read: (input = {}, scope = 'a', pageId = 1) => snapshots.read(command, scope, pageId, input),
    navigate: () => { loader = 'next'; }, reads: () => reads };
}
const lines = result => result.text.split('\n').filter(line => line.startsWith('uid='));

test('pagination is bounded, explicit reads repeat, and continuation does not fetch the whole tree again', async () => {
  const f = fixture(Array.from({ length: 250 }, (_, i) => node(i + 1, 'button', `Item ${i} ${'中'.repeat(80)}`)));
  const all = [];
  let page = await f.read();
  assert.equal(page.structured.matchedNodes, 250);
  while (true) {
    assert.ok(JSON.stringify(page).length < 10_000);
    all.push(...lines(page));
    if (!page.structured.hasMore) break;
    const input = { cursor: page.structured.nextCursor };
    page = await f.read(input);
    assert.deepEqual(await f.read(input), page);
  }
  assert.equal(all.length, 250);
  assert.equal(new Set(all).size, 250);
  assert.equal(f.reads(), 1);
  f.snapshots.clear('a');
});

test('scope, role and full-field search filters work without ignored/generic/InlineTextBox duplicates', async () => {
  const nodes = [node(1, 'RootWebArea', '', [2, 9]), node(2, 'generic', '', [3, 4, 5]), node(3, 'button', 'Needle'),
    node(4, 'StaticText', 'Needle', [6]), node(6, 'InlineTextBox', 'Needle'), node(5, 'button', 'Hidden', [], { ignored: true }),
    node(9, 'button', 'Outside')];
  const f = fixture(nodes);
  assert.equal((await f.read({ rootUid: 'cb_2' })).structured.matchedNodes, 2);
  assert.equal((await f.read({ rootUid: 'cb_2', roles: ['BUTTON'], query: 'needle' })).structured.returned, 1);
  assert.equal((await f.read({ rootUid: 'cb_2', query: 'Outside' })).structured.emptyReason, 'no_matches');
  await assert.rejects(f.read({ rootUid: 'cb_500' }), { code: 'snapshot_root_missing' });
  f.snapshots.clear('a');
});

test('long fields are marked previews and can be read completely in focused, paginated chunks', async () => {
  const long = ' \n' + '😀中\u0001"\\'.repeat(1300) + 'END-NEEDLE\t\n ';
  const f = fixture([node(1, 'textbox', long, [], { value: { value: 'v'.repeat(7000) }, description: { value: 'Desc'.repeat(1500) } })]);
  const preview = await f.read({ query: 'END-NEEDLE' });
  assert.equal(preview.structured.returned, 1, 'query searches beyond the preview');
  assert.equal(preview.structured.previewNodes, 1);
  assert.match(preview.text, /preview;/);
  assert.ok(JSON.stringify(preview).length < 10_000);
  const recovered = { name: '', value: '', description: '' };
  let page = await f.read({ rootUid: 'cb_1', fullText: true, limit: 4 });
  while (true) {
    assert.ok(JSON.stringify(page).length < 10_000);
    for (const line of lines(page)) {
      const match = / field=(\w+) offset=(\d+) totalChars=(\d+) text=(.*)$/.exec(line);
      assert.ok(match, line);
      assert.equal(Number(match[2]), recovered[match[1]].length);
      recovered[match[1]] += JSON.parse(match[4]);
    }
    if (!page.structured.hasMore) break;
    assert.ok(page.structured.returned > 0, 'a cursor must always advance');
    page = await f.read({ cursor: page.structured.nextCursor, limit: 4 });
  }
  assert.deepEqual(recovered, { name: long, value: 'v'.repeat(7000), description: 'Desc'.repeat(1500) });
  f.snapshots.clear('a');
});

test('empty results distinguish no matches, empty trees, and capture omissions', async () => {
  const empty = fixture([]);
  assert.equal((await empty.read()).structured.emptyReason, 'empty_accessibility_tree');
  assert.equal((await empty.read({ query: 'missing' })).structured.emptyReason, 'no_matches');
  empty.snapshots.clear('a');
  const f = fixture(Array.from({ length: 3000 }, (_, i) => node(i + 1, 'button', `${i} ${'中'.repeat(400)}`)));
  const result = await f.read();
  assert.equal(result.structured.matchedNodes, 3000);
  assert.equal(result.structured.captureTruncated, true);
  assert.ok(result.structured.omittedNodes > 0);
  assert.match(result.text, /Narrow with rootUid/);
  assert.equal((await f.read({ query: '2999' })).structured.returned, 1, 'omitted nodes remain available by a focused query');
  f.snapshots.clear('a');
});

test('cursor isolation, tampering, expiration, replacement and document changes fail explicitly', async t => {
  const f = fixture([node(1, 'button', 'A'), node(2, 'button', 'B')]);
  const first = await f.read({ limit: 1 });
  const input = { cursor: first.structured.nextCursor };
  await assert.rejects(f.read(input, 'b'), { code: 'snapshot_cursor_expired' });
  await assert.rejects(f.read(input, 'a', 2), { code: 'snapshot_cursor_expired' });
  await assert.rejects(f.read({ cursor: input.cursor.replace('.1.', '.0.') }), { code: 'snapshot_cursor_expired' });
  assert.equal((await f.read(input)).structured.returned, 1);
  await f.read({ limit: 1 });
  await assert.rejects(f.read(input), { code: 'snapshot_cursor_expired' });
  const next = await f.read({ limit: 1 });
  f.navigate();
  await assert.rejects(f.read({ cursor: next.structured.nextCursor }), { code: 'snapshot_document_changed' });
  const beforeExpiry = await f.read({ limit: 1 });
  const later = Date.now() + 181_000;
  t.mock.method(Date, 'now', () => later);
  await assert.rejects(f.read({ cursor: beforeExpiry.structured.nextCursor }), { code: 'snapshot_cursor_expired' });
  f.snapshots.clear('a');
});

test('the cache has a global budget, with no unbounded per-session retention', async () => {
  const f = fixture(Array.from({ length: 800 }, (_, i) => node(i + 1, 'button', `${i} ${'中'.repeat(400)}`)));
  const old = await f.read({ limit: 1 }, 'scope0');
  for (let i = 1; i <= 5; i++) await f.read({ limit: 1 }, `scope${i}`);
  await assert.rejects(f.read({ cursor: old.structured.nextCursor }, 'scope0'), { code: 'snapshot_cursor_expired' });
  for (let i = 0; i <= 5; i++) f.snapshots.clear(`scope${i}`);
});

test('snapshot schema prevents ambiguous cursor queries and unrestricted full-page text dumps', () => {
  assert.equal(snapshotSchema.safeParse({ cursor: 'abc', query: 'x' }).success, false);
  assert.equal(snapshotSchema.safeParse({ fullText: true }).success, false);
  assert.equal(snapshotSchema.safeParse({ limit: 101 }).success, false);
  assert.equal(snapshotSchema.safeParse({ rootUid: 'cb_1', fullText: true }).success, true);
});

test('the public MCP result delivers each page text once and releases cursors with the browser', async () => {
  const f = fixture(Array.from({ length: 100 }, (_, i) => node(i + 1, 'button', `UNIQUE-CONTENT-${i}`)));
  const server = createCardbushChromeServer({ connector: async (method, params) => {
    if (method === 'tabs.list') return [{ id: 42, active: true }];
    if (method === 'debugger.detachScope') return {};
    return f.command(params.command);
  } });
  const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'fixture' } } };
  const result = await server._registeredTools.take_snapshot.handler({ limit: 3 }, context);
  assert.equal(result.isError, undefined);
  assert.equal(JSON.stringify(result).split('UNIQUE-CONTENT-0').length - 1, 1);
  assert.equal(result.structuredContent.snapshot, undefined);
  assert.ok(result.structuredContent.nextCursor);
  await server._registeredTools.release_browser.handler({}, context);
  const expired = await server._registeredTools.take_snapshot.handler({ cursor: result.structuredContent.nextCursor }, context);
  assert.equal(expired.structuredContent.error.code, 'snapshot_cursor_expired');
});

test('MCP negotiation publishes the paging schema and transports text, cursor and scope metadata intact', async () => {
  const f = fixture([node(1, 'button', 'Transport row one'), node(2, 'button', 'Transport row two')]);
  const server = createCardbushChromeServer({ connector: async (method, params) => {
    assert.equal(params.scopeId, 'protocol-fixture');
    if (method === 'tabs.list') return [{ id: 42, active: true }];
    if (method === 'debugger.detachScope') return {};
    return f.command(params.command);
  } });
  const client = new Client({ name: 'snapshot-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try {
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    const schema = catalog.tools.find(tool => tool.name === 'take_snapshot').inputSchema;
    assert.ok(schema.properties.cursor);
    assert.ok(schema.properties.fullText);
    const _meta = { cardbush_session_id: 'protocol-fixture' };
    const first = await client.callTool({ name: 'take_snapshot', arguments: { limit: 1 }, _meta });
    assert.equal(first.isError, undefined, JSON.stringify(first));
    assert.equal(JSON.stringify(first).split('Transport row one').length - 1, 1);
    const second = await client.callTool({ name: 'take_snapshot', arguments: { cursor: first.structuredContent.nextCursor }, _meta });
    assert.match(second.content[0].text, /Transport row two/);
    assert.equal(second.structuredContent.hasMore, false);
    await client.callTool({ name: 'release_browser', arguments: {}, _meta });
  } finally { await client.close(); await server.close(); }
});
