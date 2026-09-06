import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, lstat, utimes, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import test from 'node:test';
import { TaskWorkspaceManager, InMemoryRuntimeHost } from '../dist/index.js';
import { CREATE_RUNTIME_SESSION_COMMAND, GET_RUNTIME_WORKSPACE_COMMAND, UPDATE_RUNTIME_WORKSPACE_COMMAND,
  GET_RUNTIME_SESSION_COMMAND, UPDATE_RUNTIME_SESSION_METADATA_COMMAND, DELETE_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND, REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND } from '@cardbush/bush-protocol';

function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { windowsHide: true, encoding: 'utf8' }); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-worktrees-'));
  t.after(async () => {
    const delta = relative(tmpdir(), root);
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const source = join(root, 'source'), storage = join(root, 'runtime');
  await mkdir(source);
  git(source, 'init', '-q');
  git(source, 'config', 'user.name', 'Fixture');
  git(source, 'config', 'user.email', 'fixture@example.invalid');
  git(source, 'config', 'core.autocrlf', 'false');
  await writeFile(join(source, '.gitignore'), 'ignored/\n');
  await writeFile(join(source, 'file.txt'), 'committed\r\n');
  await writeFile(join(source, 'empty.txt'), '');
  await writeFile(join(source, '__proto__'), 'literal filename');
  await writeFile(join(source, 'binary.bin'), Buffer.from([0, 1, 255, 13, 10]));
  git(source, 'add', '.');
  git(source, 'commit', '-qm', 'fixture');
  return { root, source, storage, manager: new TaskWorkspaceManager(storage) };
}
async function action(manager, action, sessionId = 'task') {
  const review = await manager.review(sessionId);
  return manager.update(sessionId, review.workspace.revision, action, review.snapshotId);
}

test('task copy preserves working bytes and dirty/untracked baseline without touching source index', async t => {
  const { source, manager } = await fixture(t);
  await writeFile(join(source, 'file.txt'), 'staged');
  git(source, 'add', 'file.txt');
  await writeFile(join(source, 'file.txt'), 'unstaged\r\n');
  await writeFile(join(source, 'untracked.txt'), 'not yet tracked');
  await mkdir(join(source, 'ignored'));
  await writeFile(join(source, 'ignored', 'secret'), 'not copied');
  const index = await readFile(join(source, '.git', 'index'));
  const workspace = await manager.create('task', source, 'worktree');
  assert.notEqual(workspace.workspaceDir, source);
  assert.equal(await readFile(join(workspace.workspaceDir, 'file.txt'), 'utf8'), 'unstaged\r\n');
  assert.equal(await readFile(join(workspace.workspaceDir, 'untracked.txt'), 'utf8'), 'not yet tracked');
  await assert.rejects(readFile(join(workspace.workspaceDir, 'ignored', 'secret')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(source, '.git', 'index')), index);
  assert.equal((await manager.review('task')).changes.length, 0);
});

test('checkpoints capture arbitrary processes, deletions, new files and binary bytes and survive restart', async t => {
  const { source, storage, manager } = await fixture(t);
  const workspace = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'turn-1');
  execFileSync(process.execPath, ['-e', "const fs=require('node:fs');fs.writeFileSync('file.txt','shell change');fs.unlinkSync('binary.bin');fs.writeFileSync('new.bin',Buffer.from([0,255,10]));fs.writeFileSync('empty.txt','no longer empty');fs.writeFileSync('__proto__','literal edit');fs.writeFileSync('constructor','literal new file');"], { cwd: workspace.workspaceDir, windowsHide: true });
  await manager.finishTurn('task', 'turn-1');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
  const reopened = new TaskWorkspaceManager(process.platform === 'win32' ? storage.toLowerCase() : storage);
  const review = await reopened.review('task');
  assert.equal(review.checkpoints[0].changes.length, 6);
  assert.equal(review.checkpoints[0].changes.find(change => change.path.endsWith('new.bin')).metadata.binary, true);
  const result = await reopened.revert('task', ['turn-1']);
  assert.equal(result.revertedFiles, 6);
  assert.deepEqual(await readFile(join(workspace.workspaceDir, 'binary.bin')), Buffer.from([0, 1, 255, 13, 10]));
  assert.equal((await readFile(join(workspace.workspaceDir, 'empty.txt'))).length, 0);
  await assert.rejects(readFile(join(workspace.workspaceDir, 'new.bin')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(workspace.workspaceDir, 'constructor')), { code: 'ENOENT' });
  assert.equal(await readFile(join(workspace.workspaceDir, '__proto__'), 'utf8'), 'literal filename');
  assert.equal((await reopened.revert('task', ['turn-1'])).revertedFiles, 0);
});

