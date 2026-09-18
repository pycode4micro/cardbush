import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat, utimes, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import {
  InMemoryRuntimeHost, InMemoryRuntimeEventLog, FileRuntimeEventPersistence,
  FileSessionEventPersistence, SessionStore, AutomationScheduler, ToolExecutionStore, FileToolExecutionPersistence,
  CoordinationStore, FileCoordinationPersistence, SubagentTaskStore, FileSubagentTaskPersistence,
  InMemoryRuntimeCheckpointStore, RuntimeRecoveryCoordinator, CacheChainTracker,
} from '../dist/index.js';
import { McpAppObservations } from '../dist/mcpAppObservations.js';
import { WorkspaceRedoStore } from '../dist/workspaceRedoStore.js';
import { collectUnreferencedCache, fileCacheEntry } from '../dist/cacheMaintenance.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const exists = async path => Boolean(await stat(path).catch(() => undefined));
const request = (sessionId, content = 'Fixture.', turnId = `${sessionId}-turn`) => ({ protocol: 'bush.session_turn_request.v1', requestId: `${turnId}-request`, sessionId, turnId, model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Offline fixture.' }], inputMessages: [{ messageId: `${turnId}-user`, message: { role: 'user', content } }], tools: [], metadata: {} });
function provider(wait) { return { async *stream(input) {
  const event = (sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: input.requestId, sequence, createdAt: new Date().toISOString(), kind, ...payload });
  yield event(0, 'response_started'); if (wait) await wait();
  yield event(1, 'text_delta', { delta: 'Completed.' }); yield event(2, 'response_completed', { finishReason: 'stop' });
} }; }
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-cache-test-'));
  const handles = [], hosts = [];
  const open = () => {
    const sessions = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    const events = new FileRuntimeEventPersistence({ root: join(root, 'events') });
    const tools = new FileToolExecutionPersistence({ root: join(root, 'tool-executions') });
    const coordination = new FileCoordinationPersistence({ root: join(root, 'coordination') });
    const subagents = new FileSubagentTaskPersistence({ root: join(root, 'subagents') });
    handles.push(sessions, events, tools, coordination, subagents);
    const stores = { sessionStore: new SessionStore({ persistence: sessions }), eventLog: new InMemoryRuntimeEventLog({ persistence: events }),
      toolExecutionStore: new ToolExecutionStore({ persistence: tools }), coordinationStore: new CoordinationStore({ persistence: coordination }), subagentTaskStore: new SubagentTaskStore({ persistence: subagents }) };
    const runtime = new InMemoryRuntimeHost({ dataRoot: root, ...stores, registerDefaultWorkspaceTools: false, provider: provider(), ...overrides });
    hosts.push(runtime);
    return { ...stores, runtime };
  };
  t.after(async () => {
    for (const runtime of hosts) await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    for (const handle of handles) handle.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-cache-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, ...open(), reopen() { for (const handle of handles) handle.close(); return open(); } };
}
const record = (store, sessionId, result = {}) => store.record({ protocol: 'bush.tool_call.v1', id: 'tool-1', name: 'fixture', argumentsText: '{}' },
  { requestId: `${sessionId}-request`, sessionId, turnId: `${sessionId}-turn`, round: 1, ordinal: 0 }, { kind: 'returned', result });

test('deleting a session clears all owned journals, memory and unused automation contexts', async t => {
  const f = await fixture(t);
  const automation = new AutomationScheduler({ path: join(f.root, 'scheduler', 'automations.json'), canRun: () => false, run: async () => { throw Error('offline'); } });
  t.after(() => automation.close());
  const runtime = new InMemoryRuntimeHost({ dataRoot: f.root, sessionStore: f.sessionStore, eventLog: f.eventLog, toolExecutionStore: f.toolExecutionStore,
    coordinationStore: f.coordinationStore, subagentTaskStore: f.subagentTaskStore, provider: provider(), automation, registerDefaultWorkspaceTools: false });
  t.after(() => runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  await runtime.runSessionTurn(request('deleted'));
  record(f.toolExecutionStore, 'deleted');
  f.coordinationStore.createGoal({ goalId: 'goal', sessionId: 'deleted', objective: 'fixture' });
  f.subagentTaskStore.start({ taskId: 'task', parentSessionId: 'deleted', parentTurnId: 'deleted-turn', childSessionId: 'child', childTurnId: 'child-turn', prompt: 'fixture', inheritContext: false, inheritedMessageCount: 0 });
  await new McpAppObservations(join(f.root, 'mcp-apps', 'observations')).append('deleted', { turnId: 'deleted-turn', toolCallId: 'tool-1', source: 'fixture', resourceUri: 'ui://fixture', viewId: 'view', event: 'closed' });
  const result = await runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'deleted' } });
  assert.equal(result.deleted, true);
  const cleanup = await runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.deepEqual(cleanup.errors, []);
  for (const dir of ['sessions', 'events', 'tool-executions', 'coordination', 'subagents', 'mcp-apps/observations']) assert.deepEqual(await readdir(join(f.root, dir)), [], dir);
  assert.deepEqual(f.eventLog.replay('deleted', 'deleted-turn'), []);
  assert.deepEqual(f.toolExecutionStore.listTurn('deleted', 'deleted-turn'), []);
  assert.equal(f.coordinationStore.getGoal('deleted'), undefined);
  assert.deepEqual(f.subagentTaskStore.list('deleted'), []);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'scheduler', 'automations.json'), 'utf8')).contexts, {});
});

