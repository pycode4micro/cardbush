// Local, synthetic load test using real Git worktrees and the production manager.
// Build Runtime first. No model calls, user repositories, or production storage.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { TaskWorkspaceManager } from '../packages/bush-runtime/dist/taskWorkspace.js';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a value`);
  return args[index + 1];
};
const options = {
  files: option('--files', '1000,10000').split(',').map(Number),
  turns: Number(option('--turns', '4')),
  bytes: Number(option('--bytes', '2048')),
  changes: Number(option('--changes', '5')),
  output: resolve(option('--output', join(project, 'tmp', 'workspace-benchmark', `${Date.now()}.json`))),
};
const knownOptions = new Set(['--files', '--turns', '--bytes', '--changes', '--output']);
for (let i = 0; i < args.length; i += 2) assert.ok(knownOptions.has(args[i]), `Unknown option: ${args[i]}`);
assert.ok(options.files.length && options.files.every(value => Number.isInteger(value) && value >= 10 && value <= 50_000));
assert.ok(Number.isInteger(options.turns) && options.turns >= 1 && options.turns <= 100);
assert.ok(Number.isInteger(options.bytes) && options.bytes >= 128 && options.bytes <= 1024 * 1024);
assert.ok(Number.isInteger(options.changes) && options.changes >= 1 && options.files.every(count => options.changes < count));

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rounded = value => +value.toFixed(2);
const report = {
  schema: 'cardbush.workspace_benchmark.v2', startedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, release: release(), arch: process.arch, cpu: cpus()[0]?.model },
  options,
  runtime: {
    sourceSha256: sha(await readFile(join(project, 'packages/bush-runtime/src/taskWorkspace.ts'))),
    artifactSha256: sha(await readFile(join(project, 'packages/bush-runtime/dist/taskWorkspace.js'))),
    gitStoreSourceSha256: sha(await readFile(join(project, 'packages/bush-runtime/src/gitWorkspaceStore.ts'))),
  },
  methodology: [
    'Synthetic files, real Git repository and worktree, production TaskWorkspaceManager; no model calls.',
    'Every 257th file is 128 KiB; every 10th file contains binary bytes. Other files use --bytes.',
    'Repeated four-turn cycle: new bytes, original bytes, new bytes, no edit. Only --changes paths change.',
    'Live and history-only reviews are measured separately. No-op and repeated reads must add no Git blobs or trees.',
    'Storage counts additional Git objects above the fixture baseline using uncompressed object sizes, plus state.json bytes; this differs from the v1 custom-store disk accounting.',
    'Fixture creation, assertions, and inventories are excluded from operation timings.',
    'Runs are sequential, without OS cache flushing. Sample counts are descriptive, not universal latency guarantees.',
    'Reopening the manager verifies durable reads; this benchmark does not simulate a process kill or power failure.',
  ],
  scenarios: [],
};
await mkdir(dirname(options.output), { recursive: true });
async function persist() { await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`); }

async function pool(items, action, concurrency = 16) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; await action(items[index], index); }
  }));
  const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
  if (errors.length) throw new AggregateError(errors, 'Fixture operation failed');
}
async function git(root, ...command) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  return (await exec('git', ['-c', 'commit.gpgsign=false', '-C', root, ...command], {
    windowsHide: true, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300_000,
  })).stdout;
}
function filePath(index) {
  return `src/group-${Math.floor(index / 100)}/part-${Math.floor(index / 10) % 10}/file-${String(index).padStart(5, '0')}.dat`;
}
function content(index, version = 'baseline') {
  const bytes = Buffer.alloc(index % 257 === 256 ? 128 * 1024 : options.bytes, index % 10 === 0 ? 0 : 120);
  bytes.write(`fixture=${index};version=${version}\r\n`, 0, 'utf8');
  return bytes;
}
async function objects(source) {
  const result = { blobs: { files: 0, bytes: 0 }, snapshots: { files: 0, bytes: 0 } };
  const rows = (await git(source, 'cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)')).trim().split('\n');
  for (const row of rows) {
    const [type, size] = row.split(' ');
    const target = type === 'blob' ? result.blobs : type === 'tree' ? result.snapshots : undefined;
    if (target) { target.files++; target.bytes += Number(size); }
  }
  return result;
}
async function stored(storage, source, originalObjects) {
  const current = await objects(source);
  const subtract = (name) => ({ files: current[name].files - originalObjects[name].files, bytes: current[name].bytes - originalObjects[name].bytes });
  const blobs = subtract('blobs');
  const snapshots = subtract('snapshots');
  const tasks = await readdir(join(storage, 'tasks'));
  let stateBytes = 0;
  for (const task of tasks) stateBytes += (await lstat(join(storage, 'tasks', task, 'state.json'))).size;
  return { blobs, snapshots, stateBytes, historyBytes: blobs.bytes + snapshots.bytes + stateBytes };
}
async function assertFiles(root, expected) {
  await pool([...expected], async ([path, bytes]) => assert.deepEqual(await readFile(join(root, path)), bytes, path));
}
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: rounded((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: rounded(sorted.at(-1)) };
}

async function scenario(fileCount) {
  // All mutation and cleanup stay inside this freshly created, canonical fixture.
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'cardbush-workspace-benchmark-'));
  const source = join(root, 'source'), storage = join(root, 'runtime');
  const result = { generatedFiles: fileCount, operations: [], rounds: [], storage: [], assertions: [] };
  report.scenarios.push(result);
  let memoryTimer;
  let originalObjects;
  let sampledRssBytes = 0;
  async function timed(name, run, turn) {
    console.log(JSON.stringify({ files: fileCount, phase: name, turn, event: 'start' }));
    const start = performance.now();
    const value = await run();
    const elapsedMs = rounded(performance.now() - start);
    result.operations.push({ name, ...(turn === undefined ? {} : { turn }), elapsedMs });
    console.log(JSON.stringify({ files: fileCount, phase: name, turn, elapsedMs }));
    return value;
  }
  async function measureStorage(label) {
    const value = { label, ...await stored(storage, source, originalObjects) };
    result.storage.push(value);
    return value;
  }
  try {
    console.log(JSON.stringify({ files: fileCount, phase: 'prepare_fixture' }));
    await mkdir(source);
    await mkdir(join(root, 'empty-hooks'));
    await git(source, 'init', '-q');
    await git(source, 'config', 'user.name', 'Workspace benchmark');
    await git(source, 'config', 'user.email', 'benchmark@example.invalid');
    await git(source, 'config', 'core.autocrlf', 'false');
    await git(source, 'config', 'core.hooksPath', join(root, 'empty-hooks'));
    const baseline = new Map([['.gitignore', Buffer.from('ignored/\n')]]);
    await pool(Array.from({ length: fileCount }, (_, index) => index), async index => {
      const path = filePath(index), bytes = content(index);
      baseline.set(path, bytes);
      await mkdir(dirname(join(source, path)), { recursive: true });
      await writeFile(join(source, path), bytes);
    });
    await writeFile(join(source, '.gitignore'), baseline.get('.gitignore'));
    await timed('fixture-add', () => git(source, 'add', '.'));
    await timed('fixture-commit', () => git(source, 'commit', '-qm', 'Synthetic benchmark fixture'));
    baseline.set(filePath(fileCount - 1), content(fileCount - 1, 'dirty-at-start'));
    await writeFile(join(source, filePath(fileCount - 1)), baseline.get(filePath(fileCount - 1)));
    baseline.set('notes.txt', Buffer.from('untracked at task creation\n'));
    await writeFile(join(source, 'notes.txt'), baseline.get('notes.txt'));
    await mkdir(join(source, 'ignored'));
    await writeFile(join(source, 'ignored', 'cache.bin'), Buffer.alloc(1024 * 1024));
    const sourceIndex = await readFile(join(source, '.git', 'index'));
    originalObjects = await objects(source);
    result.coveredFiles = baseline.size;
    result.sourceBytes = [...baseline.values()].reduce((sum, bytes) => sum + bytes.length, 0);
    const expected = new Map(baseline);
    global.gc?.();
    memoryTimer = setInterval(() => { sampledRssBytes = Math.max(sampledRssBytes, process.memoryUsage().rss); }, 50);
    memoryTimer.unref();
    let manager = new TaskWorkspaceManager(storage);
    const workspace = await timed('create', () => manager.create('task', source, 'worktree'));
    await assertFiles(workspace.workspaceDir, baseline);
    await assert.rejects(readFile(join(workspace.workspaceDir, 'ignored', 'cache.bin')), { code: 'ENOENT' });
    result.assertions.push('Initial dirty and untracked bytes preserved; ignored cache omitted.');
    const initial = await measureStorage('created');
    let previous = initial;
    let review = await timed('review', () => manager.review('task'), 0);
    assert.equal(review.error, undefined);
    assert.equal(review.changes.length, 0);
    const turnIds = [];
    for (let turn = 1; turn <= options.turns; turn++) {
      const turnId = `turn-${turn}`;
      turnIds.push(turnId);
      const kind = turn % 4 === 0 ? 'noop' : turn % 4 === 2 ? 'baseline' : 'new';
      await timed('begin', () => manager.beginTurn('task', turnId), turn);
      if (kind !== 'noop') {
        await pool(Array.from({ length: options.changes }, (_, index) => index), async index => {
          const bytes = kind === 'baseline' ? baseline.get(filePath(index)) : content(index, turnId);
          expected.set(filePath(index), bytes);
          await writeFile(join(workspace.workspaceDir, filePath(index)), bytes);
        });
      }
      await timed('finish', () => manager.finishTurn('task', turnId), turn);
      review = await timed('review', () => manager.review('task'), turn);
      const history = await timed('history', () => manager.review('task', 'history'), turn);
      assert.deepEqual(history.checkpoints, review.checkpoints);
      assert.equal(history.snapshotId, undefined);
      assert.equal(review.error, undefined);
      assert.equal(review.checkpoints.length, turn);
      assert.equal(review.checkpoints.at(-1).status, 'complete');
      assert.equal(review.checkpoints.at(-1).changes.length, kind === 'noop' ? 0 : options.changes);
      const storageNow = await measureStorage(`turn-${turn}-${kind}`);
      if (kind === 'new') assert.equal(storageNow.blobs.files - previous.blobs.files, options.changes);
      else {
        assert.deepEqual(storageNow.blobs, previous.blobs);
        assert.deepEqual(storageNow.snapshots, previous.snapshots);
      }
      result.rounds.push({ turn, kind });
      previous = storageNow;
      await persist();
    }
    result.assertions.push('Every checkpoint matched the changed paths; no-op turns and reused bytes added no blobs or manifests.');
    // Restore any last-round baseline so apply actually exercises a changed destination.
    if (!review.changes.length) {
      const path = filePath(0), bytes = content(0, 'outside-turn-final');
      expected.set(path, bytes);
      await writeFile(join(workspace.workspaceDir, path), bytes);
      review = await timed('review-final-external-edit', () => manager.review('task'));
      assert.equal(review.error, undefined);
    }
    await assertFiles(source, baseline);
    await assertFiles(workspace.workspaceDir, expected);
    result.assertions.push('Source remained unchanged through all turns and reviews.');
    // This is a new manager instance, not an OS process crash.
    manager = new TaskWorkspaceManager(storage);
    review = await timed('review-reopened', () => manager.review('task'));
    assert.equal(review.error, undefined);
    const beforeReads = await measureStorage('before-repeat-reviews');
    for (let index = 0; index < 3; index++) {
      const again = await timed('review-repeat', () => manager.review('task'), index);
      assert.deepEqual(again, review);
    }
    assert.deepEqual(await stored(storage, source, originalObjects), {
      blobs: beforeReads.blobs, snapshots: beforeReads.snapshots,
      stateBytes: beforeReads.stateBytes, historyBytes: beforeReads.historyBytes,
    });
    result.assertions.push('Reopened review matched durable history; repeated reviews did not grow storage.');
    await timed('apply', () => manager.update('task', review.workspace.revision, 'apply', review.snapshotId));
    await assertFiles(source, expected);
    assert.deepEqual(await readFile(join(source, '.git', 'index')), sourceIndex);
    result.assertions.push('Apply reproduced exact bytes while preserving the source Git index.');
    // Undo the optional external edit first; it deliberately does not belong to a Turn.
    if (options.turns % 4 === 2) {
      await writeFile(join(workspace.workspaceDir, filePath(0)), baseline.get(filePath(0)));
    }
    await timed('revert-all', () => manager.revert('task', [...turnIds].reverse()));
    await assertFiles(workspace.workspaceDir, baseline);
    await assertFiles(source, expected);
    result.assertions.push('Reverse-order rollback restored every baseline byte without silently changing applied source files.');
    review = await timed('review-reverted', () => manager.review('task'));
    assert.equal(review.error, undefined);
    assert.ok(review.checkpoints.every(checkpoint => checkpoint.status === 'reverted'));
    await timed('discard', () => manager.update('task', review.workspace.revision, 'discard', review.snapshotId));
    await assertFiles(source, expected);
    await assert.rejects(lstat(workspace.workspaceDir), { code: 'ENOENT' });
    await measureStorage('discarded');
    result.assertions.push('Discard removed the owned checkout and preserved source; retained history size measured separately.');
    result.latency = Object.fromEntries(['begin', 'finish', 'review', 'review-repeat', 'history'].map(name => [name,
      stats(result.operations.filter(item => item.name === name).map(item => item.elapsedMs))]));
    result.sampledRssBytes = sampledRssBytes;
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = { message: error.message, stack: error.stack };
    throw error;
  } finally {
    clearInterval(memoryTimer);
    await persist();
    const delta = relative(tempRoot, root);
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta) && dirname(root) === tempRoot);
    assert.ok(basename(root).startsWith('cardbush-workspace-benchmark-'));
    assert.equal(await realpath(root), root);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

try {
  for (const count of options.files) await scenario(count);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
  console.log(JSON.stringify({ status: report.status, report: options.output }));
}