test('older Turn conflicts are rejected before any restore and reverse-order rollback is supported', async t => {
  const { source, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  for (const [turn, value] of [['one', 'B'], ['two', 'C']]) {
    await manager.beginTurn('task', turn);
    await writeFile(join(workspaceDir, 'file.txt'), value);
    await manager.finishTurn('task', turn);
  }
  await assert.rejects(manager.revert('task', ['one']), { code: 'workspace_revision_conflict' });
  assert.equal(await readFile(join(workspaceDir, 'file.txt'), 'utf8'), 'C');
  await manager.revert('task', ['two', 'one']);
  assert.equal(await readFile(join(workspaceDir, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('applying binds to reviewed bytes, preserves source dirty baseline and rejects destination conflicts', async t => {
  const { source, manager } = await fixture(t);
  await writeFile(join(source, 'file.txt'), 'user work');
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'user work plus agent work');
  await writeFile(join(workspaceDir, 'new.txt'), 'new');
  await manager.finishTurn('task', 'one');
  const reviewed = await manager.review('task');
  await writeFile(join(workspaceDir, 'new.txt'), 'changed after review');
  await assert.rejects(manager.update('task', reviewed.workspace.revision, 'apply', reviewed.snapshotId), { code: 'workspace_review_stale' });
  await writeFile(join(source, 'file.txt'), 'later user work');
  await assert.rejects(action(manager, 'apply'), { code: 'workspace_revision_conflict' });
  await assert.rejects(readFile(join(source, 'new.txt')), { code: 'ENOENT' });
  await writeFile(join(source, 'file.txt'), 'user work');
  await action(manager, 'apply');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'user work plus agent work');
  assert.equal((await manager.review('task')).changes.length, 0);
  await assert.rejects(manager.revert('task', ['one']), { code: 'workspace_revision_conflict' });
  assert.equal(await readFile(join(workspaceDir, 'new.txt'), 'utf8'), 'changed after review');
});

test('mode switching is explicit and a discarded copy never deletes the source', async t => {
  const { source, manager } = await fixture(t);
  await manager.create('task', source, 'worktree');
  const direct = await action(manager, 'use_direct');
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.workspaceDir, source);
  await manager.create('second', source, 'worktree');
  const discarded = await action(manager, 'discard', 'second');
  assert.equal(discarded.status, 'discarded');
  await assert.rejects(manager.beginTurn('second', 'one'), { code: 'workspace_not_ready' });
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('Runtime captures a real terminal-only Turn before publishing its terminal event without inventing Tool records', async t => {
  const { source, storage } = await fixture(t);
  let calls = 0, seenWorkspace;
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    seenWorkspace = request.metadata.workspaceDir;
    const envelope = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    if (calls++ === 0) {
      yield { ...envelope, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'shell', nameDelta: 'terminal_exec',
        argumentsDelta: JSON.stringify({ command: "node -e \"require('node:fs').writeFileSync('file.txt','external execution')\"", yield_time_ms: 10000 }) };
      yield { ...envelope, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
      return;
    }
    yield { ...envelope, sequence: 0, kind: 'text_delta', delta: 'Done.' };
    yield { ...envelope, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } } });
  const snapshot = await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', metadata: { projectDir: source }, workspace: { mode: 'worktree', sourceDir: source } } });
  assert.equal(snapshot.metadata.runtimeWorkspace.mode, 'worktree');
  const catalog = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const observed = (async () => {
    for await (const event of host.openEventStream({ sessionId: 'task', turnId: 'turn' })) {
      if (event.kind === 'turn_terminal') {
        const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
        assert.equal(review.checkpoints[0].status, 'complete');
      }
    }
  })();
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'task', turnId: 'turn', model: 'fixture', tools: catalog.filter(tool => tool.name === 'terminal_exec'), inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'change' } }] });
  await observed;
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(terminal.payload.details.workspaceCheckpointError, undefined);
  const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
  assert.equal(review.checkpoints[0].status, 'complete');
  assert.equal(review.checkpoints[0].changes.length, 1);
  const native = await host.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload: { sessionId: 'task', turnId: 'turn', toolCallId: 'shell' } });
  assert.equal(native.outcome, 'returned');
  assert.deepEqual(native.workspaceChanges, [], 'workspace checkpoints must not pretend the shell reported per-file snapshots');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
  await host.sendCommand({ kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId: 'task', turnIds: ['turn'] } });
  assert.equal(await readFile(join(seenWorkspace, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('an incomplete checkpoint remains explicit and recovery allows the next Turn after capture is repaired', async t => {
  const { source, manager, storage } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'background write');
  git(workspaceDir, 'update-index', '--add', '--cacheinfo', `160000,${git(source, 'rev-parse', 'HEAD').trim()},module`);
  await assert.rejects(manager.finishTurn('task', 'one'), { code: 'workspace_submodule_unsupported' });
  git(workspaceDir, 'update-index', '--force-remove', 'module');
  assert.equal((await manager.review('task')).checkpoints[0].status, 'failed');
  await assert.rejects(manager.beginTurn('task', 'two'), { code: 'workspace_checkpoint_pending' });
  await assert.rejects(action(manager, 'apply'), { code: 'workspace_checkpoint_pending' });
  const reopened = new TaskWorkspaceManager(storage);
  await reopened.recoverCheckpoint('task');
  await reopened.beginTurn('task', 'two');
  await reopened.finishTurn('task', 'two');
  await reopened.revert('task', ['two', 'one']);
  assert.equal(await readFile(join(workspaceDir, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('file-to-directory and directory-to-file changes restore without deleting unrelated contents', async t => {
  const { source, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await rm(join(workspaceDir, 'file.txt'));
  await mkdir(join(workspaceDir, 'file.txt', 'nested'), { recursive: true });
  await writeFile(join(workspaceDir, 'file.txt', 'nested', 'new.txt'), 'nested');
  await manager.finishTurn('task', 'one');
  await action(manager, 'apply');
  assert.equal(await readFile(join(source, 'file.txt', 'nested', 'new.txt'), 'utf8'), 'nested');
  await manager.revert('task', ['one']);
  await action(manager, 'apply');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
});

async function persisted(storage) {
  const statePath = join(storage, 'tasks', createHash('sha256').update('task').digest('hex'), 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const before = state.appliedId;
  const after = state.latestId;
  return { statePath, state, before, after };
}

test('an interrupted multi-file apply rolls back only owned bytes on restart', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'agent');
  await writeFile(join(workspaceDir, 'empty.txt'), 'agent too');
  await manager.finishTurn('task', 'one');
  const { state, statePath, before, after } = await persisted(storage);
  state.pending = { root: source, before, after, paths: ['empty.txt', 'file.txt'] };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(source, 'empty.txt'), 'agent too');
  const reopened = new TaskWorkspaceManager(storage);
  await reopened.review('task');
  assert.equal(await readFile(join(source, 'empty.txt'), 'utf8'), '');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
  assert.equal((await persisted(storage)).state.pending, undefined);
  await action(reopened, 'apply');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'agent');
});

test('crash recovery preserves external edits and a missing destination is never recreated', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'agent');
  await manager.finishTurn('task', 'one');
  const { state, statePath, before, after } = await persisted(storage);
  state.pending = { root: source, before, after, paths: ['file.txt'] };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(source, 'file.txt'), 'external');
  const reopened = new TaskWorkspaceManager(storage);
  await assert.rejects(reopened.review('task'), { code: 'workspace_recovery_conflict' });
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'external');
  await rename(source, `${source}-moved`);
  await assert.rejects(reopened.review('task'), { code: 'workspace_destination_changed' });
  await assert.rejects(lstat(source), { code: 'ENOENT' });
});

test('two tasks have independent copies and competing applies cannot overwrite one another', async t => {
  const { source, manager } = await fixture(t);
  for (const task of ['task', 'second']) {
    const { workspaceDir } = await manager.create(task, source, 'worktree');
    await manager.beginTurn(task, 'one');
    await writeFile(join(workspaceDir, 'file.txt'), task);
    await manager.finishTurn(task, 'one');
  }
  const results = await Promise.allSettled([action(manager, 'apply'), action(manager, 'apply', 'second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected').reason;
  assert.ok(['workspace_busy', 'workspace_revision_conflict'].includes(failure.code));
  assert.ok(['task', 'second'].includes(await readFile(join(source, 'file.txt'), 'utf8')));
  const reviews = await Promise.all([manager.review('task'), manager.review('task')]);
  assert.equal(reviews[0].snapshotId, reviews[1].snapshotId, 'concurrent UI reads serialize without spurious errors');
});

test('auto mode keeps non-Git, unborn Git and selected subdirectories in direct mode', async t => {
  const { root, source, manager } = await fixture(t);
  const ordinary = join(root, 'ordinary');
  await mkdir(ordinary);
  assert.equal((await manager.create('plain', ordinary, 'auto')).mode, 'direct');
  git(ordinary, 'init', '-q');
  assert.equal((await manager.create('unborn', ordinary, 'auto')).mode, 'direct');
  await mkdir(join(source, 'subdir'));
  assert.equal((await manager.create('subdir', join(source, 'subdir'), 'auto')).mode, 'direct');
  assert.equal((await manager.create('default', source, 'auto')).mode, 'direct');
  await assert.rejects(manager.create('not-versioned', join(root, 'ordinary'), 'worktree'), { code: 'workspace_commit_required' });
});

test('Local Git versions capture file formats and terminal edits without custom blobs or changes to branches and index', async t => {
  const { source, storage, manager } = await fixture(t);
  const index = await readFile(join(source, '.git', 'index'));
  const head = git(source, 'rev-parse', 'HEAD');
  const descriptor = await manager.create('task', source, 'direct');
  assert.equal(descriptor.mode, 'direct');
  assert.equal(descriptor.versioning, 'git');
  assert.equal(descriptor.workspaceDir, source);
  await manager.beginTurn('task', 'one');
  execFileSync(process.execPath, ['-e', "require('node:fs').writeFileSync('report.xlsx',Buffer.from([80,75,3,4,0,255]));require('node:fs').writeFileSync('file.txt','terminal');"], { cwd: source, windowsHide: true });
  await manager.finishTurn('task', 'one');
  const review = await manager.review('task');
  assert.equal(review.checkpoints[0].changes.length, 2);
  assert.equal(git(source, 'cat-file', '-t', review.snapshotId).trim(), 'tree');
  await assert.rejects(lstat(join(storage, 'blobs')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(storage, 'snapshots')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(source, '.git', 'index')), index);
  assert.equal(git(source, 'rev-parse', 'HEAD'), head);
  assert.ok(git(source, 'for-each-ref', '--format=%(refname)', 'refs/cardbush/workspaces').includes(review.snapshotId));
  await manager.revert('task', ['one']);
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
  await assert.rejects(lstat(join(source, 'report.xlsx')), { code: 'ENOENT' });
  await assert.rejects(action(manager, 'discard'), { code: 'workspace_mode_locked' });
});

test('history reads need no live files, never recover a pending write, and return immutable projections', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'after');
  await manager.finishTurn('task', 'one');
  const history = await manager.review('task', 'history');
  history.checkpoints[0].changes[0].metadata.diff = 'renderer mutation';
  const { state, statePath, before, after } = await persisted(storage);
  state.pending = { root: source, before, after, paths: ['file.txt'] };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(source, 'file.txt'), 'after');
  git(source, 'worktree', 'remove', '--force', workspaceDir);
  const again = await manager.review('task', 'history');
  assert.equal(again.snapshotId, undefined);
  assert.deepEqual(again.changes, []);
  assert.notEqual(again.checkpoints[0].changes[0].metadata.diff, 'renderer mutation');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'after', 'reading history must not restore live files');
});

