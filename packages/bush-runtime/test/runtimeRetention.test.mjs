import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, utimes, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { FileRuntimeEventPersistence, InMemoryRuntimeEventLog, RuntimeEventProjector, InMemoryRuntimeHost } from '../dist/index.js';
import { collectUnreferencedCache, blobCacheEntries, sessionCacheKeys } from '../dist/cacheMaintenance.js';
import { sourceMemoReference } from '../dist/sourceMemo.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = name => ({ requestId: `request-${name}`, sessionId: `session-${name}`, turnId: `turn-${name}` });
const journal = (root, id) => join(root, `${hash(JSON.stringify([id.sessionId, id.turnId]))}.jsonl`);
const old = async path => { const age = new Date(Date.now() - 8 * 86400_000); await utimes(path, age, age); };
const exists = async path => Boolean(await stat(path).catch(() => undefined));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-retention-'));
  const persistence = new FileRuntimeEventPersistence({ root });
  const log = new InMemoryRuntimeEventLog({ persistence });
  t.after(async () => {
    persistence.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-retention-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, persistence, log };
}
function fill(log, id, { terminal = true, extra = '' } = {}) {
  log.append(id, { kind: 'turn_accepted', payload: { status: 'accepted' } });
  const projector = new RuntimeEventProjector(log, id, { deltaFlushIntervalMs: 0 });
  for (let i = 0; i < 180; i++) projector.accept({ protocol: 'bush.model_event.v1', requestId: id.requestId,
    sequence: i, createdAt: new Date().toISOString(), kind: 'text_delta', delta: `中文完整消息 ${i}: ${'x'.repeat(600)} ${extra}\n` });
  projector.completeOpenSegment();
  if (terminal) log.append(id, { kind: 'turn_terminal', payload: { status: 'completed', reason: 'done', details: {} } });
  return log.replay(id.sessionId, id.turnId);
}

test('old terminal journals archive losslessly; restart and all cursor forms remain exact', async t => {
  const f = await fixture(t), id = identity('archive');
  const events = fill(f.log, id), file = journal(f.root, id), original = await readFile(file);
  await old(file);
  const result = await f.log.maintain();
  assert.deepEqual(result.errors, []); assert.equal(result.counts.archived_files, 1);
  assert.equal(await exists(file), false);
  const compressed = await readFile(`${file}.gz`);
  assert.deepEqual(gunzipSync(compressed), original);
  assert.ok(compressed.length < original.length / 3);
  const persistence = new FileRuntimeEventPersistence({ root: f.root });
  t.after(() => persistence.close());
  const restarted = new InMemoryRuntimeEventLog({ persistence });
  assert.deepEqual(restarted.replay(id.sessionId, id.turnId), events);
  const cursor = events[90];
  for (const after of [{ afterSequence: cursor.sequence }, { lastEventId: cursor.eventId }, { afterSequence: cursor.sequence, lastEventId: cursor.eventId }]) {
    assert.deepEqual(restarted.replay(id.sessionId, id.turnId, after), events.slice(91));
    assert.deepEqual(await Array.fromAsync(restarted.subscribe(id.sessionId, id.turnId, after)), events.slice(91));
  }
  assert.throws(() => restarted.replay(id.sessionId, id.turnId, { afterSequence: 1, lastEventId: cursor.eventId }), /does not match/);
  assert.throws(() => persistence.append(events[0]), /archived terminal/);
});

test('recent, open and unfinished journals are retained, including restart recovery input', async t => {
  const f = await fixture(t);
  for (const name of ['recent', 'open', 'unfinished']) {
    const id = identity(name); fill(f.log, id, { terminal: name === 'recent' });
    if (name !== 'recent') await old(journal(f.root, id));
  }
  assert.equal((await f.persistence.maintain()).counts.archived_files, 0);
  f.persistence.close();
  const restart = new FileRuntimeEventPersistence({ root: f.root }); t.after(() => restart.close());
  assert.equal((await restart.maintain()).counts.archived_files, 0);
  assert.equal(restart.load('session-unfinished', 'turn-unfinished').at(-1).kind, 'assistant_segment_completed');
  assert.equal((await readdir(f.root)).filter(name => name.endsWith('.jsonl')).length, 3);
});