test('restart collection preserves cross-session memo references, shared images and redo; drops other orphans', async t => {
  const f = await fixture(t);
  const image = join(f.root, 'model-images', `${hash('image')}.png`), unused = join(f.root, 'model-images', `${hash('unused')}.png`);
  await mkdir(dirname(image), { recursive: true }); await writeFile(image, 'referenced image'); await writeFile(unused, 'unused');
  const redo = new WorkspaceRedoStore(join(f.root, 'workspace-redo')), revision = hash('after');
  await redo.save(revision, Buffer.from('after')); await redo.save(hash('other'), Buffer.from('other'));
  await f.runtime.runSessionTurn(request('source'));
  record(f.toolExecutionStore, 'source', { image, revision });
  const number = f.toolExecutionStore.reserveFileMemoReference({ sessionId: 'source', turnId: 'source-turn', toolCallId: 'tool-1' });
  await f.runtime.runSessionTurn(request('live', `Retain [file](cardbush-memo:${number})`));
  await f.runtime.runSessionTurn(request('orphan')); record(f.toolExecutionStore, 'orphan');
  f.sessionStore.deleteSession('source'); f.sessionStore.deleteSession('orphan');
  const restarted = f.reopen();
  const cleaned = await restarted.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.deepEqual(cleaned.errors, []);
  assert.equal(await exists(join(f.root, 'tool-executions', `${hash('source')}.jsonl`)), true);
  assert.equal(await exists(join(f.root, 'tool-executions', `${hash('orphan')}.jsonl`)), false);
  assert.equal(await exists(image), true); assert.equal(await exists(unused), false);
  assert.equal(await exists(join(f.root, 'workspace-redo', revision)), true);
  assert.equal(await exists(join(f.root, 'workspace-redo', hash('other'))), false);
  const cleared = await restarted.runtime.sendCommand({ kind: 'runtime.clear_sessions', payload: {} });
  assert.deepEqual(cleared.errors, []); assert.equal(cleared.counts.sessions, 1);
  assert.equal(await exists(image), false); assert.equal(await exists(join(f.root, 'workspace-redo', revision)), false);
  assert.equal(restarted.toolExecutionStore.reserveFileMemoReference({ sessionId: 'new', turnId: 'turn', toolCallId: 'tool' }), number + 1, 'stable memo IDs must never be reused');
});