test('raw Git versions bypass filters and detect same-size content changes with restored timestamps', async t => {
  const { source, manager } = await fixture(t);
  git(source, 'config', 'core.autocrlf', 'true');
  git(source, 'config', 'filter.reject.clean', 'this-command-must-not-run');
  git(source, 'config', 'filter.reject.required', 'true');
  await writeFile(join(source, '.gitattributes'), '*.txt text eol=lf\n*.bin filter=reject\n');
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  const path = join(workspaceDir, 'file.txt');
  const before = await readFile(path), stat = await lstat(path);
  await manager.beginTurn('task', 'one');
  const changed = Buffer.alloc(before.length, 88);
  changed.write('++');
  await writeFile(path, changed);
  await utimes(path, stat.atime, stat.mtime);
  await writeFile(join(workspaceDir, 'binary.bin'), Buffer.from([0,255,128,13,10]));
  await manager.finishTurn('task', 'one');
  const changes = (await manager.review('task', 'history')).checkpoints[0].changes;
  assert.equal(changes.length, 2);
  assert.equal(changes.find(change => change.path.endsWith('file.txt')).additions, 1, 'added text beginning with ++ is not a patch header');
  await manager.revert('task', ['one']);
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readFile(join(workspaceDir, 'binary.bin')), Buffer.from([0,1,255,13,10]));
});

