import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { test } from 'node:test';
import { RuntimeCacheMaintenance } from '../dist/runtimeCacheMaintenance.js';

test('failed foreground maintenance releases every waiting operation without overlapping it', async () => {
  const held = Promise.withResolvers();
  const order = [];
  const cache = new RuntimeCacheMaintenance({
    idle: () => true,
    collect: async () => ({ errors: [] }),
    settled: () => order.push('released'),
  });
  const first = cache.run(async () => { order.push('first'); await held.promise; });
  const rejected = assert.rejects(first, /read failed/);
  const receipt = cache.active;
  const second = cache.run(async () => { order.push('second'); return 'saved'; });
  assert.deepEqual(order, ['first']);
  assert.equal(cache.background, false);
  held.reject(Error('read failed'));
  await receipt;
  await rejected;
  assert.equal(await second, 'saved');
  assert.deepEqual(order, ['first', 'released', 'second', 'released']);
  assert.equal(cache.active, undefined);
});

test('interrupted background collection can retry, and shutdown stops its timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const attempts = [];
  const cache = new RuntimeCacheMaintenance({
    idle: () => true,
    collect: signal => {
      attempts.push(signal);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    settled: () => {},
  });
  cache.start();
  context.mock.timers.tick(60_000);
  assert.equal(attempts.length, 1);
  assert.equal(cache.background, true);
  const first = cache.active;
  const finishForeground = Promise.withResolvers();
  const foreground = cache.run(() => finishForeground.promise);
  cache.interruptBackground();
  await first;
  await flush();
  assert.equal(cache.background, false);
  assert.ok(cache.active);
  cache.interruptBackground();
  finishForeground.resolve();
  await foreground;
  context.mock.timers.tick(1_000);
  assert.equal(attempts.length, 2);
  cache.stop();
  assert.equal(attempts[1].aborted, true);
  await cache.active;
  await flush();
  context.mock.timers.tick(2 * 60 * 60_000);
  assert.equal(attempts.length, 2);
});