test('corrupt or interrupted journals are not replaced during maintenance', async t => {
  const f = await fixture(t), id = identity('corrupt'); fill(f.log, id);
  const file = journal(f.root, id);
  const bytes = (await readFile(file, 'utf8')).replace('"status":"accepted"', '"status":"running"');
  await writeFile(file, bytes); await old(file);
  const result = await f.persistence.maintain();
  assert.equal(result.counts.archived_files, 0); assert.match(result.errors[0], /checksum/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  assert.equal(await exists(`${file}.gz`), false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.persistence.maintain(controller.signal), { name: 'AbortError' });
});

test('a verified archive left beside its original is reconciled after interruption; conflicts preserve both', async t => {
  const f = await fixture(t), id = identity('interrupted'); fill(f.log, id);
  const file = journal(f.root, id), bytes = await readFile(file); await old(file);
  await f.persistence.maintain();
  await writeFile(file, bytes); await old(file);
  assert.equal((await f.persistence.maintain()).counts.archived_files, 1);
  await writeFile(file, bytes); await old(file);
  await writeFile(`${file}.gz`, 'damaged archive');
  const result = await f.persistence.maintain();
  assert.equal(result.counts.archived_files, 0); assert.equal(result.errors.length, 1);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(f.persistence.load(id.sessionId, id.turnId), f.log.replay(id.sessionId, id.turnId));
});

test('reference collection reads compressed content and keeps attachments, then removes orphan archives', async t => {
  const f = await fixture(t), id = identity('refs'), imageKey = hash('referenced image');
  fill(f.log, id, { extra: imageKey });
  const file = journal(f.root, id); await old(file); await f.persistence.maintain();
  const blobs = join(f.root, 'blobs'); await mkdir(blobs);
  await writeFile(join(blobs, `${imageKey}.png`), 'keep');
  await writeFile(join(blobs, `${hash('unused')}.png`), 'remove');
  const entries = [...await f.persistence.cacheEntries(), ...await blobCacheEntries(blobs, 'images', name => name.endsWith('.png'))];
  const locators = [{ number: 33, sessionId: id.sessionId, turnId: id.turnId, toolCallId: 'evidence' }];
  for (const roots of [sessionCacheKeys(id.sessionId), ['cardbush-memo:33'], [sourceMemoReference(locators[0])]]) {
    const retained = await collectUnreferencedCache(entries, roots, locators);
    assert.deepEqual(retained.errors, []); assert.equal(await exists(`${file}.gz`), true);
  }
  assert.deepEqual(await readdir(blobs), [`${imageKey}.png`]);
  const removed = await collectUnreferencedCache([...await f.persistence.cacheEntries(), ...await blobCacheEntries(blobs, 'images', () => true)], []);
  assert.deepEqual(removed.errors, []); assert.equal(await exists(`${file}.gz`), false); assert.deepEqual(await readdir(blobs), []);
});

test('linked archive targets are rejected and staging leftovers respect the grace period', async t => {
  const f = await fixture(t), id = identity('links'); fill(f.log, id);
  const file = journal(f.root, id); await old(file);
  const external = join(f.root, 'external'); await mkdir(external); await writeFile(join(external, 'keep'), 'keep');
  await symlink(external, `${file}.gz`, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.persistence.maintain();
  assert.match(result.errors[0], /owned regular file/); assert.equal(await exists(file), true);
  assert.equal(await readFile(join(external, 'keep'), 'utf8'), 'keep');
  const temp = join(f.root, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp');
  await copyFile(file, temp);
  await utimes(temp, new Date(), new Date());
  assert.equal((await f.persistence.cacheEntries()).some(entry => entry.file === temp), false);
  await old(temp);
  assert.equal((await f.persistence.cacheEntries()).some(entry => entry.file === temp), true);
});

test('a damaged retained archive aborts reference collection before any orphan is deleted', async t => {
  const f = await fixture(t), id = identity('bad-archive'); fill(f.log, id);
  const file = journal(f.root, id); await old(file); await f.persistence.maintain();
  const entries = await f.persistence.cacheEntries();
  const bytes = await readFile(`${file}.gz`); await writeFile(`${file}.gz`, bytes.subarray(0, bytes.length - 8));
  let deleted = false;
  entries.push({ category: 'fixture', keys: [], bytes: 0, scan: async () => {}, remove: async () => { deleted = true; } });
  await assert.rejects(collectUnreferencedCache(entries, sessionCacheKeys(id.sessionId)));
  assert.equal(deleted, false);
});

test('inactive terminal memory is released and reloadable, while listeners and active turns stay resident', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t), done = identity('memory'), busy = identity('busy');
  const events = fill(f.log, done); fill(f.log, busy, { terminal: false });
  const reading = f.log.subscribe(done.sessionId, done.turnId);
  await reading.next();
  t.mock.timers.tick(11 * 60_000);
  assert.equal((await f.log.maintain()).counts.evicted_event_streams ?? 0, 0);
  await reading.return();
  assert.equal((await f.log.maintain()).counts.evicted_event_streams, 1);
  assert.deepEqual(f.log.replay(done.sessionId, done.turnId), events);
  assert.equal((await f.log.cacheEntries()).filter(entry => entry.category === 'events' && !entry.file).length, 2);
});

test('runtime schedules idle maintenance after startup and hourly, then cancels timers on shutdown', async t => {
  const f = await fixture(t); let passes = 0;
  f.log.maintain = async () => ({ counts: { pass: ++passes }, errors: [] });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const runtime = new InMemoryRuntimeHost({ dataRoot: f.root, eventLog: f.log, registerDefaultWorkspaceTools: false,
    provider: { async *stream() { throw Error('No model calls expected'); } } });
  t.after(() => runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const settle = async () => { for (let i = 0; i < 100 && runtime.hasActiveSession('fixture'); i++) await new Promise(resolve => setImmediate(resolve)); };
  t.mock.timers.tick(60_000); await settle(); assert.equal(passes, 1);
  t.mock.timers.tick(60 * 60_000); t.mock.timers.tick(1000); await settle(); assert.equal(passes, 2);
  await runtime.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  t.mock.timers.tick(2 * 60 * 60_000); assert.equal(passes, 2);
});

test('bounded archive passes advance past unfinished history instead of starving later completed turns', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 17; index++) {
    const id = identity(`batch-${index}`); fill(f.log, id, { terminal: index === 16 });
    const time = new Date(Date.now() - 9 * 86400_000 + index * 1000);
    await utimes(journal(f.root, id), time, time);
  }
  f.persistence.close();
  assert.equal((await f.persistence.maintain()).counts.archived_files, 0);
  assert.equal((await f.persistence.maintain()).counts.archived_files, 1);
  assert.equal(await exists(`${journal(f.root, identity('batch-16'))}.gz`), true);
});