test('ordinary directories require explicit Git initialization and unborn repositories work in Local mode', async t => {
  const { root, manager } = await fixture(t);
  const source = join(root, 'documents');
  await mkdir(source);
  await writeFile(join(source, 'notes.md'), 'original');
  const local = await manager.create('task', source, 'direct');
  assert.equal(local.versioning, 'none');
  await assert.rejects(lstat(join(source, '.git')), { code: 'ENOENT' });
  assert.equal(await manager.beginTurn('task', 'before-git'), false);
  const enabled = await manager.update('task', local.revision, 'init_git');
  assert.equal(enabled.versioning, 'git');
  assert.throws(() => git(source, 'rev-parse', '--verify', 'HEAD'));
  await manager.beginTurn('task', 'one');
  await writeFile(join(source, 'notes.md'), 'edited');
  await manager.finishTurn('task', 'one');
  await manager.revert('task', ['one']);
  assert.equal(await readFile(join(source, 'notes.md'), 'utf8'), 'original');
});

test('legacy byte checkpoints and pending restores migrate atomically into Git objects', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'legacy edit');
  await manager.finishTurn('task', 'one');
  const { state, statePath } = await persisted(storage);
  await mkdir(join(storage, 'blobs'));
  await mkdir(join(storage, 'snapshots'));
  const converted = new Map();
  const oldTree = async id => {
    if (converted.has(id)) return converted.get(id);
    const tree = Object.create(null);
    for (const row of git(source, 'ls-tree', '-rz', id).split('\0').filter(Boolean)) {
      const [mode, , oid] = row.slice(0, row.indexOf('\t')).split(' '), path = row.slice(row.indexOf('\t') + 1);
      const bytes = execFileSync('git', ['-C', source, 'cat-file', 'blob', oid], { windowsHide: true });
      const hash = createHash('sha256').update(bytes).digest('hex');
      await writeFile(join(storage, 'blobs', hash), bytes);
      tree[path] = { hash, mode: process.platform === 'win32' ? 0o666 : mode === '100755' ? 0o755 : 0o644, kind: 'file' };
    }
    const json = JSON.stringify(tree), key = createHash('sha256').update(json).digest('hex');
    await writeFile(join(storage, 'snapshots', key + '.json'), json);
    const result = { key, tree };
    converted.set(id, result);
    return result;
  };
  const before = await oldTree(state.appliedId), after = await oldTree(state.latestId);
  state.baselineId = (await oldTree(state.baselineId)).key;
  state.latestId = after.key; state.appliedId = before.key;
  for (const checkpoint of state.checkpoints) {
    checkpoint.before = (await oldTree(checkpoint.before)).key;
    checkpoint.after = (await oldTree(checkpoint.after)).key;
  }
  state.protocol = 'bush.task_workspace.v1'; delete state.versioning;
  state.pending = { root: source, before: before.tree, after: after.tree, paths: ['file.txt'] };
  const legacy = JSON.stringify(state);
  await writeFile(statePath, legacy);
  await writeFile(join(source, 'file.txt'), 'legacy edit');
  const corruptPath = join(storage, 'blobs', before.tree['file.txt'].hash);
  const original = await readFile(corruptPath);
  await writeFile(corruptPath, 'corruption');
  await assert.rejects(new TaskWorkspaceManager(storage).descriptor('task'), { code: 'workspace_journal_corrupt' });
  assert.equal(await readFile(statePath, 'utf8'), legacy, 'a failed import leaves the old references intact');
  await writeFile(corruptPath, original);
  const reopened = new TaskWorkspaceManager(storage);
  assert.equal((await reopened.descriptor('task')).versioning, 'git');
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
  assert.equal((await persisted(storage)).state.protocol, 'bush.task_workspace.v2');
  await reopened.revert('task', ['one']);
  assert.equal(await readFile(join(workspaceDir, 'file.txt'), 'utf8'), 'committed\r\n');
  assert.ok((await lstat(corruptPath)).isFile(), 'migration retains the legacy recovery data');
});

