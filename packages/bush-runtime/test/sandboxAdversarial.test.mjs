import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskWorkspaceManager, ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';
import { GitWorkspaceStore } from '../dist/gitWorkspaceStore.js';
import { SandboxFileHandle } from '../dist/workspaceSandboxFile.js';
import { runResourceManagedCommand } from '../dist/processes.js';
import { commandInvocation } from '@cardbush/platform';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cardbush-sandbox-adversarial-')));
  const work = join(root, 'work'), outside = join(root, 'outside');
  mkdirSync(work); mkdirSync(outside);
  const secret = join(outside, 'secret.txt'); writeFileSync(secret, 'private-outside-content-92871');
  t.after(() => {
    const delta = relative(realpathSync(tmpdir()), root);
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let beforeExecute, ordinal = 0;
  const registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const coordinator = new ToolExecutionCoordinator({ registry,
    observer: { running() { const action = beforeExecute; beforeExecute = undefined; action?.(); } },
    permissions: { async request(request) { return { decision: 'allow_once', grantedCapabilityIds: request.capabilityIds }; } },
  });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: { workspaceDir: work } };
  return { root, work, outside, secret, beforeExecute(action) { beforeExecute = action; },
    run(name, input) { return coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c${++ordinal}`, name, argumentsText: JSON.stringify(input) },
      { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal }, undefined, { request, contextMessages: [] }); } };
}

test('hard-link aliases cannot disclose outside bytes through full/ranged reads, search, edits or patches', async t => {
  const f = fixture(t), alias = join(f.work, 'alias.txt'); linkSync(f.secret, alias);
  for (const [name, input] of [
    ['read_file', { path: alias }], ['read_file', { path: alias, start_line: 1 }],
    ['search_file_content', { path: alias, query: 'private-outside' }],
    ['search_file_content', { path: f.work, query: 'private-outside' }],
    ['write_file', { path: alias, content: 'escaped' }],
    ['edit_file', { path: alias, old_text: 'private-outside-content-92871', new_text: 'escaped' }],
    ['apply_patch', { patch: `*** Begin Patch\n*** Delete File: ${alias}\n*** End Patch` }],
  ]) {
    const result = await f.run(name, input);
    assert.equal(result.kind, 'failed', `${name}: ${JSON.stringify(result)}`);
    assert.equal(result.result, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-outside-content-92871/);
    assert.equal(readFileSync(f.secret, 'utf8'), 'private-outside-content-92871');
  }
});

test('a hard link introduced after admission invalidates an otherwise unchanged file identity', async t => {
  const f = fixture(t), path = join(f.work, 'file.txt'); writeFileSync(path, 'authorized');
  f.beforeExecute(() => linkSync(path, join(f.outside, 'new-alias.txt')));
  const result = await f.run('read_file', { path });
  assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'workspace_authorization_changed');
  assert.equal(result.result, undefined);
});

test('exact file worker rejects read grants to aliases even without tool admission', async t => {
  const f = fixture(t), alias = join(f.work, 'alias.txt'); linkSync(f.secret, alias);
  const info = statSync(alias, { bigint: true });
  await assert.rejects(SandboxFileHandle.open(alias, `${info.dev}:${info.ino}`, false));
});

for (const write of [false, true]) test(`a live exact-file handle blocks a new alias or rejects the next ${write ? 'write' : 'read'}`, async t => {
  const f = fixture(t), path = join(f.work, 'allowed.txt'); writeFileSync(path, 'allowed');
  const info = statSync(path, { bigint: true });
  const file = await SandboxFileHandle.open(path, `${info.dev}:${info.ino}`, write);
  try {
    let linked = false;
    try { linkSync(path, join(f.outside, 'late.txt')); linked = true; }
    catch (error) { assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); }
    if (linked) await assert.rejects(write ? file.truncate(0) : file.request({ op: 'read', offset: 0, count: 64 }), { code: 'workspace_authorization_changed' });
    else assert.equal(Buffer.from(await file.request({ op: 'read', offset: 0, count: 64 }), 'base64').toString(), 'allowed');
    assert.equal(readFileSync(path, 'utf8'), 'allowed');
  } finally { await file.close(); }
});

for (const writing of [false, true]) test(`directory ${writing ? 'write' : 'read'} grants reject hidden hard links before starting a command`, async t => {
  const f = fixture(t), nested = join(f.work, '.hidden', 'nested'); mkdirSync(nested, { recursive: true });
  linkSync(f.secret, join(nested, 'alias.txt'));
  const invocation = commandInvocation(process.platform === 'win32' ? 'cmd' : 'posix', 'echo MUST_NOT_START');
  await assert.rejects(runResourceManagedCommand({ ...invocation, cwd: f.work, timeoutMs: 5000,
    sandbox: { network: 'disabled', readableRoots: writing ? [] : [f.work], writableRoots: writing ? [f.work] : [] } }),
  { code: 'sandbox_approval_changed' });
  assert.equal(readFileSync(f.secret, 'utf8'), 'private-outside-content-92871');
});

test('native ACL setup rejects a hard link inserted after JavaScript preflight', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), original = childProcess.spawn; let inserted = false;
  const acl = () => execFileSync('icacls.exe', [f.secret], { windowsHide: true, encoding: 'utf8' });
  const before = acl();
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    if (args.includes('--sandbox')) { linkSync(f.secret, join(f.work, 'late.txt')); inserted = true; }
    return original(executable, args, options);
  }); syncBuiltinESMExports();
  try {
    const invocation = commandInvocation('cmd', 'echo MUST_NOT_START');
    await assert.rejects(runResourceManagedCommand({ ...invocation, cwd: f.work, timeoutMs: 5000,
      sandbox: { network: 'disabled', readableRoots: [], writableRoots: [f.work] } }),
    error => error.code === 'resource_protection_failed' && /multiple hard links/.test(error.message));
    assert.equal(inserted, true);
    assert.equal(readFileSync(f.secret, 'utf8'), 'private-outside-content-92871');
    assert.equal(acl(), before, 'failed directory setup must not leave a capability on the outside inode');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('checkpoint read batches cannot open an ungranted sibling and fail closed after rejection', async t => {
  const f = fixture(t), path = join(f.work, 'allowed.txt'); writeFileSync(path, 'allowed');
  const identity = path => { const info = statSync(path, { bigint: true }); return `${info.dev}:${info.ino}`; };
  const file = await SandboxFileHandle.openReadBatch({ [path]: identity(path) });
  try {
    await file.request({ op: 'open', path, identity: identity(path), write: false });
    assert.equal(Buffer.from(await file.request({ op: 'read', offset: 0, count: 64 }), 'base64').toString(), 'allowed');
    await file.request({ op: 'release' });
    await assert.rejects(file.request({ op: 'open', path: f.secret, identity: identity(f.secret), write: false }));
    await assert.rejects(file.request({ op: 'read', offset: 0, count: 64 }));
  } finally { await file.close(); }
});

function repository(t) {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.work], { windowsHide: true });
  const path = join(f.work, 'file.txt'); writeFileSync(path, 'authorized workspace bytes');
  const manager = new TaskWorkspaceManager(join(f.root, 'state'));
  const privateId = execFileSync('git', ['-C', f.work, 'hash-object', '--stdin'], { input: readFileSync(f.secret), windowsHide: true, encoding: 'utf8' }).trim();
  return { ...f, path, manager, assertNoLeak() {
    assert.notEqual(spawnSync('git', ['-C', f.work, 'cat-file', '-e', privateId], { windowsHide: true }).status, 0,
      'outside bytes must not enter even an unreachable Git object');
    assert.equal(readFileSync(f.secret, 'utf8'), 'private-outside-content-92871');
  } };
}

test('Git capture rejects a hard-link replacement between description and hashing without retaining its bytes', async t => {
  const f = repository(t), original = GitWorkspaceStore.prototype.hashFiles; let attacked = false;
  t.mock.method(GitWorkspaceStore.prototype, 'hashFiles', async function(...args) {
    if (!attacked) {
      attacked = true; rmSync(f.path); linkSync(f.secret, f.path);
    }
    return original.apply(this, args);
  });
  const workspace = await f.manager.create('s', f.work, 'direct');
  assert.equal(attacked, true); assert.equal(workspace.versioning, 'none'); assert.ok(workspace.versioningError);
  f.assertNoLeak();
});

test('Git capture pins parents through attempted junction replacement', async t => {
  const f = repository(t), nested = join(f.work, 'nested'); mkdirSync(nested);
  writeFileSync(join(nested, 'secret.txt'), 'authorized nested bytes');
  const original = GitWorkspaceStore.prototype.hashFiles; let attempted = false, blocked = false;
  t.mock.method(GitWorkspaceStore.prototype, 'hashFiles', async function(...args) {
    if (!attempted) {
      attempted = true;
      try { renameSync(nested, join(f.work, 'old-nested')); symlinkSync(f.outside, nested, process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) { assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); blocked = true; }
    }
    return original.apply(this, args);
  });
  const workspace = await f.manager.create('s', f.work, 'direct');
  assert.equal(attempted, true);
  assert.ok(blocked || workspace.versioning === 'none'); f.assertNoLeak();
});

test('small and large checkpoints stream only checked bytes to Git and preserve binary contents', async t => {
  const f = repository(t), large = join(f.work, 'large.bin');
  const bytes = Buffer.alloc(9 * 1024 * 1024, 173); writeFileSync(large, bytes);
  const original = GitWorkspaceStore.prototype.git; let streamed = 0;
  t.mock.method(GitWorkspaceStore.prototype, 'git', async function(args, input, ...rest) {
    assert.ok(!args.includes('--stdin-paths'));
    if (args.includes('fast-import') || args.includes('hash-object')) {
      if (args.includes('hash-object')) assert.ok(args.includes('--stdin'));
      assert.ok(!args.some(arg => arg === f.path || arg === large));
      assert.ok(input && !Buffer.isBuffer(input) && input[Symbol.asyncIterator]); streamed++;
    }
    return original.call(this, args, input, ...rest);
  });
  const workspace = await f.manager.create('s', f.work, 'direct');
  assert.equal(workspace.versioning, 'git', workspace.versioningError); assert.ok(streamed >= 1);
  const stored = execFileSync('git', ['-C', f.work, 'show', `${workspace.baselineId}:large.bin`], { windowsHide: true, maxBuffer: bytes.length + 1024 });
  assert.deepEqual(stored, bytes); f.assertNoLeak();
});

test('checkpoint failure preserves the last version and recovers after removing the malicious alias', async t => {
  const f = repository(t); await f.manager.create('s', f.work, 'direct'); await f.manager.beginTurn('s', 'turn');
  const alias = join(f.work, 'late-alias.txt'); linkSync(f.secret, alias);
  await assert.rejects(f.manager.finishTurn('s', 'turn'), { code: 'workspace_authorization_changed' });
  const history = await f.manager.review('s', 'history'); assert.equal(history.checkpoints[0].status, 'failed');
  f.assertNoLeak(); rmSync(alias); await f.manager.recoverCheckpoint('s');
  assert.equal((await f.manager.review('s', 'history')).checkpoints[0].status, 'complete');
});

test('checkpoint capture crosses exact-grant batch boundaries without losing files', async t => {
  const f = repository(t);
  for (let n = 0; n < 70; n++) writeFileSync(join(f.work, `entry-${n}.txt`), `batch content ${n}`);
  const descriptor = await f.manager.create('s', f.work, 'direct');
  assert.equal(descriptor.versioning, 'git', descriptor.versioningError);
  const paths = execFileSync('git', ['-C', f.work, 'ls-tree', '--name-only', descriptor.baselineId], { windowsHide: true, encoding: 'utf8' }).trim().split('\n');
  assert.equal(paths.length, 71);
  for (const n of [0, 63, 64, 69]) assert.equal(execFileSync('git', ['-C', f.work, 'show', `${descriptor.baselineId}:entry-${n}.txt`],
    { windowsHide: true, encoding: 'utf8' }), `batch content ${n}`);
});
