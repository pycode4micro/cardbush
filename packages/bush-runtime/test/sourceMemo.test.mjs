import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSourceMemoReference, parseSourceMemoIdentity } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionStore, ToolExecutionCoordinator, FileToolExecutionPersistence, InMemoryRuntimeHost, registerFileMemoTools, resolveFileMemo } from '../dist/index.js';
import { registerSourceMemoTools, resolveSourceMemo, resolveSourceReferences, sourceMemoReference } from '../dist/sourceMemo.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-source-'));
  t.after(async () => { persistence.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const persistence = new FileToolExecutionPersistence({ root: join(root, 'records') });
  const store = new ToolExecutionStore({ persistence }), registry = new ToolRegistry();
  registerFileMemoTools(registry, store); registerSourceMemoTools(registry, store);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => { throw Error('Unexpected access outside workspace'); } } });
  let counter = 0;
  return { root, store, registry, persistence, async run(name, args, scope = {}) {
    const identity = { sessionId: 's', turnId: 't', requestId: 'r', round: ++counter, ordinal: 0, ...scope };
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

test('bare Source numbers resolve only to successful notes in the exact session and turn, including after restart', async t => {
  const { root, store, run, persistence } = await fixture(t);
  const path = join(root, 'note.txt'); await writeFile(path, 'Evidence');
  const file = await run('remember_file', { path, purpose: 'Artifact' });
  const fileOnly = await run('remember_file', { path, purpose: 'Another artifact reference' });
  const saved = await run('remember_source', { explanation: 'Why this matters.', sources: [{ target: path }] });
  assert.equal(saved.kind, 'returned');
  const number = parseSourceMemoReference(saved.result.reference);
  const input = { sessionId: 's', turnId: 't', numbers: [number, number, 999999] };
  const expected = [{ number, reference: saved.result.reference }];
  assert.deepEqual(resolveSourceReferences(store, input), expected);
  assert.deepEqual(resolveSourceReferences(store, { ...input, sessionId: 'other' }), []);
  assert.deepEqual(resolveSourceReferences(store, { ...input, turnId: 'other' }), []);
  assert.equal(Number(file.result.reference.split(':')[1]), number, 'file and visible Source numbers are independent namespaces');
  assert.deepEqual(resolveSourceReferences(store, { ...input, numbers: [Number(fileOnly.result.reference.split(':')[1])] }), [], 'a file-only number never becomes a Source annotation');
  await rm(path);
  const host = new InMemoryRuntimeHost({ toolExecutionStore: new ToolExecutionStore({ persistence }),
    provider: { async *stream() { throw Error('Reference lookup must not call a model'); } }, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  assert.deepEqual(await host.sendCommand({ kind: 'runtime.resolve_source_references', payload: input }), expected, 'missing evidence does not erase the saved identity');
  await assert.rejects(host.sendCommand({ kind: 'runtime.resolve_source_references', payload: { numbers: [number] } }));
  await assert.rejects(host.sendCommand({ kind: 'runtime.resolve_source_references', payload: { ...input, numbers: Array(33).fill(number) } }));
});

test('Source display numbers restart per conversation while file references and copied full links stay unique', async t => {
  const { root, store, run } = await fixture(t), path = join(root, 'delivery.txt');
  await writeFile(path, 'Artifact');
  await run('remember_file', { path, purpose: 'File before Source' });
  const a = (await run('remember_source', { explanation: 'First conversation.' })).result;
  await run('remember_file', { path, purpose: 'File between Sources' });
  const b = (await run('remember_source', { explanation: 'Second conversation.' }, { sessionId: 'other' })).result;
  const followup = (await run('remember_source', { explanation: 'Next turn in the first conversation.' }, { turnId: 'next' })).result;
  assert.deepEqual([a,b,followup].map(memo => parseSourceMemoReference(memo.reference)), [1,1,2]);
  assert.equal(new Set([a,b,followup].map(memo => parseSourceMemoIdentity(memo.reference).locator)).size, 3);
  assert.match(a.markdown, /^\[1\]\(cardbush-source:v2:1:/);
  for (const memo of [a,b,followup]) assert.deepEqual((await resolveSourceMemo(store, memo.reference)).memo, memo);
  assert.deepEqual(resolveSourceReferences(store, { sessionId: 'other', turnId: 't', numbers: [1,2] }), [{ number: 1, reference: b.reference }]);
  assert.equal((await resolveSourceMemo(store, a.reference.replace('v2:1:', 'v2:2:'))).status, 'unresolved', 'forged display numbers do not retarget valid links');
  store.fork('s','child',new Set(['t']));
  const child = (await run('remember_source',{explanation:'Fork follow-up.'},{sessionId:'child',turnId:'child-turn'})).result;
  assert.equal(parseSourceMemoReference(child.reference),2);
  assert.notEqual(child.reference,followup.reference);
  assert.deepEqual(resolveSourceReferences(store,{sessionId:'child',turnId:'t',numbers:[1]}),[{number:1,reference:a.reference}]);
  const inherited = (await run('read_source_memos',{}, {sessionId:'child'})).result.memos;
  assert.deepEqual(inherited.map(memo=>memo.reference),[a.reference,child.reference]);
});

test('Source reservations persist through restart and retry without reusing cancelled numbers', async t => {
  const { store, persistence, run } = await fixture(t);
  const saved = (await run('remember_source', { explanation: 'Persisted Source.' })).result;
  const pending = { sessionId: 's', turnId: 'later', toolCallId: 'cancelled-before-record' };
  const reserved = store.reserveSourceMemoReference(pending);
  assert.equal(reserved.sourceNumber, 2);assert.deepEqual(store.reserveSourceMemoReference(pending), reserved);
  persistence.close();
  const restarted = new ToolExecutionStore({ persistence });
  assert.deepEqual(restarted.reserveSourceMemoReference(pending), reserved);
  restarted.reserveFileMemoReference({ sessionId: 's', turnId: 'later', toolCallId: 'file' });
  assert.equal(restarted.reserveSourceMemoReference({ ...pending, toolCallId: 'after-restart' }).sourceNumber, 3);
  assert.equal(restarted.reserveSourceMemoReference({ ...pending, sessionId: 'new' }).sourceNumber, 1);
  assert.deepEqual((await resolveSourceMemo(restarted, saved.reference)).memo, saved);
});

test('legacy references keep their original number and forks continue only the inherited Source sequence', async t => {
  const { store, run, persistence } = await fixture(t);
  for (let i=0;i<44;i++) store.reserveFileMemoReference({ sessionId: 'files', turnId: 't', toolCallId: `file-${i}` });
  const identity = { sessionId: 's', turnId: 'legacy', requestId: 'legacy-r', round: 1, ordinal: 0 };
  const call = { protocol: 'bush.tool_call.v1', id: 'legacy-source', name: 'remember_source', argumentsText: '{}' };
  const number = store.reserveFileMemoReference({ ...identity, toolCallId: call.id });
  const reference = sourceMemoReference({ ...identity, toolCallId: call.id, number });
  const old = { protocol: 'bush.source_memo.v1', reference, markdown: `[45](${reference})`, explanation: 'Original immutable evidence.', sources: [], createdAt: new Date().toISOString() };
  store.record(call, identity, { kind: 'returned', result: old });
  const original = store.get('s','legacy',call.id);
  assert.equal(number,45);
  const continued = (await run('remember_source',{ explanation:'Continue existing numbering.' },{turnId:'after-legacy'})).result;
  assert.equal(parseSourceMemoReference(continued.reference),46);
  store.fork('s','fork',new Set(['legacy']));
  const forked = (await run('remember_source',{explanation:'New fork annotation.'},{sessionId:'fork',turnId:'new'})).result;
  assert.equal(parseSourceMemoReference(forked.reference),46,'fork does not inherit later turns');
  assert.notEqual(forked.reference,continued.reference);
  assert.deepEqual(resolveSourceReferences(store,{sessionId:'fork',turnId:'legacy',numbers:[45]}),[{number:45,reference}]);
  assert.deepEqual(store.get('s','legacy',call.id),original,'migration never rewrites previous tool results');
  persistence.close();
  const restarted = new ToolExecutionStore({persistence});
  for(const memo of [old,continued,forked])assert.deepEqual((await resolveSourceMemo(restarted,memo.reference)).memo,memo);
  const fresh = (await run('remember_source',{explanation:'Fresh conversation.'},{sessionId:'fresh'})).result;
  assert.equal(parseSourceMemoReference(fresh.reference),1);
});

test('versioned Source references reject malformed or oversized numbers and remain compatible with legacy links', () => {
  assert.deepEqual(parseSourceMemoIdentity('cardbush-source:45-0123456789abcdef'),{number:45,locator:45});
  assert.deepEqual(parseSourceMemoIdentity('cardbush-source:v2:1:45-0123456789abcdef'),{number:1,locator:45});
  for(const reference of ['cardbush-source:v2:0:45-0123456789abcdef','cardbush-source:v2:01:45-0123456789abcdef',
    'cardbush-source:v2:1:0-0123456789abcdef','cardbush-source:v2:1:1000000000-0123456789abcdef',
    'cardbush-source:v2:1:45','cardbush-source:v3:1:45-0123456789abcdef'])assert.equal(parseSourceMemoIdentity(reference),undefined);
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