test('Git capture and review preserve model facts and Cache Chain continuity across Local Turns', async t => {
  const { source, storage } = await fixture(t);
  let calls = 0; const requests = [];
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    requests.push(structuredClone(request));
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    const step = calls++;
    if (step < 2) {
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: step ? 'write' : 'read',
        nameDelta: step ? 'write_file' : 'read_file', argumentsDelta: JSON.stringify(step ? { path: 'file.txt', content: 'tool edit' } : { path: 'file.txt' }) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
    }
  } } });
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', metadata: {}, workspace: { sourceDir: source, mode: 'direct' } } });
  const catalog = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const request = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 'task', turnId, model: 'fixture',
    tools: catalog.filter(tool => ['read_file', 'write_file'].includes(tool.name)), inputMessages: [{ messageId: 'user-' + turnId, message: { role: 'user', content: 'continue' } }] });
  assert.equal((await host.runSessionTurn(request('one'))).payload.status, 'completed');
  const getNative = () => host.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload: { sessionId: 'task', turnId: 'one', toolCallId: 'write' } });
  const native = await getNative();
  assert.equal(native.outcome, 'returned');
  assert.equal(native.workspaceChanges.length, 1);
  assert.equal(native.workspaceChanges[0].metadata.beforeContentBase64, undefined);
  for (const view of ['live', 'history']) await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task', view } });
  assert.deepEqual(await getNative(), native, 'review cannot rewrite persisted tool facts or modelText');
  assert.equal((await host.runSessionTurn(request('two'))).payload.status, 'completed');
  const observation = host.events('task', 'two').find(event => event.kind === 'cache_chain_observed');
  const at = observation.payload.breakIndex;
  assert.equal(observation.payload.frozenPrefixBreak, false, JSON.stringify({ observation: observation.payload,
    before: requests.at(-2).messages[at], after: requests.at(-1).messages[at] }));
  await host.sendCommand({ kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId: 'task', turnIds: ['two', 'one'] } });
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('Git SHA-256 repositories retain binary versions without depending on SHA-1 object names', async t => {
  const { root, manager } = await fixture(t);
  const source = join(root, 'sha256');
  await mkdir(source);
  git(source, 'init', '-q', '--object-format=sha256');
  const bytes = Buffer.from([0,255,1,13,10]);
  await writeFile(join(source, 'image.png'), bytes);
  const descriptor = await manager.create('task', source, 'direct');
  assert.equal(descriptor.baselineId.length, 64);
  await manager.beginTurn('task', 'one');
  await writeFile(join(source, 'image.png'), Buffer.from([0,128]));
  await manager.finishTurn('task', 'one');
  await manager.revert('task', ['one']);
  assert.deepEqual(await readFile(join(source, 'image.png')), bytes);
});