test('busy maintenance rejects before deleting any session or blob', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { provider: provider(async () => { entered(); await gate; }) });
  f.sessionStore.ensureSession('idle');
  const pending = f.runtime.runSessionTurn(request('running')); await started;
  await assert.rejects(f.runtime.sendCommand({ kind: 'runtime.clear_sessions', payload: {} }), /settle|active/);
  await assert.rejects(f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} }), /settle|active/);
  assert.ok(f.sessionStore.snapshot('idle'));
  release(); await pending;
  const result = await f.runtime.sendCommand({ kind: 'runtime.clear_sessions', payload: {} });
  assert.equal(result.counts.sessions, 2);
});

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function within(promise, timeout = 500) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Operation did not settle promptly')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('Deferred cache collection did not finish');
}

test('deletion is acknowledged before unrelated cache enumeration finishes', async t => {
  const f = await fixture(t); f.sessionStore.ensureSession('remove');
  const gate = deferred(), entries = f.eventLog.cacheEntries.bind(f.eventLog);
  f.eventLog.cacheEntries = async () => { await gate.promise; return entries(); };
  const deletion = f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'remove' } });
  let timer;
  try {
    const result = await Promise.race([deletion, new Promise(resolve => { timer = setTimeout(() => resolve('still waiting for cache'), 500); })]);
    assert.notEqual(result, 'still waiting for cache', 'A persisted deletion must not wait for a global cache sweep');
    assert.equal(result.deleted, true);
    assert.equal(f.sessionStore.snapshot('remove'), undefined);
  } finally {
    clearTimeout(timer); gate.resolve(); await deletion;
    await f.runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  }
});

test('consecutive deletes preserve queued identities without a cache sweep per deletion', async t => {
  const gates = [deferred(), deferred()], entered = [deferred(), deferred()];
  let deletion = 0;
  const f = await fixture(t, { automation: { busy: false, async sessionDeleted() {
    const index = deletion++; entered[index]?.resolve(); await gates[index]?.promise;
  } } });
  for (const id of ['first', 'second', 'keep']) f.sessionStore.ensureSession(id);
  const entries = f.eventLog.cacheEntries.bind(f.eventLog); let sweep = 0;
  f.eventLog.cacheEntries = async () => { sweep++; return entries(); };
  const removed = [], remove = f.sessionStore.deleteSession.bind(f.sessionStore);
  f.sessionStore.deleteSession = id => { removed.push(id); return remove(id); };
  const jobs = [];
  try {
    const first = f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'first' } }); jobs.push(first);
    await entered[0].promise;
    const command = { kind: 'runtime.delete_session', payload: { sessionId: 'second' } };
    let secondSettled = false, readSettled = false;
    const second = f.runtime.sendCommand(command).then(result => { secondSettled = true; return result; }); jobs.push(second);
    const listing = f.runtime.sendCommand({ kind: 'runtime.list_sessions', payload: {} }).then(result => { readSettled = true; return result; }); jobs.push(listing);
    command.payload.sessionId = 'keep';
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false); assert.equal(readSettled, false);
    assert.deepEqual(removed, []); assert.ok(f.sessionStore.snapshot('second'));
    gates[0].resolve(); await entered[1].promise;
    assert.equal((await first).deleted, true);
    assert.equal(readSettled, false, 'the refresh waits again when the next deletion acquires the guard');
    gates[1].resolve();
    assert.equal((await second).sessionId, 'second'); assert.equal((await second).deleted, true);
    assert.deepEqual((await listing).map(session => session.sessionId), ['keep']);
    assert.deepEqual(removed, ['first', 'second'], 'each accepted deletion executes once against its original target');
    assert.equal(sweep, 0, 'global scanning is deferred and coalesced');
    assert.equal(f.runtime.hasActiveSession('keep'), false);
  } finally { gates.forEach(gate => gate.resolve()); await Promise.allSettled(jobs); }
});

