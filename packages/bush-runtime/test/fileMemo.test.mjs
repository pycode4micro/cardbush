import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, appendFile, rm, realpath, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FileToolExecutionPersistence, InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator, registerFileMemoTools, resolveFileMemo, validateFileMemoLinks } from '../dist/index.js';
import { RESOLVE_FILE_MEMO_COMMAND, fileMemoReference, parseFileMemoReference, fileMemoResolutionSchema } from '@cardbush/bush-protocol';

test('memos reuse durable execution facts, update by file identity, and keep immutable references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-file-memo-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true }); });
  const path = join(root, '商品 参考图.txt'); await writeFile(path, 'source');
  const rows = [], references = [];
  const persistence = { load: session => rows.filter(row => row.sessionId === session), append: row => rows.push(structuredClone(row)),
    loadFileMemoReferences: () => structuredClone(references), appendFileMemoReference: reference => references.push(structuredClone(reference)) };
  let store = new ToolExecutionStore({ persistence });
  const registry = new ToolRegistry(); registerFileMemoTools(registry, store);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => { throw Error('Unexpected prompt'); } } });
  let counter = 0;
  const run = async (name, args, sessionId = 's') => {
    const identity = { sessionId, turnId: 't', requestId: 'r', round: ++counter, ordinal: 0 };
    const call = { protocol: 'bush.tool_call.v1', id: 'call-' + counter, name, argumentsText: JSON.stringify(args) };
    const outcome = await coordinator.execute(call, identity); store.record(call, identity, outcome);
    return outcome;
  };
  const first = await run('remember_file', { path, purpose: '商品参考', points: ['来自用户上传'] });
  assert.equal(first.kind, 'returned');
  assert.equal(first.result.id, 'file_1');
  assert.equal(first.result.reference, 'cardbush-memo:1');
  assert.equal(first.result.markdown, '[商品 参考图.txt](cardbush-memo:1)');
  const second = await run('remember_file', { path, purpose: '后续使用的商品参考' });
  assert.equal(second.result.id, first.result.id);
  assert.notEqual(second.result.reference, first.result.reference);
  const listed = await run('read_file_memos', {});
  assert.equal(listed.result.total, 1);
  assert.equal(listed.result.memos[0].note.purpose, '后续使用的商品参考');
  assert.equal((await run('read_file_memos', { id: first.result.id }, 'foreign')).kind, 'failed');
  store = new ToolExecutionStore({ persistence });
  assert.equal((await resolveFileMemo(store, first.result.reference)).status, 'available');
  assert.equal((await resolveFileMemo(store, first.result.reference, { sessionId: 's' })).memo.note.purpose, '商品参考');
  assert.equal((await resolveFileMemo(store, first.result.reference, { sessionId: 's' })).status, 'available');
  await writeFile(path, 'different, longer content');
  const changed = fileMemoResolutionSchema.parse(await resolveFileMemo(store, first.result.reference, { sessionId: 's' }));
  assert.equal(changed.status, 'changed');
  assert.deepEqual(changed.memo.file, first.result.file, 'the original observation is immutable');
  const disk = await stat(path);
  assert.deepEqual(changed.currentVersion, { size: disk.size, mtimeMs: disk.mtimeMs }, 'preview version survives protocol parsing');
  await writeFile(path, 'Different, longer content');
  await utimes(path, disk.atime, new Date(disk.mtimeMs + 2000));
  const editedAgain = await resolveFileMemo(store, first.result.reference);
  assert.equal(editedAgain.status, 'changed');
  assert.equal(editedAgain.currentVersion.size, changed.currentVersion.size);
  assert.notEqual(editedAgain.currentVersion.mtimeMs, changed.currentVersion.mtimeMs, 'same-size edits still get a new preview version');
  assert.deepEqual((await resolveFileMemo(store, first.result.reference)).currentVersion, editedAgain.currentVersion, 'unchanged files keep a stable preview version');
  await rm(path);
  const unavailable = await resolveFileMemo(store, first.result.reference, { sessionId: 's' });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.currentVersion, undefined);
});

