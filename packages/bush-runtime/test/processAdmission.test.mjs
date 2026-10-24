import assert from 'node:assert/strict';
import test from 'node:test';
import { once, EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { dirname } from 'node:path';
import { ProcessResourceGovernor, defaultProcessResourceLimits } from '../dist/processResourceGuard.js';
import { processExecutionDeadline } from '../dist/processExecutionDeadline.js';
import { normalizeHostEnvironment } from '../dist/hostEnvironment.js';
import { trustedGitSync } from '../dist/trustedGit.js';
import { userDirectories } from '../dist/userDirectories.js';
import { SandboxFileHandle } from '../dist/workspaceSandboxFile.js';
import { PassThrough } from 'node:stream';

test('I/O admission is FIFO, independently bounded, cancellable and shares memory limits', async () => {
  const MiB = 1024 ** 2;
  let available = 8 * 1024 ** 3;
  const governor = new ProcessResourceGovernor({ limits: { ...defaultProcessResourceLimits(), maxConcurrentTasks: 1, maxConcurrentIo: 1 }, availableMemory: () => available });
  const task = governor.acquire(), io = await governor.acquireQueued('io');
  const controller = new AbortController();
  const cancelled = governor.acquireQueued('io', controller.signal); const rejected = assert.rejects(cancelled, { name: 'AbortError' });
  let admitted = false;
  const next = governor.acquireQueued('io').then(lease => { admitted = true; return lease; });
  controller.abort(); await rejected; await Promise.resolve(); assert.equal(admitted, false);
  io.release(); const second = await next; assert.equal(admitted, true);
  assert.throws(() => governor.acquire(), { code: 'resource_capacity_busy' });
  second.release(); task.release();
  available = 32 * MiB;
  await assert.rejects(governor.acquireQueued('io'), { code: 'resource_memory_pressure' });
});

test('I/O queue has a fixed upper bound and cancellation releases every entry', async () => {
  const governor = new ProcessResourceGovernor({ limits: { ...defaultProcessResourceLimits(), maxConcurrentIo: 1 }, availableMemory: () => 8 * 1024 ** 3 });
  const io = await governor.acquireQueued('io'), controller = new AbortController();
  const queued = Array.from({ length: 256 }, () => governor.acquireQueued('io', controller.signal));
  const outcomes = Promise.allSettled(queued);
  await assert.rejects(governor.acquireQueued('io'), { code: 'resource_io_capacity_busy' });
  controller.abort(); assert.ok((await outcomes).every(result => result.status === 'rejected'));
  io.release(); (await governor.acquireQueued('io')).release();
});

test('execution timeout excludes preparation and cleanup, each phase still has a deadline', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  let phase = 'preparing_sandbox'; const failures = [];
  const cancel = processExecutionDeadline({ phase: () => phase }, 100, error => failures.push(error.code));
  t.mock.timers.tick(10_000); assert.deepEqual(failures, []);
  phase = 'executing'; t.mock.timers.tick(50); t.mock.timers.tick(50); assert.deepEqual(failures, []);
  phase = 'cleaning_up'; t.mock.timers.tick(50); t.mock.timers.tick(10_000); assert.deepEqual(failures, []);
  t.mock.timers.tick(110_000); assert.deepEqual(failures, ['sandbox_cleanup_timeout']); cancel();
  for (const [value, delay, code] of [['preparing_sandbox', 120_000, 'sandbox_setup_timeout'], ['executing', 100, 'process_timeout']]) {
    phase = value; const errors = [];
    const stop = processExecutionDeadline({ phase: () => phase }, 100, error => errors.push(error.code));
    t.mock.timers.tick(delay); assert.deepEqual(errors, [code]); stop();
  }
});

test('file worker waiting queue is bounded and aborted starts never reach file access', async () => {
  const controller = new AbortController();
  const waiting = Array.from({ length: 259 }, () => SandboxFileHandle.open('unused-path', '0:0', false, undefined, controller.signal));
  const completed = Promise.allSettled(waiting); controller.abort();
  const results = await completed;
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'resource_io_capacity_busy').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.name === 'AbortError').length, 258);
});

test('file worker cleanup has a bounded deadline and releases its local queue slot on failure', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let stopped = false, released = false;
  const done = Promise.withResolvers();
  const handle = new SandboxFileHandle({ child: Object.assign(new EventEmitter(), streams), phase: () => 'cleaning_up', stop: () => { stopped = true; }, complete: () => done.promise }, undefined, () => { released = true; });
  t.mock.method(handle, 'request', async () => ({}));
  const closed = handle.close(), rejected = assert.rejects(closed, { code: 'sandbox_cleanup_timeout' });
  await Promise.resolve(); t.mock.timers.tick(120_000); await rejected;
  assert.equal(stopped, true); assert.equal(released, true);
  done.resolve({}); for (const stream of Object.values(streams)) stream.destroy();
});

test('Windows Worker preserves case-insensitive PATH semantics and trusted absolute Git resolution', { skip: process.platform !== 'win32' }, async t => {
  const git = trustedGitSync();
  const env = normalizeHostEnvironment({ Path: 'old', PATH: dirname(git), SystemRoot: process.env.SystemRoot, cardbush_git_path: git });
  assert.equal(env.Path, env.PATH); assert.equal(env.CARDBUSH_GIT_PATH, git);
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); import(workerData).then(m=>parentPort.postMessage({git:m.trustedGitSync(),path:process.env.PATH,legacy:process.env.Path}));`,
    { eval: true, env, workerData: new URL('../dist/trustedGit.js', import.meta.url).href });
  t.after(() => worker.terminate());
  const [result] = await once(worker, 'message');
  assert.equal(result.git, git); assert.equal(result.path, result.legacy);
});

test('OS directory metadata uses the host account, creates no permissions, and honors cancellation', async () => {
  const value = await userDirectories();
  assert.equal(value.accessGranted, false); assert.equal(value.executionEnvironment.kind, 'local');
  assert.ok(value.directories.home); assert.doesNotMatch(value.directories.home, /cardbush-sandbox-/i);
  await assert.rejects(userDirectories(AbortSignal.abort()), { name: 'AbortError' });
});