for (const foreground of ['command', 'turn']) test(`idle cleanup coalesces deletes, permits reads and yields to a new ${foreground}`, async t => {
  const f = await fixture(t);
  for (const id of ['first', 'second', 'keep']) f.sessionStore.ensureSession(id);
  record(f.toolExecutionStore, 'first'); record(f.toolExecutionStore, 'second');
  const orphan = join(f.root, 'tool-executions', `${hash('first')}.jsonl`);
  const entered = deferred(), release = deferred(), entries = f.eventLog.cacheEntries.bind(f.eventLog);
  let scans = 0, scanSignal;
  f.eventLog.cacheEntries = async () => {
    const round = ++scans;
    return [...await entries(), { category: 'fixture', keys: ['keep'], owner: 'keep', bytes: 0, async remove() {},
      async scan(_visit, signal) {
        if (round !== 1) return;
        scanSignal = signal; entered.resolve();
        await new Promise(resolve => {
          const done = () => { signal?.removeEventListener('abort', done); resolve(); };
          signal?.addEventListener('abort', done, { once: true });
          release.promise.then(done);
        });
        signal?.throwIfAborted();
      },
    }];
  };
  try {
    for (const id of ['first', 'second']) assert.equal((await f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: id } })).deleted, true);
    assert.equal(scans, 0);
    await within(entered.promise, 3000);
    assert.deepEqual((await within(f.runtime.sendCommand({ kind: 'runtime.list_sessions', payload: {} }))).map(session => session.sessionId), ['keep']);
    assert.equal((await within(f.runtime.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'keep' } }))).sessionId, 'keep');
    assert.equal(scanSignal.aborted, false, 'read-only refreshes do not repeatedly cancel maintenance');
    const result = await within(foreground === 'command'
      ? f.runtime.sendCommand({ kind: 'runtime.create_session', payload: { sessionId: 'new' } })
      : f.runtime.runSessionTurn(request('new')), 1000);
    assert.ok(result); assert.equal(scanSignal.aborted, true);
    assert.equal(await exists(orphan), true, 'cancelled reference scan cannot start the sweep');
    assert.ok(f.sessionStore.snapshot('new'));
    await until(async () => !await exists(orphan) && !f.runtime.hasActiveSession('keep'));
    assert.equal(scans, 2, 'one coalesced scan plus one retry after foreground work');
    assert.equal(await exists(join(f.root, 'tool-executions', `${hash('second')}.jsonl`)), false);
    assert.ok(f.sessionStore.snapshot('keep')); assert.ok(f.sessionStore.snapshot('new'));
  } finally { release.resolve(); }
});

test('idle collection waits for an active turn and shutdown cancels scheduled work', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, { provider: provider(async () => { started.resolve(); await gate.promise; }) });
  f.sessionStore.ensureSession('remove'); record(f.toolExecutionStore, 'remove');
  const entries = f.eventLog.cacheEntries.bind(f.eventLog); let scans = 0;
  f.eventLog.cacheEntries = async () => { scans++; return entries(); };
  await f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'remove' } });
  const turn = f.runtime.runSessionTurn(request('running'));
  try {
    await started.promise;
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(scans, 0, 'deferred cleanup cannot sweep during a turn');
    gate.resolve(); await turn;
    await f.runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(scans, 0, 'shutdown clears the pending timer');
    assert.equal(await exists(join(f.root, 'tool-executions', `${hash('remove')}.jsonl`)), true);
  } finally { gate.resolve(); await turn; }
});

test('aborting a retained file scan never sweeps unmarked files', async t => {
  const f = await fixture(t), file = join(f.root, 'retained.jsonl');
  await writeFile(file, 'retained content\n'.repeat(10000));
  const controller = new AbortController(), entry = fileCacheEntry({ path: file, bytes: (await stat(file)).size }, 'fixture', ['keep']);
  const scan = entry.scan;
  entry.scan = (visit, signal) => scan(chunk => { visit(chunk); controller.abort(); }, signal);
  let removed = false;
  await assert.rejects(collectUnreferencedCache([entry, { category: 'fixture', keys: [], bytes: 0, async scan() {}, async remove() { removed = true; } }], ['keep'], [], controller.signal), { name: 'AbortError' });
  assert.equal(removed, false); assert.equal(await exists(file), true);
});

