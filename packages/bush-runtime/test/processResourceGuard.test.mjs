import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { defaultProcessResourceLimits, ProcessResourceGovernor, spawnResourceManagedProcess, TerminalSessionManager } from '../dist/index.js';

const MiB = 1024 ** 2;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cardbush-resource-test-'));
const fixture = join(fixtureRoot, 'resource worker.exe');
const defaults = defaultProcessResourceLimits(8 * 1024 ** 3);
const governor = overrides => new ProcessResourceGovernor({
  limits: { ...defaults, taskMemoryBytes: 256 * MiB, totalMemoryBytes: 512 * MiB, ...overrides },
  availableMemory: () => 4 * 1024 ** 3,
});

if (process.platform === 'win32') {
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const result = spawnSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', `/out:${fixture}`,
    join(root, 'packages/bush-runtime/test/fixtures/ResourceWorker.cs')], { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
after(() => {
  const target = resolve(fixtureRoot);
  assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
  assert.match(target, /cardbush-resource-test-/);
  rmSync(target, { recursive: true, force: true });
});

test('budgets scale with host RAM and admission is shared, bounded and released once', () => {
  assert.equal(defaults.taskMemoryBytes, 2 * 1024 ** 3);
  assert.equal(defaults.totalMemoryBytes, 4 * 1024 ** 3);
  const budget = governor({ maxConcurrentTasks: 2 });
  const first = budget.acquire(), second = budget.acquire();
  assert.throws(() => budget.acquire(), { code: 'resource_capacity_busy' });
  first.release(); first.release();
  const third = budget.acquire();
  assert.throws(() => budget.acquire(), { code: 'resource_capacity_busy' });
  second.release(); third.release();
  const pressure = new ProcessResourceGovernor({ limits: defaults, availableMemory: () => 64 * MiB });
  assert.throws(() => pressure.acquire(), { code: 'resource_memory_pressure' });
});

test('shared budget reserves currently available RAM and refreshes after work finishes', () => {
  let free = 2 * 1024 ** 3;
  const budget = new ProcessResourceGovernor({ limits: defaults, availableMemory: () => free });
  const first = budget.acquire();
  assert.equal(first.totalMemoryBytes, free - defaults.memoryReserveBytes);
  free = 6 * 1024 ** 3;
  const second = budget.acquire();
  assert.equal(second.totalMemoryBytes, first.totalMemoryBytes);
  first.release(); second.release();
  const fresh = budget.acquire();
  assert.equal(fresh.totalMemoryBytes, defaults.totalMemoryBytes);
  fresh.release();
});

test('process resource host is built and included outside asar', { skip: process.platform !== 'win32' }, () => {
  const packaging = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(packaging, /from: dist-native\/process-guard/);
  assert.match(packaging, /to: process-guard/);
  const { fileName } = JSON.parse(readFileSync(join(root, 'dist-native/process-guard/current.json'), 'utf8'));
  assert.match(fileName, /^CardBushProcessHost-[a-f0-9]{16}\.exe$/);
  assert.ok(existsSync(join(root, 'dist-native/process-guard', fileName)));
});

async function start(t, args, budget = governor()) {
  const managed = await spawnResourceManagedProcess({ executable: fixture, args, cwd: fixtureRoot, governor: budget });
  let stdout = '', stderr = '';
  managed.child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
  managed.child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const done = once(managed.child, 'close').then(async ([exitCode]) => ({ exitCode, report: await managed.complete(), stdout, stderr }));
  t.after(async () => {
    if (managed.child.exitCode === null && managed.child.signalCode === null) managed.child.kill();
    await done;
  });
  return { ...managed, done, stdout: () => stdout };
}
async function ready(task) {
  const deadline = Date.now() + 5000;
  while (!task.stdout().includes('ready=') && Date.now() < deadline && task.child.exitCode === null) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.match(task.stdout(), /ready=/);
}
async function assertGone(pid) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Managed child ${pid} is still alive.`);
}

const native = { skip: process.platform !== 'win32', timeout: 15000 };

test('native host preserves Unicode/quotes/empty args, stdin and exact exit codes', native, async t => {
  const args = ['echo', '中文😀', 'path with space\\', 'a"b', '', 'line\nnext'];
  const task = await start(t, args);
  const result = await task.done;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stdout.trimEnd(), args.slice(1).join('|'));
  assert.equal(result.report.code, '');
  const stdin = await start(t, ['stdin']);
  stdin.child.stdin.write('hello 中文\n');
  assert.match((await stdin.done).stdout, /hello 中文/);
  const nonzero = await start(t, ['exit', '7']);
  assert.equal((await nonzero.done).exitCode, 7);
});

test('task memory is capped before an eager allocation can exhaust the host', native, async t => {
  const task = await start(t, ['allocate'], governor({ taskMemoryBytes: 128 * MiB }));
  const result = await task.done;
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.report.code, 'resource_memory_limit', JSON.stringify(result));
  // Windows' peak job accounting can include the rejected allocation attempt.
  // Assert successful committed/touched allocations, not that accounting peak.
  const committed = [...result.stdout.matchAll(/committed=(\d+)/g)].map(match => Number(match[1]));
  assert.ok(committed.length > 0);
  assert.ok(Math.max(...committed) < 128 * MiB, JSON.stringify(result));
  assert.ok(result.stdout.includes('allocation-denied') || result.report.code === 'resource_memory_limit');
  assert.doesNotMatch(result.stdout, /allocation-finished/);
});

test('simultaneous tasks share the native memory budget across separate launches', native, async t => {
  const budget = governor({ taskMemoryBytes: 160 * MiB, totalMemoryBytes: 160 * MiB });
  const first = await start(t, ['hold-memory', '6'], budget);
  await ready(first);
  const second = await start(t, ['hold-memory', '6'], budget);
  const failed = await second.done;
  assert.notEqual(failed.exitCode, 0, JSON.stringify(failed));
  assert.ok(failed.report.code === 'resource_memory_limit' || failed.stdout.includes('allocation-denied'), JSON.stringify(failed));
  assert.equal(first.child.exitCode, null, 'another task must remain alive');
  const short = await start(t, ['echo', 'still-responsive'], budget);
  assert.equal((await short.done).stdout.trim(), 'still-responsive');
});

test('child process count is enforced and orphan descendants are cleaned up', native, async t => {
  const task = await start(t, ['children'], governor({ taskProcessLimit: 3 }));
  const result = await task.done;
  assert.equal(result.report.code, 'resource_process_limit', JSON.stringify(result));
  for (const match of result.stdout.matchAll(/child=(\d+)/g)) await assertGone(Number(match[1]));
  const orphan = await start(t, ['orphan']);
  const orphanResult = await orphan.done;
  assert.equal(orphanResult.exitCode, 0, JSON.stringify(orphanResult));
  const pid = Number(orphanResult.stdout.match(/child=(\d+)/)?.[1]);
  assert.ok(pid > 0);
  await assertGone(pid);
});

test('stopping the supervisor kills its task even without cooperative cancellation', native, async t => {
  const task = await start(t, ['hold']);
  await ready(task);
  const pid = Number(task.stdout().match(/ready=(\d+)/)[1]);
  task.child.kill();
  await task.done;
  await assertGone(pid);
});

test('exiting a Runtime parent cleans up its managed work automatically', native, async t => {
  const intermediary = join(fixtureRoot, 'parent.mjs');
  const moduleUrl = pathToFileURL(join(root, 'packages/bush-runtime/dist/processResourceGuard.js')).href;
  writeFileSync(intermediary, `
import { spawnResourceManagedProcess } from ${JSON.stringify(moduleUrl)};
const task = await spawnResourceManagedProcess({ executable: process.argv[2], args: ['hold'], cwd: process.cwd() });
task.child.stdout.on('data', chunk => {
  process.stdout.write(chunk, () => { if (chunk.toString().includes('ready=')) process.exit(0); });
});
task.child.stderr.resume();
`);
  const parent = spawn(process.execPath, [intermediary, fixture], { cwd: fixtureRoot, windowsHide: true, stdio: 'pipe' });
  let stdout = '';
  parent.stdout.on('data', chunk => { stdout += chunk; });
  parent.stderr.resume();
  const closed = once(parent, 'close');
  t.after(() => { if (parent.exitCode === null) parent.kill(); });
  assert.equal((await closed)[0], 0);
  const pid = Number(stdout.match(/ready=(\d+)/)?.[1]);
  assert.ok(pid > 0, stdout);
  await assertGone(pid);
});

test('CPU hard cap limits a saturated worker without polling from the runtime', native, async t => {
  const task = await start(t, ['cpu'], governor({ cpuPercent: 10 }));
  const result = await task.done;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  const cpuMs = Number(result.stdout.match(/cpuMs=([\d.]+)/)[1]);
  const cores = Number(result.stdout.match(/cores=(\d+)/)[1]);
  assert.ok(cpuMs < 2000 * cores * 0.3, `CPU budget did not apply: ${cpuMs} ms across ${cores} cores`);
});

test('disk pressure stops a writer using a small controlled test file', native, async t => {
  const stat = statfsSync(fixtureRoot);
  const budget = governor({ diskReserveBytes: Math.floor(stat.bavail * stat.bsize + 128 * MiB) });
  const task = await start(t, ['write', join(fixtureRoot, 'pressure.bin')], budget);
  const result = await task.done;
  assert.equal(result.report.code, 'resource_disk_pressure', JSON.stringify(result));
});

test('terminal managers share admission and expose resource failures to the agent', native, async t => {
  const budget = governor({ maxConcurrentTasks: 1, taskMemoryBytes: 192 * MiB });
  const first = new TerminalSessionManager({ resourceGovernor: budget });
  const second = new TerminalSessionManager({ resourceGovernor: budget });
  const input = { ownerSessionId: 'one', command: `& '${fixture}' hold`, cwd: fixtureRoot, yieldTimeMs: 100, shell: 'powershell' };
  const running = await first.start(input);
  t.after(async () => { if (first.list('one').length) await first.stop('one', running.terminalSessionId); });
  await assert.rejects(second.start({ ...input, ownerSessionId: 'two' }), { code: 'resource_capacity_busy' });
  const stopped = await first.stop('one', running.terminalSessionId);
  assert.equal(stopped.state, 'stopped');
  let allocation = await second.start({ ...input, ownerSessionId: 'two', command: `& '${fixture}' allocate`, yieldTimeMs: 1000 });
  while (allocation.state === 'running') allocation = await second.poll('two', { sessionId: allocation.terminalSessionId, yieldTimeMs: 1000 });
  assert.equal(allocation.state, 'failed', JSON.stringify(allocation));
  assert.equal(allocation.errorCode, 'resource_memory_limit');
});

test('missing native host refuses execution and releases admission', native, async () => {
  const budget = governor({ maxConcurrentTasks: 1 });
  await assert.rejects(spawnResourceManagedProcess({ executable: fixture, args: ['echo', 'unexpected'], cwd: fixtureRoot,
    governor: budget, hostPath: join(fixtureRoot, 'missing.exe') }).then(async managed => {
      await once(managed.child, 'close');
  }));
  // The asynchronous spawn error cleanup may still be completing its receipt removal.
  await new Promise(resolve => setTimeout(resolve, 50));
  budget.acquire().release();
});
