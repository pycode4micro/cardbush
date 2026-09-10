import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { FileToolExecutionPersistence, InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator, registerFileMemoTools, resolveFileMemo } from '../dist/index.js';
import { RESOLVE_FILE_MEMO_COMMAND, fileMemoReference, parseFileMemoReference } from '@cardbush/bush-protocol';

test('memos reuse durable execution facts, update by file identity, and keep immutable references', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-file-memo-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true }); });
  const path = join(root, '商品 参考图.txt'); await writeFile(path, 'source');
  const rows = [];
  const persistence = { load: session => rows.filter(row => row.sessionId === session), append: row => rows.push(structuredClone(row)) };
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
  const second = await run('remember_file', { path, purpose: '后续使用的商品参考' });
  assert.equal(second.result.id, first.result.id);
  assert.notEqual(second.result.reference, first.result.reference);
  const listed = await run('read_file_memos', {});
  assert.equal(listed.result.total, 1);
  assert.equal(listed.result.memos[0].note.purpose, '后续使用的商品参考');
  assert.equal((await run('read_file_memos', { id: first.result.id }, 'foreign')).kind, 'failed');
  store = new ToolExecutionStore({ persistence });
  assert.equal((await resolveFileMemo(store, first.result.reference)).memo.note.purpose, '商品参考');
  assert.equal((await resolveFileMemo(store, first.result.reference)).status, 'available');
  await writeFile(path, 'different, longer content');
  assert.equal((await resolveFileMemo(store, first.result.reference)).status, 'changed');
  await rm(path);
  assert.equal((await resolveFileMemo(store, first.result.reference)).status, 'unavailable');
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
  assert.equal(resolution.status, 'available'); assert.equal(resolution.memo.file.path, path);
  assert.equal(resolution.memo.note.purpose, '交付文件');
});
