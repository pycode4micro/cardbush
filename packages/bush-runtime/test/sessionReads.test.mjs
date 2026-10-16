import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { FileSessionEventPersistence, SessionStore, InMemoryRuntimeHost, ToolExecutionStore } from '../dist/index.js';
import { sessionSummarySchema, sessionHistoryPageSchema, summarizeSession } from '@cardbush/bush-protocol';

const turn = (i, content = `question ${i}`) => ({ turnId: `turn-${i}`, turnSequence: i,
  createdAt: new Date(1700000000000 + i * 1000).toISOString(), completedAt: new Date(1700000000500 + i * 1000).toISOString(),
  status: 'completed', reason: 'model_response_completed', usage: {},
  messages: [{ role: 'user', content }, { role: 'assistant', content: `answer ${i}`, toolCalls: [], reasoningContent: 'private reasoning' }].map((message, messageIndex) => ({
    messageId: `message-${i}-${messageIndex}`, turnId: `turn-${i}`, turnSequence: i, messageIndex,
    createdAt: new Date(1700000000000 + i * 1000).toISOString(), message })) });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-session-reads-'));
  const persistence = new FileSessionEventPersistence({ root });
  const store = new SessionStore({ persistence, ...options });
  t.after(async () => { persistence.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  return { root, persistence, store };
}

test('100-session lists contain bounded excerpts and never hydrate the SessionStore', async t => {
  const f = await fixture(t), large = 'input '.repeat(1800);
  for (let i = 0; i < 100; i++) f.store.commitTurn(`s-${i}`, turn(1, large));
  let fullReads = 0;
  f.persistence.load = () => { fullReads++; throw Error('List must not read a full session'); };
  const reader = new SessionStore({ persistence: f.persistence });
  const cold = await reader.listSummaries(), warm = await reader.listSummaries();
  assert.deepEqual(cold, warm); assert.equal(cold.length, 100); assert.equal(fullReads, 0);
  assert.ok(JSON.stringify(warm).length < 500_000);
  assert.ok(warm.every(value => sessionSummarySchema.safeParse(value).success && !('turns' in value) && value.firstUserText.length === 4000));
  assert.equal(JSON.stringify(warm).includes('private reasoning'), false);
});

test('paged history is contiguous across restart and append; a supersession invalidates old cursors', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 45; i++) f.store.commitTurn('s', turn(i));
  const first = await f.store.historyPage({ sessionId: 's', limit: 20 });
  assert.deepEqual(first.snapshot.turns.map(turn => turn.turnSequence), Array.from({ length: 20 }, (_, i) => 26 + i));
  assert.equal(first.nextCursor.beforeTurnSequence, 26);
  f.store.commitTurn('s', turn(46));
  f.persistence.close();
  const reopened = new FileSessionEventPersistence({ root: f.root }); t.after(() => reopened.close());
  reopened.load = () => { throw Error('Paging must read indexed ranges'); };
  const reader = new SessionStore({ persistence: reopened });
  const second = await reader.historyPage({ sessionId: 's', limit: 20, cursor: first.nextCursor });
  assert.equal(second.summary.turnCount, 46);
  assert.deepEqual(second.snapshot.turns.map(turn => turn.turnSequence), Array.from({ length: 20 }, (_, i) => 6 + i));
  assert.equal(second.beforeCreatedAt, turn(26).createdAt, 'journal entries between turns belong to exactly one page');
  const third = await reader.historyPage({ sessionId: 's', limit: 20, cursor: second.nextCursor });
  assert.deepEqual(third.snapshot.turns.map(turn => turn.turnSequence), [1,2,3,4,5]); assert.equal(third.nextCursor, null);
  f.store.supersedeMessages({ sessionId: 's', messageIds: ['message-1-0'], reason: 'user_edit_regenerate', replacementTurnId: 'turn-47' });
  await assert.rejects(reader.historyPage({ sessionId: 's', limit: 20, cursor: first.nextCursor }), { code: 'session_history_changed' });
  const summary = (await reader.listSummaries())[0];
  assert.deepEqual(summary, summarizeSession(f.store.snapshot('s')));
  assert.equal(summary.firstUserText, 'question 2');
});