test('maintenance failure releases waiting reads and deletes without forwarding its error', async t => {
  const f = await fixture(t); f.sessionStore.ensureSession('remove'); f.sessionStore.ensureSession('keep');
  const gate = deferred(), entered = deferred(), entries = f.eventLog.cacheEntries.bind(f.eventLog); let reads = 0;
  f.eventLog.cacheEntries = async () => { if (++reads === 1) { entered.resolve(); await gate.promise; throw Error('Fixture cache scan failed'); } return entries(); };
  const maintenance = assert.rejects(f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} }), /Fixture cache scan failed/);
  const jobs = [maintenance];
  try {
    await entered.promise;
    const deletion = f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'remove' } }); jobs.push(deletion);
    const listing = f.runtime.sendCommand({ kind: 'runtime.list_sessions', payload: {} }); jobs.push(listing);
    gate.resolve(); await maintenance;
    assert.equal((await deletion).deleted, true);
    assert.deepEqual((await listing).map(session => session.sessionId), ['keep']);
    assert.equal(reads, 1, 'deletion does not immediately repeat the failed cache scan');
    assert.equal(f.runtime.hasActiveSession('keep'), false);
  } finally { gate.resolve(); await Promise.allSettled(jobs); }
});

for (const releaseImmediately of [false, true]) test(`a cancelled queued deletion never executes (release immediately: ${releaseImmediately})`, async t => {
  const f = await fixture(t); f.sessionStore.ensureSession('keep');
  const gate = deferred(), entered = deferred(), entries = f.eventLog.cacheEntries.bind(f.eventLog);
  f.eventLog.cacheEntries = async () => { entered.resolve(); await gate.promise; return entries(); };
  const maintenance = f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  try {
    await entered.promise;
    const controller = new AbortController();
    const cancelled = assert.rejects(f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'keep' } }, controller.signal), { name: 'AbortError' });
    controller.abort(); if (releaseImmediately) gate.resolve();
    await cancelled; gate.resolve(); await maintenance;
    assert.ok(f.sessionStore.snapshot('keep'));
    assert.deepEqual((await f.runtime.sendCommand({ kind: 'runtime.list_sessions', payload: {} })).map(session => session.sessionId), ['keep']);
  } finally { gate.resolve(); await maintenance; }
});

test('a recoverable checkpoint protects snapshots even without a committed session', async t => {
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const f = await fixture(t, { checkpointStore: checkpoints });
  const image = join(f.root, 'model-images', `${hash('pending')}.png`);
  await mkdir(dirname(image), { recursive: true }); await writeFile(image, 'pending image');
  const input = { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'recoverable', turnId: 'turn', model: 'fixture', messages: [{ role: 'user', content: image }], tools: [], metadata: {} };
  const recovery = new RuntimeRecoveryCoordinator({ eventLog: f.eventLog, checkpoints });
  f.eventLog.append({ requestId: input.requestId, sessionId: input.sessionId, turnId: input.turnId }, { kind: 'turn_accepted', payload: { status: 'accepted' } });
  recovery.save({ request: input, messages: input.messages, nextRound: 1, cacheChainState: new CacheChainTracker().snapshot() });
  await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.equal(await exists(image), true); assert.equal(checkpoints.list().length, 1);
});

test('corrupt identity fails closed before sweeping; user outputs survive', async t => {
  const f = await fixture(t);
  await f.runtime.runSessionTurn(request('orphan')); record(f.toolExecutionStore, 'orphan');
  f.sessionStore.deleteSession('orphan');
  const file = join(f.root, 'tool-executions', `${hash('orphan')}.jsonl`);
  await writeFile(file, (await readFile(file, 'utf8')).replace('bush.tool_execution_journal_record.v1', 'bad'));
  const output = join(f.root, 'model-images', `${hash('user')}.png`);
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, 'do not sweep');
  await assert.rejects(f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} }), /safely identify/);
  assert.equal(await exists(output), true);
  await assert.rejects(f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} }), /safely identify/, 'maintenance lock must release on failure');
});