test('memo fields reject verbose/history-shaped payloads and arbitrary references', () => {
  const registry = new ToolRegistry(); registerFileMemoTools(registry, new ToolExecutionStore());
  const decode = registry.resolve('remember_file').decodeInput;
  for (const extra of [{ purpose: 'x'.repeat(121) }, { purpose: 'first\nsecond' }, { points: ['a', 'b', 'c', 'd'] },
    { points: ['x'.repeat(161)] }, { history: 'tool trace' }, { verified: true }]) {
    assert.throws(() => decode({ path: '/a', purpose: 'reference', ...extra }));
  }
  const reference = fileMemoReference({ sessionId: '会话', turnId: 't/1', toolCallId: 'x#?' });
  assert.deepEqual(parseFileMemoReference(reference), { sessionId: '会话', turnId: 't/1', toolCallId: 'x#?' });
  for (const bad of ['javascript:alert(1)', 'cardbush-memo:a/b', reference + '#suffix', 'cardbush-memo:%xx/b/c']) assert.equal(parseFileMemoReference(bad), undefined);
});

test('a delivered memo resolves through the public runtime command after host restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-memo-host-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true }); });
  const path = join(root, 'delivery.txt'); await writeFile(path, 'Actual file');
  const registry = new ToolRegistry(); let round = 0;
  const provider = { async *stream(request) {
    assert.ok(!request.tools.some(tool => tool.name === 'present_artifact'), 'file delivery does not need a separate presentation tool');
    const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
      createdAt: '2026-09-10T00:00:00Z', sequence, kind, ...fields });
    yield event(0, 'response_started');
    if (round++ === 0) {
      yield event(1, 'tool_call_delta', { index: 0, toolCallId: 'memo', nameDelta: 'remember_file',
        argumentsDelta: JSON.stringify({ path, purpose: '交付文件' }) });
      yield event(2, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      const memo = JSON.parse(request.messages.at(-1).content);
      yield event(1, 'text_delta', { delta: `[交付文件](${memo.reference})` });
      yield event(2, 'response_completed', { finishReason: 'stop' });
    }
  } };
  const persistedStore = () => new ToolExecutionStore({ persistence: new FileToolExecutionPersistence({ root: join(root, 'tool-executions') }) });
  const host = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolExecutionStore: persistedStore(), toolRegistry: registry, provider });
  assert.ok(registry.resolve('remember_file')); assert.ok(registry.resolve('read_file_memos'));
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
    model: 'offline-fixture', messages: [{ role: 'user', content: '记录文件' }], tools: registry.definitions() });
  assert.equal(terminal.payload.status, 'completed');
  const reference = fileMemoReference({ sessionId: 's', turnId: 't', toolCallId: 'memo' });
  const restarted = new InMemoryRuntimeHost({ dataRoot: join(root, 'runtime'), toolExecutionStore: persistedStore(), provider: { async *stream() { throw Error('No model call on reference lookup'); } } });
  const resolution = await restarted.sendCommand({ kind: RESOLVE_FILE_MEMO_COMMAND, payload: { reference } });
  assert.equal(resolution.status, 'available'); assert.equal(resolution.memo.file.path, await realpath(path));
  assert.equal(resolution.memo.note.purpose, '交付文件');
  assert.equal((await restarted.sendCommand({ kind: RESOLVE_FILE_MEMO_COMMAND, payload: { reference: 'cardbush-memo:1', sessionId: 's' } })).status, 'available');
});

async function memoFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-short-memo-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true }); });
  const store = new ToolExecutionStore(), registry = new ToolRegistry();
  registerFileMemoTools(registry, store);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => { throw Error('Unexpected prompt'); } } });
  let calls = 0;
  return { root, store, registry, async remember(name, sessionId = 'session', turnId = 'turn') {
    const path = join(root, name); await writeFile(path, name);
    const call = { protocol: 'bush.tool_call.v1', id: `call_${++calls}`, name: 'remember_file', argumentsText: JSON.stringify({ path, purpose: name }) };
    const identity = { sessionId, turnId, requestId: 'request', round: calls, ordinal: 0 };
    const result = await coordinator.execute(call, identity); assert.equal(result.kind, 'returned'); store.record(call, identity, result);
    return result.result;
  } };
}

