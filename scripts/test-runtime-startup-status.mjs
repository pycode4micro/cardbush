import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync('src/shared/useRuntimeStartupStatus.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = { exports: {}, require: createRequire(import.meta.url), Promise, Date, Error };
vm.runInNewContext(compiled, context);
const { createRuntimeStartupStatusStore } = context.exports;
const tick = () => new Promise(resolve => setImmediate(resolve));
const status = (phase, attempt = 1) => ({ phase, attempt, startedAt: '2026-10-07T00:00:00Z' });
function fixture() {
  let resolve, reject, listener, reads = 0, subscriptions = 0;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const store = createRuntimeStartupStatusStore({
    runtimeStartupStatus: () => { reads++; return pending; },
    onRuntimeStartupStatus: next => { subscriptions++; listener = next; return () => {}; },
  });
  return { store, resolve, reject, emit: next => listener(next), counts: () => ({ reads, subscriptions }) };
}

test('ready startup survives composer remounts and uses one IPC read/subscription', async () => {
  const value = fixture(), { store } = value;
  assert.equal(store.getSnapshot().phase, 'initializing');
  const unsubscribe = store.subscribe(() => {});
  store.subscribe(() => {});
  value.resolve(status('ready')); await tick();
  const ready = store.getSnapshot(); unsubscribe();
  for (let index = 0; index < 30; index++) {
    assert.equal(store.getSnapshot(), ready, 'first render of the next conversation stays ready');
    store.subscribe(() => {})();
  }
  assert.deepEqual(value.counts(), { reads: 1, subscriptions: 1 });
});

test('actual restart and failure remain visible across periods without a composer', async () => {
  const value = fixture(), { store } = value;
  const stop = store.subscribe(() => {});
  value.resolve(status('ready')); await tick(); stop();
  value.emit(status('initializing', 2));
  assert.equal(store.getSnapshot().phase, 'initializing');
  value.emit({ ...status('error', 2), error: 'Runtime failed' });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  assert.equal(store.getSnapshot().error, 'Runtime failed');
  value.emit(status('initializing', 3)); value.emit(status('ready', 3));
  assert.equal(store.getSnapshot().attempt, 3);
  assert.equal(notifications, 2);
  assert.deepEqual(value.counts(), { reads: 1, subscriptions: 1 }); unsubscribe();
});

test('a late initial query cannot overwrite a newer ready or restarting event', async () => {
  for (const phase of ['ready', 'initializing', 'error']) {
    const value = fixture(); value.store.subscribe(() => {});
    const next = status(phase, 2); value.emit(next);
    value.resolve(status('initializing')); await tick();
    assert.equal(value.store.getSnapshot(), next);
  }
});

test('query failure is reported only if no newer startup event has arrived', async () => {
  const first = fixture(); first.store.subscribe(() => {});
  first.reject(new Error('IPC unavailable')); await tick();
  assert.equal(first.store.getSnapshot().phase, 'error');
  assert.equal(first.store.getSnapshot().error, 'IPC unavailable');
  const newer = fixture(); newer.store.subscribe(() => {});
  newer.emit(status('ready', 2)); newer.reject(new Error('stale IPC failure')); await tick();
  assert.equal(newer.store.getSnapshot().phase, 'ready');
});

test('non-desktop previews have a stable ready snapshot', () => {
  const store = createRuntimeStartupStatusStore(), ready = store.getSnapshot();
  store.subscribe(() => {})();
  assert.equal(ready.phase, 'ready'); assert.equal(store.getSnapshot(), ready);
});