test('managed capture collection preserves referenced and recent files and ignores custom output', async t => {
  const f = await fixture(t), captureRoot = join(f.root, 'captures');
  await mkdir(captureRoot); await mkdir(join(f.root, 'user-output'));
  const retained = join(captureRoot, 'capture-1-shared.png'), expired = join(captureRoot, 'capture-2-expired.png'), fresh = join(captureRoot, 'capture-3-new.png');
  for (const file of [retained, expired, fresh, join(f.root, 'user-output', 'capture-4-user.png')]) await writeFile(file, 'fixture');
  for (const file of [retained, expired]) await utimes(file, new Date(0), new Date(0));
  await f.runtime.runSessionTurn(request('live', retained));
  await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.equal(await exists(retained), true); assert.equal(await exists(expired), false); assert.equal(await exists(fresh), true);
  assert.equal(await exists(join(f.root, 'user-output', 'capture-4-user.png')), true);
});

test('reference detection spans streaming chunk boundaries and closes over multiple owners', async t => {
  const f = await fixture(t), first = join(f.root, 'a'), second = join(f.root, 'b'), orphan = join(f.root, 'c');
  const owner = 'owner-b-reference';
  await writeFile(first, ' '.repeat(65530) + owner); await writeFile(second, 'content'); await writeFile(orphan, 'orphan');
  const entries = await Promise.all([[first, 'owner-a'], [second, owner], [orphan, 'owner-c']].map(async ([path, id]) => fileCacheEntry({ path, bytes: (await stat(path)).size }, 'fixture', [id], id)));
  const result = await collectUnreferencedCache(entries, ['owner-a']);
  assert.deepEqual(result.errors, []); assert.equal(await exists(second), true); assert.equal(await exists(orphan), false);
});

test('MCP App contexts share the reference graph and expired partial snapshots are reclaimed', async t => {
  const f = await fixture(t), root = join(f.root, 'mcp-apps');
  await mkdir(root, { recursive: true }); await mkdir(join(f.root, 'model-images'));
  const context = join(root, `${hash(JSON.stringify(['kept', 'context']))}.json`), orphan = join(root, `${hash(JSON.stringify(['gone', 'context']))}.json`);
  await writeFile(context, JSON.stringify({ tool: { source: 'fixture', content: { state: 'kept' } } }));
  await writeFile(orphan, JSON.stringify({ tool: { source: 'fixture', content: { state: 'gone' } } }));
  const temp = join(f.root, 'model-images', '21dbe6d7-68f3-4eae-9e11-0ee9fc32f106.tmp');
  await writeFile(temp, 'incomplete'); await utimes(temp, new Date(0), new Date(0));
  f.sessionStore.ensureSession('kept');
  const result = await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.deepEqual(result.errors, []); assert.equal(await exists(context), true); assert.equal(await exists(orphan), false); assert.equal(await exists(temp), false);
});

test('bulk preflight keeps every session when one still owns a worktree', async t => {
  const f = await fixture(t), source = join(f.root, 'project');
  await mkdir(source); await writeFile(join(source, 'user.txt'), 'untouched');
  execFileSync('git', ['init', '-q', source], { windowsHide: true });
  const git = args => execFileSync('git', ['-C', source, ...args], { windowsHide: true });
  git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  f.sessionStore.ensureSession('first');
  await f.runtime.sendCommand({ kind: 'runtime.create_session', payload: { sessionId: 'protected', workspace: { sourceDir: source, mode: 'worktree' }, metadata: {} } });
  await assert.rejects(f.runtime.sendCommand({ kind: 'runtime.clear_sessions', payload: {} }), /independent workspace/);
  assert.ok(f.sessionStore.snapshot('first')); assert.ok(f.sessionStore.snapshot('protected'));
  assert.equal(await readFile(join(source, 'user.txt'), 'utf8'), 'untouched');
});