test('short references are canonical, sequential, revision-stable and cannot collide across conversations', async t => {
  for (const bad of ['cardbush-memo:0', 'cardbush-memo:01', 'cardbush-memo:-1', 'cardbush-memo:1x', 'cardbush-memo:1000000000']) assert.equal(parseFileMemoReference(bad), undefined);
  assert.deepEqual(parseFileMemoReference('cardbush-memo:12'), { number: 12 });
  const f = await memoFixture(t);
  const a = await f.remember('first.md');
  const b = await f.remember('second.md');
  const again = await f.remember('first.md');
  const foreign = await f.remember('foreign.md', 'other');
  assert.deepEqual([a.id, b.id, again.id, foreign.id], ['file_1', 'file_2', 'file_1', 'file_1']);
  assert.deepEqual([a.reference, b.reference, again.reference, foreign.reference], ['cardbush-memo:1', 'cardbush-memo:2', 'cardbush-memo:3', 'cardbush-memo:4']);
  assert.equal((await resolveFileMemo(f.store, a.reference, { sessionId: 'session' })).memo.file.name, 'first.md');
  assert.equal((await resolveFileMemo(f.store, foreign.reference, { sessionId: 'other' })).memo.file.name, 'foreign.md');
  assert.equal((await resolveFileMemo(f.store, b.reference, { sessionId: 'other' })).memo.file.name, 'second.md', 'a link copied to another conversation preserves its target');
  assert.equal((await validateFileMemoLinks(f.store, a.markdown, { sessionId: 'child', turnId: 'fork' })).invalid.length, 0, 'forked parent links remain valid');
});

test('legacy transcription errors recover only with matching session, turn, filename and one near call', async t => {
  const f = await memoFixture(t);
  const current = await f.remember('novel.md');
  const id = 'call_00_mm82jUUllB1ZYq286djy2299';
  const typo = 'call_00_mm82jUUllB1ZYq286d2299';
  const oldId = 'file_' + 'a'.repeat(32);
  const legacy = fileMemoReference({ sessionId: 'legacy', turnId: 'turn', toolCallId: id });
  const append = callId => f.store.record({ protocol: 'bush.tool_call.v1', id: callId, name: 'remember_file', argumentsText: '{}' },
    { sessionId: 'legacy', turnId: 'turn', requestId: 'r', round: 1, ordinal: 0 },
    { kind: 'returned', result: { ...current, id: oldId, reference: fileMemoReference({ sessionId: 'legacy', turnId: 'turn', toolCallId: callId }), markdown: undefined }, workspaceChanges: [] });
  append(id);
  const bad = fileMemoReference({ sessionId: 'legacy', turnId: 'turn', toolCallId: typo });
  const scope = { sessionId: 'legacy', turnId: 'turn', fileName: 'novel.md' };
  assert.equal((await resolveFileMemo(f.store, legacy)).status, 'available');
  assert.equal((await resolveFileMemo(f.store, bad, scope)).recovered, true);
  for (const wrong of [{}, { ...scope, fileName: undefined }, { ...scope, turnId: 'wrong' }, { ...scope, sessionId: 'other' }, { ...scope, fileName: 'other.md' }]) {
    assert.equal((await resolveFileMemo(f.store, bad, wrong)).status, 'unresolved');
  }
  const updated = await f.remember('novel.md', 'legacy', 'next');
  assert.equal(updated.id, 'file_1'); assert.equal(updated.reference, 'cardbush-memo:3');
  const read = f.registry.resolve('read_file_memos');
  const latest = await read.execute({ sessionId: 'legacy', input: { id: oldId, offset: 0 } });
  assert.equal(latest.memo.reference, updated.reference);
  append('call_00_mm82jUUllB1ZYq286dx2299');
  assert.equal((await resolveFileMemo(f.store, bad, scope)).reason, 'ambiguous_reference');
});