test('derived index corruption rebuilds; truncated tails and aborts never change the source', async t => {
  const f = await fixture(t); f.store.commitTurn('s', turn(1));
  await f.store.listSummaries(); f.persistence.close();
  const file = (await readdir(f.root)).find(file => file.endsWith('.jsonl')), path = join(f.root, file);
  await writeFile(path + '.session-index', '{broken index'); await appendFile(path, '{unfinished');
  const original = await readFile(path);
  const reopened = new FileSessionEventPersistence({ root: f.root }); t.after(() => reopened.close());
  assert.equal((await reopened.listSummaries())[0].turnCount, 1);
  assert.deepEqual(await readFile(path), original);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reopened.historyPage({ sessionId: 's', limit: 20 }, controller.signal), { name: 'AbortError' });
  assert.equal(reopened.remove('s'), true);
  assert.equal(await reopened.historyPage({ sessionId: 's', limit: 20 }), undefined);
  assert.deepEqual(await readdir(f.root), []);
});

test('idle session cache evicts by count and bytes while protecting active work', async t => {
  const f = await fixture(t, { idleCacheLimit: 2, idleCacheBytes: 10_000 });
  f.store.commitTurn('active', turn(1)); f.store.protect('active', true);
  for (let i = 0; i < 8; i++) f.store.commitTurn(`s${i}`, turn(1));
  const load = f.persistence.load.bind(f.persistence), reads = [];
  f.persistence.load = id => { reads.push(id); return load(id); };
  f.store.snapshot('active'); assert.deepEqual(reads, []);
  assert.equal(f.store.snapshot('s0').turns.length, 1); assert.deepEqual(reads, ['s0']);
  f.store.commitTurn('huge', turn(1, 'x'.repeat(20_000))); reads.length = 0;
  assert.equal(f.store.snapshot('huge').turns[0].messages[0].message.content.length, 20_000);
  assert.deepEqual(reads, ['huge']);
  const volatile = new SessionStore({ idleCacheLimit: 0, idleCacheBytes: 0 });
  volatile.commitTurn('s', turn(1)); assert.equal(volatile.snapshot('s').turns.length, 1);
});

test('an unavailable derived cache never prevents reading canonical session history', async t => {
  const f = await fixture(t); f.store.commitTurn('s', turn(1));
  const file = (await readdir(f.root)).find(file => file.endsWith('.jsonl')), path = join(f.root, file);
  const original = await readFile(path);
  // A directory at the cache path makes both cache reads and replacement fail on Windows and Unix.
  await mkdir(path + '.session-index');
  assert.equal((await f.store.listSummaries())[0].turnCount, 1);
  assert.equal((await f.store.historyPage({ sessionId: 's', limit: 20 })).snapshot.turns[0].turnId, 'turn-1');
  assert.deepEqual(await readFile(path), original);
  assert.equal((await readdir(f.root)).some(file => file.endsWith('.tmp')), false);
  assert.equal(f.persistence.remove('s'), true);
  assert.equal(await f.store.historyPage({ sessionId: 's', limit: 20 }), undefined);
});

test('history command batches only selected tool summaries and omits model-only bodies', async t => {
  const sessions = new SessionStore(), executions = new ToolExecutionStore();
  for (let i = 1; i <= 3; i++) {
    sessions.commitTurn('s', turn(i));
    executions.record({ protocol: 'bush.tool_call.v1', id: `call-${i}`, name: 'read_file', argumentsText: '{}' },
      { requestId: 'r', sessionId: 's', turnId: `turn-${i}`, round: 1, ordinal: 0 }, { kind: 'returned', result: { text: 'file data' } });
  }
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, toolExecutionStore: executions });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const page = sessionHistoryPageSchema.parse(await host.sendCommand({ kind: 'runtime.get_session_history', payload: { sessionId: 's', limit: 1 } }));
  assert.equal(page.snapshot.turns.length, 1); assert.equal(page.snapshot.turns[0].turnId, 'turn-3');
  assert.equal(page.toolExecutions.length, 1); assert.equal(page.toolExecutions[0].turnId, 'turn-3');
  assert.equal(JSON.stringify(page).includes('private reasoning'), false);
});