test('automation cleanup keeps plans and results, pauses deleted targets, and removes orphan contexts', async t => {
  const f = await fixture(t), scheduler = new AutomationScheduler({ path: join(f.root, 'automations.json'), canRun: () => false, run: async () => { throw Error('offline'); } });
  t.after(() => scheduler.close());
  for (const id of ['live', 'orphan', 'scheduled']) await scheduler.remember(request(id));
  await scheduler.manage({ action: 'create', definition: { name: 'Fixture', sessionId: 'scheduled', prompt: 'Keep this plan', timeZone: 'UTC', trigger: { kind: 'once', at: '2099-01-01T00:00:00Z' } } });
  const result = await scheduler.collectContexts(new Set(['live']));
  assert.equal(result.removed, 2); assert.ok(result.roots.contexts.live); assert.equal(result.roots.contexts.scheduled, undefined); assert.equal(result.roots.jobs.length, 1);
  assert.ok(result.roots.jobContexts[result.roots.jobs[0].id], 'timer settings survive source-context collection');
  await scheduler.sessionDeleted('scheduled');
  const overview = await scheduler.list(); assert.equal(overview.jobs[0].state, 'active'); assert.equal(overview.jobs[0].prompt, 'Keep this plan');
  assert.equal(JSON.parse(await readFile(join(f.root, 'automations.json'), 'utf8')).contexts.scheduled, undefined);
});

test('child sessions follow parent retention while independent conversations remain', async t => {
  const f = await fixture(t);
  f.sessionStore.ensureSession('parent'); f.sessionStore.ensureSession('unrelated');
  f.sessionStore.ensureSession('child', { agentRole: 'child', parentSessionId: 'parent' });
  f.sessionStore.ensureSession('grandchild', { agentRole: 'child', parentSessionId: 'child' });
  f.sessionStore.ensureSession('orphan-child', { agentRole: 'child', parentSessionId: 'missing-parent' });
  record(f.toolExecutionStore, 'child'); record(f.toolExecutionStore, 'orphan-child');
  await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.ok(f.sessionStore.snapshot('child')); assert.ok(f.sessionStore.snapshot('grandchild')); assert.equal(f.sessionStore.snapshot('orphan-child'), undefined);
  const result = await f.runtime.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: 'parent' } });
  assert.equal(result.deleted, true);
  const cleanup = await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} });
  assert.deepEqual(cleanup.errors, []); assert.equal(cleanup.counts.child_sessions, 2);
  assert.equal(f.sessionStore.snapshot('child'), undefined); assert.equal(f.sessionStore.snapshot('grandchild'), undefined);
  assert.ok(f.sessionStore.snapshot('unrelated'));
  assert.deepEqual(f.toolExecutionStore.listTurn('child', 'child-turn'), []);
});

test('large orphan journals are identified with bounded reads without materializing their contents', async t => {
  const f = await fixture(t); record(f.toolExecutionStore, 'large-orphan');
  const file = join(f.root, 'tool-executions', `${hash('large-orphan')}.jsonl`), size = 96 * 1024 * 1024;
  const handle = await open(file, 'r+'); await handle.truncate(size); await handle.close();
  const baseline = process.memoryUsage().external; let peak = baseline;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().external); }, 2);
  let result;
  try { result = await f.runtime.sendCommand({ kind: 'runtime.collect_cache', payload: {} }); }
  finally { clearInterval(timer); }
  assert.deepEqual(result.errors, []); assert.equal(await exists(file), false); assert.equal(result.counts.bytes, size);
  assert.ok(peak - baseline < 24 * 1024 * 1024, `Unexpected allocation while cleaning an orphan: ${peak - baseline}`);
});
