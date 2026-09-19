import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../../assets/plugins/chrome/extension/downloads.js', import.meta.url), 'utf8');
const scope = { id: 'session-a' }, other = { id: 'session-b' };

function fixture() {
  const stored = {}, items = new Map(), launches = [], listeners = [], cancellations = [];
  let resolveStart, rejectStart;
  const chrome = {
    storage: { session: { get: async () => structuredClone(stored), set: async data => Object.assign(stored, structuredClone(data)) } },
    downloads: {
      onChanged: { addListener: fn => listeners.push(fn) },
      download: options => { launches.push(options); return new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; }); },
      search: async query => [...items.values()].filter(item => query.id !== undefined ? item.id === query.id : item.filename.includes(query.filenameRegex)),
      cancel: async id => { cancellations.push(id); Object.assign(items.get(id), { state: 'interrupted', error: 'USER_CANCELED' }); },
    },
  };
  const load = () => vm.runInNewContext(source + '\ncreateDownloadManager(chrome)', { chrome, URL, crypto: { randomUUID }, structuredClone, setTimeout, clearTimeout });
  const accept = async (state = 'in_progress') => {
    const item = { id: 42, state, filename: 'C:/Downloads/' + launches[0].filename, bytesReceived: 20, totalBytes: 100 };
    items.set(42, item); resolveStart(42); await flush(); return item;
  };
  return { manager: load(), load, chrome, launches, stored, items, cancellations, accept,
    reject: async () => { rejectStart(new Error('Browser rejected download')); await flush(); },
    change: async delta => { listeners.forEach(fn => fn(delta)); await flush(); },
  };
}
const start = manager => manager.start(scope, { url: 'https://example.test/report.pdf', filename: 'report.pdf', requestKey: 'request-one' });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('pending starts are durable, deduplicated and never report a temporary path as a completed file', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([start(f.manager), start(f.manager)]);
  assert.equal(a.taskId, b.taskId); assert.equal(b.reused, true); assert.equal(a.state, 'starting');
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0].saveAs, false); assert.equal(f.launches[0].conflictAction, 'uniquify');
  await assert.rejects(f.manager.status(other, { taskId: a.taskId }), { code: 'download_task_missing' });
  const item = await f.accept(); item.filename += '.tmp';
  const pending = await f.manager.status(scope, { taskId: a.taskId });
  assert.equal(pending.state, 'in_progress'); assert.equal(pending.filename, undefined);
  const waiting = f.manager.status(scope, { taskId: a.taskId, waitMs: 1000 });
  await flush(); Object.assign(item, { state: 'complete', filename: item.filename.slice(0, -4), bytesReceived: 100 });
  await f.change({ id: item.id, state: { current: 'complete' } });
  const completed = await waiting;
  assert.equal(completed.state, 'complete'); assert.ok(completed.filename.endsWith('report.pdf'));
  assert.equal((await start(f.manager)).taskId, a.taskId); assert.equal(f.launches.length, 1);
});

test('worker restart retains ownership and request keys, including starts not yet acknowledged by Chrome', async () => {
  const f = fixture(); const a = await start(f.manager);
  const restarted = f.load();
  assert.equal((await start(restarted)).taskId, a.taskId); assert.equal(f.launches.length, 1);
  f.items.set(73, { id: 73, state: 'complete', filename: 'C:/Downloads/' + f.launches[0].filename, bytesReceived: 8, totalBytes: 8 });
  const recovered = await restarted.status(scope, { taskId: a.taskId });
  assert.equal(recovered.state, 'complete'); assert.equal(recovered.downloadId, 73);
});

test('cancellation and interrupted starts do not retry or affect another session', async () => {
  const f = fixture(); const a = await start(f.manager);
  await assert.rejects(f.manager.cancel(other, { taskId: a.taskId }), { code: 'download_task_missing' });
  assert.equal((await f.manager.cancel(scope, { taskId: a.taskId })).state, 'cancelling');
  await f.accept();
  assert.deepEqual(f.cancellations, [42]);
  assert.equal((await start(f.manager)).state, 'cancelled'); assert.equal(f.launches.length, 1);
  const broken = fixture(); await start(broken.manager); await broken.reject();
  assert.equal((await start(broken.manager)).state, 'interrupted'); assert.equal(broken.launches.length, 1);
});

test('a cancellation made before a worker restart is applied when Chrome exposes the download', async () => {
  const f = fixture(); const a = await start(f.manager);
  await f.manager.cancel(scope, { taskId: a.taskId }); await flush();
  const restarted = f.load();
  f.items.set(73, { id: 73, state: 'in_progress', filename: 'C:/Downloads/' + f.launches[0].filename, bytesReceived: 8, totalBytes: 80 });
  const recovered = await restarted.status(scope, { taskId: a.taskId });
  assert.equal(recovered.state, 'cancelled'); assert.deepEqual(f.cancellations, [73]);
  assert.equal((await start(restarted)).state, 'cancelled'); assert.equal(f.launches.length, 1);
});

test('synchronous start errors stop the task, while status errors do not mark an active download failed', async () => {
  const broken = fixture();
  broken.chrome.downloads.download = () => { throw new Error('Start rejected'); };
  await start(broken.manager); await flush();
  assert.equal((await start(broken.manager)).state, 'interrupted');
  const active = fixture(); const a = await start(active.manager);
  const search = active.chrome.downloads.search;
  active.chrome.downloads.search = async () => { throw new Error('Temporary search failure'); };
  await active.accept(); await flush();
  assert.equal(active.stored.cardbushDownloadTasks[0].state, 'in_progress');
  active.chrome.downloads.search = search;
  assert.equal((await active.manager.status(scope, { taskId: a.taskId })).state, 'in_progress');
  assert.equal(active.launches.length, 1);
});

test('download filenames cannot escape task folders and wait timeouts do not create new downloads', async () => {
  const f = fixture();
  for (const filename of ['../escape', 'C:\\escape', 'CON.txt', 'trail.', '..']) {
    await assert.rejects(f.manager.start(scope, { url: 'https://example.test/a', filename, requestKey: filename }), { code: 'download_filename_invalid' });
  }
  const a = await start(f.manager);
  assert.equal((await f.manager.status(scope, { taskId: a.taskId, waitMs: 5 })).state, 'starting');
  assert.equal(f.launches.length, 1);
});
