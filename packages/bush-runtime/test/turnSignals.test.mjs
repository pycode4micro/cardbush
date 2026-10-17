import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeTurnSignals } from '../dist/turnSignals.js';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';
import { ToolRegistry } from '../dist/index.js';

test('child/task observers and room observers share signals without crossing session or turn boundaries', async () => {
  const signals = new RuntimeTurnSignals();
  const background = new BackgroundToolCalls(new ToolRegistry(), () => {}, undefined, undefined, undefined, signals);
  const work = Promise.withResolvers();
  const child = background.waitForWork('s', 't', [work.promise], 'all');
  const room = signals.wait('s', 't', [new Promise(() => {})], 'any');
  const other = signals.wait('s', 'other', [work.promise], 'any');
  signals.wake('s', 't', 'peer_message');
  assert.equal(await child, 'peer_message'); assert.equal(await room, 'peer_message');
  work.resolve(); assert.equal(await other, 'task_completed');
});

test('pending notices are typed and later rejection remains observed after an early wake', async () => {
  const deferred = Promise.withResolvers();
  const signals = new RuntimeTurnSignals(() => 'peer_message');
  assert.equal(await signals.wait('s', 't', [deferred.promise], 'any'), 'peer_message');
  deferred.reject(Error('late task failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('cancellation, timeout and end of turn stop observers without cancelling the underlying task', async () => {
  const signals = new RuntimeTurnSignals(), work = Promise.withResolvers(), controller = new AbortController();
  const waiting = signals.wait('s', 't', [work.promise], 'all', controller.signal);
  controller.abort(); await assert.rejects(waiting, /abort/i);
  assert.equal(await signals.wait('s', 't', [work.promise], 'any', undefined, 0), 'yield_timeout');
  const ending = signals.wait('s', 't', [work.promise], 'any');
  signals.endTurn('s', 't'); assert.equal(await ending, 'turn_ended');
  work.resolve('still completed'); assert.equal(await work.promise, 'still completed');
});

test('all waits require all observed results unless a distinct notice interrupts', async () => {
  const signals = new RuntimeTurnSignals(), first = Promise.withResolvers(), second = Promise.withResolvers();
  let completed = false;
  const waiting = signals.wait('s', 't', [first.promise, second.promise], 'all').then(reason => { completed = true; return reason; });
  first.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
  second.resolve(); assert.equal(await waiting, 'task_completed');
});