test('Local remains available when whole-workspace Git versions cannot support a submodule', async t => {
  const { source, manager } = await fixture(t);
  git(source, 'update-index', '--add', '--cacheinfo', `160000,${git(source, 'rev-parse', 'HEAD').trim()},module`);
  const local = await manager.create('task', source, 'direct');
  assert.equal(local.mode, 'direct');
  assert.equal(local.versioning, 'none');
  assert.match(local.versioningError, /submodules/);
  assert.equal(await manager.beginTurn('task', 'one'), false);
});

test('new Tool paths stay versioned when later ignored, and source subdirectories are never silently initialized', async t => {
  const { source, manager } = await fixture(t);
  await manager.create('task', source, 'direct');
  await manager.beginTurn('task', 'one');
  const file = join(source, 'new.txt');
  assert.equal(await manager.ownsFileVersion('task', file), true);
  await writeFile(file, 'new file');
  await writeFile(join(source, '.gitignore'), 'ignored/\nnew.txt\n');
  assert.equal(await manager.ownsFileVersion('task', file), true);
  await manager.finishTurn('task', 'one');
  assert.equal((await manager.review('task', 'history')).checkpoints[0].changes.length, 2);
  await manager.revert('task', ['one']);
  await assert.rejects(lstat(file), { code: 'ENOENT' });
  const directory = join(source, 'subdir'); await mkdir(directory);
  const child = await manager.create('child', directory, 'direct');
  await assert.rejects(manager.update('child', child.revision, 'init_git'), { code: 'workspace_repository_root_required' });
  await assert.rejects(lstat(join(directory, '.git')), { code: 'ENOENT' });
});

test('ignored Tool edits retain their own recovery and mixed coverage never reports a partial revert as success', async t => {
  const { source, storage } = await fixture(t);
  await mkdir(join(source, 'ignored'));
  await writeFile(join(source, 'ignored', 'notes.txt'), 'original');
  const actions = [
    ['read_file', { path: 'ignored/notes.txt' }], ['write_file', { path: 'ignored/notes.txt', content: 'first' }], null,
    ['read_file', { path: 'file.txt' }], ['write_file', { path: 'file.txt', content: 'tracked edit' }],
    ['read_file', { path: 'ignored/notes.txt' }], ['write_file', { path: 'ignored/notes.txt', content: 'second' }], null,
  ];
  let index = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    const ordinal = index++, action = actions[ordinal];
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    if (action) {
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'call-' + ordinal, nameDelta: action[0], argumentsDelta: JSON.stringify(action[1]) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
    } else {
      yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Done.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
    }
  } } });
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', metadata: {}, workspace: { sourceDir: source, mode: 'direct' } } });
  const catalog = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const request = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 'task', turnId, model: 'fixture',
    tools: catalog.filter(tool => ['read_file', 'write_file'].includes(tool.name)), inputMessages: [{ messageId: 'user-' + turnId, message: { role: 'user', content: 'continue' } }] });
  await host.runSessionTurn(request('one'));
  const record = await host.sendCommand({ kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload: { sessionId: 'task', turnId: 'one', toolCallId: 'call-1' } });
  assert.equal(record.workspaceChanges[0].metadata.beforeContentBase64, Buffer.from('original').toString('base64'));
  await host.sendCommand({ kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId: 'task', turnIds: ['one'] } });
  assert.equal(await readFile(join(source, 'ignored', 'notes.txt'), 'utf8'), 'original');
  await host.runSessionTurn(request('two'));
  await assert.rejects(host.sendCommand({ kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId: 'task', turnIds: ['two'] } }), /mixes Git workspace changes/);
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'tracked edit');
  assert.equal(await readFile(join(source, 'ignored', 'notes.txt'), 'utf8'), 'second');
});

