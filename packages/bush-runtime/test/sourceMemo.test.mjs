import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator, FileToolExecutionPersistence, InMemoryRuntimeHost, registerFileMemoTools, resolveFileMemo } from '../dist/index.js';
import { registerSourceMemoTools, resolveSourceMemo } from '../dist/sourceMemo.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-source-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const persistence = new FileToolExecutionPersistence({ root: join(root, 'records') });
  const store = new ToolExecutionStore({ persistence }), registry = new ToolRegistry();
  registerFileMemoTools(registry, store); registerSourceMemoTools(registry, store);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => { throw Error('Unexpected access outside workspace'); } } });
  let counter = 0;
  return { root, store, registry, persistence, async run(name, args) {
    const identity = { sessionId: 's', turnId: 't', requestId: 'r', round: ++counter, ordinal: 0 };
    const call = { protocol: 'bush.tool_call.v1', id: `call-${counter}`, name, argumentsText: JSON.stringify(args) };
    const result = await coordinator.execute(call, identity, undefined, { request: { tools: registry.definitions(), permissionMode: 'task_free', metadata: { workspaceDir: root } }, contextMessages: [] });
    store.record(call, identity, result); return result;
  } };
}

test('Source uses durable memo facts without changing file links; snapshots survive changes, deletion and restart', async t => {
  const { root, store, run, persistence, registry } = await fixture(t);
  const path = join(root, '依据 file.cs'); await writeFile(path, 'first\nreturn 1;\nthird');
  const file = await run('remember_file', { path, purpose: '可下载文件' }); assert.equal(file.kind, 'returned');
  const saved = await run('remember_source', { explanation: 'The returned value is constant.', sources: [
    { target: path, locator: { line: 2 } }, { target: 'https://example.com/spec#return', label: 'Specification' },
  ] });
  assert.equal(saved.kind, 'returned', JSON.stringify(saved));
  const memo = saved.result;
  assert.equal(memo.sources[0].target, await realpath(path));
  assert.match(memo.sources[0].excerpt, /return 1;/); assert.match(memo.sources[0].version.sha256, /^[a-f0-9]{64}$/);
  const modelResult = registry.resolve('remember_source').renderModelResult(memo);
  assert.ok(!modelResult.includes('sha256') && !modelResult.includes('excerpt'), 'host snapshots do not consume model output context');
  assert.equal((await resolveFileMemo(store, file.result.reference)).status, 'available');
  assert.equal((await resolveSourceMemo(store, file.result.reference.replace('cardbush-memo:', 'cardbush-source:'))).status, 'unresolved');
  assert.equal((await resolveFileMemo(store, memo.reference.replace('cardbush-source:', 'cardbush-memo:'))).status, 'unresolved');
  assert.equal((await resolveSourceMemo(store, memo.reference.replace(/-[a-f0-9]{16}$/, '-0000000000000000'))).status, 'unresolved', 'same-number references from other hosts cannot silently resolve');
  assert.deepEqual((await resolveSourceMemo(store, memo.reference)).evidenceStatus, ['available', 'link']);
  await writeFile(path, 'return 2;');
  const changed = await resolveSourceMemo(store, memo.reference);
  assert.deepEqual(changed.memo, memo); assert.deepEqual(changed.evidenceStatus, ['changed', 'link']);
  await rm(path);
  const host = new InMemoryRuntimeHost({ toolExecutionStore: new ToolExecutionStore({ persistence }),
    provider: { async *stream() { throw Error('Source lookup must never call a model'); } }, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const historic = await host.sendCommand({ kind: 'runtime.resolve_source_memo', payload: { reference: memo.reference } });
  assert.deepEqual(historic.memo, memo); assert.deepEqual(historic.evidenceStatus, ['unavailable', 'link']);
  assert.equal((await resolveSourceMemo(store, 'cardbush-source:999999')).status, 'unresolved');
});

test('Agent judgment needs no fabricated evidence; invalid targets and locators fail without producing notes', async t => {
  const { root, run, registry } = await fixture(t);
  const judgment = await run('remember_source', { explanation: 'More space makes this layout easier to scan.' });
  assert.equal(judgment.kind, 'returned'); assert.deepEqual(judgment.result.sources, []);
  const path = join(root, 'sample.txt'); await writeFile(path, 'one');
  for (const source of [{ target: 'relative.txt' }, { target: path, locator: { line: 30 } }, { target: 'javascript:alert(1)' }, { target: 'https://user:password@example.com' }]) {
    assert.equal((await run('remember_source', { explanation: 'test', sources: [source] })).kind, 'failed');
  }
  const listing = await run('read_source_memos', {}); assert.equal(listing.result.total, 1);
  assert.throws(() => registry.resolve('remember_source').decodeInput({ explanation: 'why', sources: [{ target: path, locator: { endLine: 2 } }] }));
});


test('SSH memo permissions use the selected canonical root and never grant a model-supplied host or symlink escape', async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore();
  const calls = [];
  const remote = { async request(action, payload) {
    calls.push({ action, payload });
    assert.equal(action, 'authorize');
    return { path: payload.path.replace('/work/link/', '/private/'), root: payload.uri, inside: !payload.path.includes('/link/') };
  } };
  registerFileMemoTools(registry, store, remote); registerSourceMemoTools(registry, store, remote);
  for (const tool of ['remember_file', 'remember_source']) {
    const authorize = registry.resolve(tool).authorize;
    const context = path => ({ input: tool === 'remember_file' ? { path } : { sources: [{ target: path }] },
      turn: { request: { permissionMode: 'task_free', metadata: { workspaceDir: 'ssh://selected/work' } } } });
    assert.equal((await authorize(context('ssh://selected/work/a.txt'))).kind, 'allow');
    const escaped = await authorize(context('ssh://selected/work/link/a.txt'));
    assert.equal(escaped.kind, 'ask');
    assert.equal(escaped.request.targets[0].value, 'ssh://selected/private/a.txt');
    assert.deepEqual(escaped.request.scope.roots, ['ssh://selected/work']);
    const foreign = await authorize(context('ssh://other/work/a.txt'));
    assert.equal(foreign.kind, 'ask'); assert.deepEqual(foreign.request.scope.roots, []);
  }
  assert.ok(calls.every(call => call.action === 'authorize'), 'permission checks do not fetch remote file content');
});