test('delivery validation checks links, images and filename mismatches, leaving code examples alone', async t => {
  const f = await memoFixture(t); const a = await f.remember('A [2].md'); await f.remember('other.md');
  const scope = { sessionId: 'session', turnId: 'turn' };
  const examples = '```markdown\n[example](cardbush-memo:999)\n```\n`[example](cardbush-memo:888)`';
  assert.deepEqual((await validateFileMemoLinks(f.store, examples + '\n' + a.markdown, scope)).invalid, []);
  const bad = await validateFileMemoLinks(f.store, '[other.md](cardbush-memo:1)\n![missing](cardbush-memo:99)\n[x]: cardbush-memo:98\n[x]', scope);
  assert.deepEqual(bad.invalid.map(item => item.reason), ['reference_mismatch', 'reference_not_found', 'reference_not_found']);
  assert.ok(bad.links.includes(a.markdown));
  await rm(a.file.path);
  assert.equal((await validateFileMemoLinks(f.store, a.markdown, scope)).invalid[0].reason, 'file_unavailable');
});

test('final delivery gets one bounded correction without replaying successful file operations or rewriting prior messages', async t => {
  const f = await memoFixture(t); const saved = await f.remember('delivery.md');
  let calls = 0; const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request.messages));
    const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-13T00:00:00Z', sequence, kind, ...fields });
    yield event(0, 'response_started');
    yield event(1, 'text_delta', { delta: calls++ === 0 ? '[delivery.md](cardbush-memo:99)' : saved.markdown });
    yield event(2, 'response_completed', { finishReason: 'stop' });
  } };
  const host = new InMemoryRuntimeHost({ dataRoot: join(f.root, 'runtime'), toolExecutionStore: f.store, provider });
  const run = turnId => host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r-' + turnId, sessionId: 'session', turnId,
    model: 'offline-fixture', messages: [{ role: 'user', content: '交付文件' }], tools: [] });
  const terminal = await run('delivery');
  assert.equal(terminal.payload.status, 'completed'); assert.equal(calls, 2);
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0], 'earlier prefix stays byte-equivalent');
  assert.equal(requests[1].at(-2).content, '[delivery.md](cardbush-memo:99)', 'original model text is kept');
  assert.equal(requests[1].at(-1).name, 'file_reference_correction');
  assert.equal(f.store.listByTool('session', 'remember_file').length, 1);
  calls = 0;
  provider.stream = async function* (request) {
    calls++;
    yield { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-13T00:00:00Z', sequence: 0, kind: 'text_delta', delta: '[missing](cardbush-memo:99)' };
    yield { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-13T00:00:00Z', sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  };
  const failed = await run('failed-delivery');
  assert.equal(failed.payload.reason, 'file_reference_invalid'); assert.equal(calls, 2);
});

test('host-issued numbers persist across sessions and restart, preserving reservations and detecting corruption', async t => {
  const f = await memoFixture(t);
  const directory = join(f.root, 'journal');
  let persistence = new FileToolExecutionPersistence({ root: directory });
  let store = new ToolExecutionStore({ persistence });
  const parent = { sessionId: 'parent', turnId: 'turn', toolCallId: 'a' };
  const child = { sessionId: 'child', turnId: 'turn', toolCallId: 'b' };
  assert.equal(store.reserveFileMemoReference(parent), 1);
  assert.equal(store.reserveFileMemoReference(child), 2);
  assert.equal(store.reserveFileMemoReference(parent), 1);
  persistence.close();
  const indexPath = join(directory, '.file-memo-references');
  await appendFile(indexPath, '{"partial":');
  persistence = new FileToolExecutionPersistence({ root: directory }); store = new ToolExecutionStore({ persistence });
  assert.deepEqual(store.getFileMemoReference(1), { ...parent, number: 1 });
  assert.deepEqual(store.getFileMemoReference(2), { ...child, number: 2 });
  assert.equal(store.reserveFileMemoReference({ ...child, toolCallId: 'c' }), 3, 'cancelled/uncommitted references never get reused');
  persistence.close();
  const original = await readFile(indexPath, 'utf8');
  await rm(indexPath);
  persistence = new FileToolExecutionPersistence({ root: directory }); store = new ToolExecutionStore({ persistence });
  assert.throws(() => store.reserveFileMemoReference({ ...child, toolCallId: 'd' }), /index is missing/, 'lost index must never restart numbering at 1');
  persistence.close();
  await writeFile(indexPath, original.replace('"number":1', '"number":9'));
  persistence = new FileToolExecutionPersistence({ root: directory }); store = new ToolExecutionStore({ persistence });
  assert.throws(() => store.getFileMemoReference(1), /checksum mismatch/);
  persistence.close();
});