test('checkpoint corruption is surfaced and textual review preserves final-newline facts', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  await manager.beginTurn('task', 'one');
  await writeFile(join(workspaceDir, 'file.txt'), 'committed');
  await manager.finishTurn('task', 'one');
  const change = (await manager.review('task')).changes[0];
  assert.equal(change.additions, 1);
  assert.equal(change.deletions, 1);
  assert.match(change.metadata.diff, /No newline at end of file/);
  const oid = change.metadata.beforeObjectId;
  const blob = join(source, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  await chmod(blob, 0o600);
  await writeFile(blob, 'damaged');
  await assert.rejects(manager.revert('task', ['one']), { code: 'workspace_journal_corrupt' });
  assert.equal(await readFile(join(workspaceDir, 'file.txt'), 'utf8'), 'committed');
});

test('managed workspace identity survives renderer metadata updates and deletion requires copy disposal', async t => {
  const { source, storage } = await fixture(t);
  const host = new InMemoryRuntimeHost({ dataRoot: storage });
  const snapshot = await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: {
    sessionId: 'task', workspace: { sourceDir: source, mode: 'worktree' }, metadata: {},
  } });
  const changed = await host.sendCommand({ kind: UPDATE_RUNTIME_SESSION_METADATA_COMMAND, payload: {
    sessionId: 'task', expectedRevision: snapshot.revision,
    metadata: { ...snapshot.metadata, projectDir: 'wrong', user_project_dir: 'wrong', workspaceDir: 'wrong', runtimeWorkspace: { workspaceDir: 'wrong' } },
  } });
  assert.equal(changed.metadata.projectDir, source);
  assert.equal(changed.metadata.user_project_dir, source);
  assert.equal(changed.metadata.runtimeWorkspace.workspaceDir, snapshot.metadata.runtimeWorkspace.workspaceDir);
  await assert.rejects(host.sendCommand({ kind: DELETE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task' } }), /still owns an independent workspace/);
  const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
  await host.sendCommand({ kind: UPDATE_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task', action: 'discard', expectedRevision: review.workspace.revision, expectedSnapshotId: review.snapshotId } });
  assert.equal((await host.sendCommand({ kind: DELETE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task' } })).deleted, true);
  assert.equal(await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task' } }), null);
});

test('workspace setup resumes a partial copy but preserves edits made inside an interrupted copy', async t => {
  const { source, storage, manager } = await fixture(t);
  const descriptor = await manager.create('task', source, 'worktree');
  const { statePath } = await persisted(storage);
  const intentPath = join(statePath, '..', 'provisioning.json');
  await rename(statePath, intentPath);
  await rm(join(descriptor.workspaceDir, 'file.txt'));
  const reopened = new TaskWorkspaceManager(storage);
  assert.equal((await reopened.create('task', source, 'worktree')).workspaceDir, descriptor.workspaceDir);
  assert.equal(await readFile(join(descriptor.workspaceDir, 'file.txt'), 'utf8'), 'committed\r\n');
  await rename(statePath, intentPath);
  await writeFile(join(descriptor.workspaceDir, 'file.txt'), 'external edit in partial copy');
  await assert.rejects(new TaskWorkspaceManager(storage).create('task', source, 'worktree'), { code: 'workspace_provisioning_conflict' });
  assert.equal(await readFile(join(descriptor.workspaceDir, 'file.txt'), 'utf8'), 'external edit in partial copy');
});

test('a crash after copy removal acknowledges the completed disposal on restart', async t => {
  const { source, storage, manager } = await fixture(t);
  const { workspaceDir } = await manager.create('task', source, 'worktree');
  const { state, statePath } = await persisted(storage);
  state.disposal = 'discard';
  await writeFile(statePath, JSON.stringify(state));
  git(source, 'worktree', 'remove', '--force', workspaceDir);
  const reopened = new TaskWorkspaceManager(storage);
  assert.equal((await reopened.descriptor('task')).status, 'discarded');
  await assert.rejects(reopened.beginTurn('task', 'one'), { code: 'workspace_not_ready' });
  assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'committed\r\n');
});

test('background terminals do not decide model completion or prevent dialogue, but file actions require a confirmed stop', async t => {
  const { source, storage } = await fixture(t);
  let calls = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    if (calls++ === 0) {
      yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: 'server', nameDelta: 'terminal_exec',
        argumentsDelta: JSON.stringify({ command: "node -e \"require('node:fs').writeFileSync('file.txt','server started');setTimeout(()=>{},30000)\"", yield_time_ms: 1000 }) };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
      return;
    }
    yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Server is running.' };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } } });
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', workspace: { sourceDir: source, mode: 'worktree' }, metadata: {} } });
  const catalog = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  const request = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: `request-${turnId}`, sessionId: 'task', turnId, model: 'fixture', tools: catalog.filter(tool => tool.name === 'terminal_exec'), inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: 'continue' } }] });
  const update = async action => {
    const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
    return host.sendCommand({ kind: UPDATE_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task', action, expectedRevision: review.workspace.revision, expectedSnapshotId: review.snapshotId } });
  };
  try {
    const result = await host.runSessionTurn(request('one'));
    assert.equal(result.payload.status, 'completed');
    assert.equal(result.payload.details.workspaceCheckpointError, undefined);
    const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
    assert.equal(review.runningTerminals, true);
    assert.equal(review.checkpoints[0].status, 'complete');
    assert.equal(review.checkpoints[0].backgroundProcesses, true);
    assert.equal((await host.runSessionTurn(request('two'))).payload.status, 'completed');
    await assert.rejects(update('apply'), /terminal .*still running/);
    await update('stop_terminals');
    assert.equal((await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } })).runningTerminals, false);
    await update('apply');
    assert.equal(await readFile(join(source, 'file.txt'), 'utf8'), 'server started');
    assert.equal(calls, 3);
  } finally { await update('stop_terminals'); }
});

