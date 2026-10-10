import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const { outputText: code } = ts.transpileModule(await readFile(new URL('../web/browserCache.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { AccountCache, cacheEvictions, cacheLimits } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
class Disk {
  entries = new Map();
  id(owner, key) { return JSON.stringify([owner, key]); }
  async read(owner, key) { return structuredClone(this.entries.get(this.id(owner, key))); }
  async write(entry, valid) { if (valid()) this.entries.set(entry.id, structuredClone(entry)); }
  async remove(owner, key) { this.entries.delete(this.id(owner, key)); }
  async clear() { this.entries.clear(); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('conversation and image caches are partitioned by authenticated account, including identical personal paths', async () => {
  const disk = new Disk(), alice = new AccountCache('alice', disk), bob = new AccountCache('bob', disk);
  alice.put('state:chat', { text: 'Alice private history' }, 'state');
  alice.put('image:/data/workspaces/shared.png', new Blob(['private'], { type: 'image/png' }), 'image');
  await alice.settled();
  assert.equal(await bob.get('state:chat'), undefined);
  assert.equal(await bob.get('image:/data/workspaces/shared.png'), undefined);
  alice.close(); const reopened = new AccountCache('alice', disk);
  assert.deepEqual(await reopened.get('state:chat'), { text: 'Alice private history' });
  assert.equal(await (await reopened.get('image:/data/workspaces/shared.png')).text(), 'private');
});
test('late disk reads cannot replace newer network messages or resurrect deleted sessions', async () => {
  const disk = new Disk(), cache = new AccountCache('alice', disk), wait = deferred();
  cache.put('state:chat', { text: 'old' }, 'state'); await cache.settled();
  const cold = new AccountCache('alice', disk), read = disk.read.bind(disk);
  disk.read = async (...args) => { const value = await read(...args); await wait.promise; return value; };
  const pending = cold.get('state:chat');
  cold.put('state:chat', { text: 'new' }, 'state'); wait.resolve();
  assert.deepEqual(await pending, { text: 'new' });
  cold.removeSession('chat'); await cold.settled();
  assert.equal(await cold.get('state:chat'), undefined);
  cold.reconcileSessions(['other']); cold.put('state:chat', { text: 'late request' }, 'state');
  assert.equal(cold.peek('state:chat'), undefined);
  cold.allowSession('created'); cold.put('state:created', { text: 'new session' }, 'state');
  assert.deepEqual(cold.peek('state:created'), { text: 'new session' });
});
test('logout or cross-tab identity changes fence in-flight reads and queued writes', async () => {
  const disk = new Disk(), wait = deferred(); let identity = 'alice';
  const cache = new AccountCache('alice', disk, () => identity === 'alice');
  disk.write = async (entry, valid) => { await wait.promise; if (valid()) disk.entries.set(entry.id, entry); };
  cache.put('state:secret', 'private', 'state'); identity = 'bob'; cache.close(); await disk.clear(); wait.resolve(); await cache.settled();
  assert.equal(disk.entries.size, 0); assert.equal(cache.peek('state:secret'), undefined);
  const other = new AccountCache('bob', disk); assert.equal(await other.get('state:secret'), undefined);
});
test('expiration and disk quota failures leave the chat usable with bounded memory', async () => {
  let now = 100; const disk = new Disk(), cache = new AccountCache('alice', disk, () => true, () => now);
  disk.write = async () => { throw new Error('QuotaExceededError'); };
  cache.put('state:chat', { text: 'still visible' }, 'state'); await cache.settled();
  assert.deepEqual(cache.peek('state:chat'), { text: 'still visible' });
  now += cacheLimits.ttl + 1; assert.equal(cache.peek('state:chat'), undefined);
  cache.put('state:too-big', 'x'.repeat(cacheLimits.stateBytes + 1), 'state'); assert.equal(cache.peek('state:too-big'), undefined);
  for (let index = 0; index < 80; index++) cache.put(`state:${index}`, 'x'.repeat(1024*1024), 'state');
  assert.equal(cache.peek('state:0'), undefined); assert.equal(cache.peek('state:79').length, 1024*1024);
  await cache.settled();
});
test('disk eviction keeps recent entries and enforces text, image, age and total-size limits', () => {
  const make = (id, kind, bytes, touched = id) => ({ id: String(id), owner: 'alice', key: String(id), kind, bytes, expires: 99999, touched });
  const states = Array.from({ length: 45 }, (_, index) => make(index, 'state', 100));
  assert.deepEqual(cacheEvictions(states, 1), ['4','3','2','1','0']);
  const images = Array.from({ length: 20 }, (_, index) => make(index, 'image', 16*1024*1024));
  assert.equal(cacheEvictions(images, 1).length, 12);
  assert.equal(cacheEvictions([make(1, 'state', 8*1024*1024), make(2, 'state', 8*1024*1024)], 1).length, 1);
  assert.deepEqual(cacheEvictions([{ ...make(1, 'image', 1), expires: 1 }], 2), ['1']);
});
test('revoking the scope releases local object URLs and prevents reading cached identity data', () => {
  const cache = new AccountCache('alice', new Disk()); let released = false;
  cache.onClose(() => { released = true; }); cache.put('selection', 'chat', 'selection'); cache.close();
  assert.equal(released, true); assert.equal(cache.valid(), false); assert.equal(cache.peek('selection'), undefined);
});