test('workspace actions cannot race the asynchronous admission of a new Turn', async t => {
  const { source, storage } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    await gate;
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'text_delta', delta: 'done' };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } } });
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', metadata: {}, workspace: { sourceDir: source, mode: 'worktree' } } });
  const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
  const running = host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'task', turnId: 'one', model: 'fixture', tools: [], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'continue' } }] });
  try {
    await assert.rejects(host.sendCommand({ kind: UPDATE_RUNTIME_WORKSPACE_COMMAND, payload: {
      sessionId: 'task', action: 'discard', expectedRevision: review.workspace.revision, expectedSnapshotId: review.snapshotId,
    } }), /active Turns/);
  } finally { release(); await running; }
  assert.equal((await lstat(review.workspace.workspaceDir)).isDirectory(), true);
});

test('workspace storage faults remain separate from the model terminal and do not leave a permanent active lease', async t => {
  const { source, storage } = await fixture(t);
  const statePath = join(storage, 'workspaces', 'tasks', createHash('sha256').update('task').digest('hex'), 'state.json');
  let savedState, calls = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: storage, provider: { async *stream(request) {
    if (calls++ === 0) {
      savedState = await readFile(statePath);
      await writeFile(statePath, 'damaged storage');
    }
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
    yield { ...base, sequence: 0, kind: 'text_delta', delta: 'done' };
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
  } } });
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task', metadata: {}, workspace: { sourceDir: source, mode: 'worktree' } } });
  const request = turnId => ({ protocol: 'bush.session_turn_request.v1', requestId: `request-${turnId}`, sessionId: 'task', turnId, model: 'fixture', tools: [], inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: 'continue' } }] });
  const terminal = await host.runSessionTurn(request('one'));
  assert.equal(terminal.payload.status, 'completed');
  assert.ok(terminal.payload.details.workspaceCheckpointError);
  const session = await host.sendCommand({ kind: GET_RUNTIME_SESSION_COMMAND, payload: { sessionId: 'task' } });
  assert.equal(session.turns.length, 1, 'storage failure cannot recommit the model Turn');
  await writeFile(statePath, savedState);
  const review = await host.sendCommand({ kind: GET_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task' } });
  await host.sendCommand({ kind: UPDATE_RUNTIME_WORKSPACE_COMMAND, payload: { sessionId: 'task', action: 'checkpoint', expectedRevision: review.workspace.revision } });
  assert.equal((await host.runSessionTurn(request('two'))).payload.status, 'completed');
});
