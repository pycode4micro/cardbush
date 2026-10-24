import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs, mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import sharp from 'sharp';
import { ToolRegistry, ToolExecutionCoordinator, ToolExecutionStore, registerWorkspaceTools, WorkspaceObservationStore, SessionStore, InMemoryRuntimeHost } from '../dist/index.js';
import { registerExtendedBuiltins } from '../dist/extendedBuiltins.js';
import { registerSourceMemoTools } from '../dist/sourceMemo.js';
import { commandSandboxPlan, authorizedCommandSandbox } from '../dist/commandSandboxAdmission.js';
import { SandboxFileHandle } from '../dist/workspaceSandboxFile.js';
import { TaskWorkspaceManager } from '../dist/taskWorkspace.js';
import { GitWorkspaceStore } from '../dist/gitWorkspaceStore.js';
import { trustedGitSync } from '../dist/trustedGit.js';
import { CREATE_RUNTIME_SESSION_COMMAND, REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND } from '@cardbush/bush-protocol';

const runtime = new URL('../dist/', import.meta.url);
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cardbush-boundary-regression-')));
  const work = join(root, 'work'), outside = join(root, 'outside'), safe = join(work, 'safe'), state = join(root, 'state');
  for (const path of [safe, outside, state]) mkdirSync(path, { recursive: true });
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); assert.ok(basename(root).startsWith('cardbush-boundary-regression-')); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
  return { root, work, outside, safe, state };
}
function runner(f, registry, onRunning, permissions) {
  let ordinal = 0, prompts = 0;
  const coordinator = new ToolExecutionCoordinator({ registry, observer: { running: () => onRunning?.() },
    permissions: { async request(request) { prompts++; return permissions ? permissions(request) : { decision: 'deny', grantedCapabilityIds: [] }; } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'test', tools: registry.definitions(), messages: [], permissionMode: 'task_free', metadata: { workspaceDir: f.work } };
  return { get prompts() { return prompts; }, async run(name, input) {
    const toolCall = { protocol: 'bush.tool_call.v1', id: `c${++ordinal}`, name, argumentsText: JSON.stringify(input) };
    const identity = { requestId: 'r', sessionId: 's', turnId: 't', ordinal, round: 1 };
    const outcome = await coordinator.execute(toolCall, identity, undefined, { request, contextMessages: [] });
    return { outcome, toolCall, identity };
  } };
}
function linkDirectory(target, path) { symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); }
async function png(path) { const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#a047d1' } }).png().toBuffer(); writeFileSync(path, bytes); return bytes; }

test('image injection authorizes the canonical image behind an existing directory link', async t => {
  const f = fixture(t), registry = new ToolRegistry(); registerExtendedBuiltins(registry, { dataRoot: f.state });
  await png(join(f.outside, 'image.png'));
  const link = join(f.work, 'link'); linkDirectory(f.outside, link);
  const r = runner(f, registry);
  for (const url of [join(f.outside, 'image.png'), join(link, 'image.png')]) {
    const { outcome } = await r.run('inject_image_input', { url, original: true });
    assert.equal(outcome.error.code, 'permission_rejected');
  }
  assert.equal(r.prompts, 2); assert.equal(existsSync(join(f.state, 'model-images')), false);
});

for (const kind of ['image', 'source']) test(`${kind} retains the authorized identity across queuing`, async t => {
  const f = fixture(t), registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: f.state }); registerSourceMemoTools(registry, new ToolExecutionStore());
  const name = kind === 'image' ? 'image.png' : 'evidence.txt';
  if (kind === 'image') { await png(join(f.safe, name)); await png(join(f.outside, name)); }
  else { writeFileSync(join(f.safe, name), 'authorized'); writeFileSync(join(f.outside, name), 'outside'); }
  const link = join(f.work, 'link'); linkDirectory(f.safe, link);
  const r = runner(f, registry, () => { renameSync(link, join(f.work, 'old-link')); linkDirectory(f.outside, link); });
  const { outcome } = await r.run(kind === 'image' ? 'inject_image_input' : 'remember_source', kind === 'image'
    ? { url: join(link, name) } : { explanation: 'fixture', sources: [{ target: join(link, name), locator: { line: 1 } }] });
  assert.equal(outcome.error.code, 'workspace_authorization_changed'); assert.equal(outcome.result, undefined); assert.equal(r.prompts, 0);
});

test('image and source content use sandbox workers, including Unicode paths and explicit single-file approval', async t => {
  const f = fixture(t), registry = new ToolRegistry(); registerExtendedBuiltins(registry, { dataRoot: f.state }); registerSourceMemoTools(registry, new ToolExecutionStore());
  const image = join(f.outside, '测试 图片.png'), source = join(f.outside, '证据.txt'); await png(image); writeFileSync(source, 'sandbox evidence');
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', (path, flags, ...args) => {
    if (!(process.platform === 'linux' && typeof flags === 'number' && flags & 0x200000)) assert.ok(![image, source].includes(path), 'host must not open source content');
    return originalOpen(path, flags, ...args);
  }); syncBuiltinESMExports();
  const r = runner(f, registry, undefined, request => ({ decision: 'allow_once', grantedCapabilityIds: request.capabilityIds }));
  try {
    assert.equal((await r.run('inject_image_input', { url: image, original: true })).outcome.kind, 'returned');
    const { outcome } = await r.run('remember_source', { explanation: 'fixture', sources: [{ target: source, locator: { line: 1 } }] });
    assert.equal(outcome.kind, 'returned', JSON.stringify(outcome)); assert.equal(outcome.result.sources[0].excerpt, 'sandbox evidence');
    assert.equal(r.prompts, 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('image and memo failures never retry content on the host', async t => {
  const f = fixture(t), registry = new ToolRegistry(); registerExtendedBuiltins(registry, { dataRoot: f.state }); registerSourceMemoTools(registry, new ToolExecutionStore());
  const image = join(f.safe, 'image.png'), source = join(f.safe, 'text.txt'); await png(image); writeFileSync(source, 'fixture');
  t.mock.method(SandboxFileHandle, 'open', async () => { throw Object.assign(Error('backend denied'), { code: 'sandbox_unavailable' }); });
  const r = runner(f, registry);
  for (const [name, input] of [['inject_image_input', { url: image }], ['remember_source', { explanation: 'fixture', sources: [{ target: source }] }]]) {
    const { outcome } = await r.run(name, input); assert.equal(outcome.kind, 'failed'); assert.equal(outcome.result, undefined);
  }
  assert.equal(existsSync(join(f.state, 'model-images')), false);
});

async function editedUndoFixture(t) {
  const f = fixture(t), registry = new ToolRegistry(); registerWorkspaceTools(registry, new WorkspaceObservationStore());
  const store = new ToolExecutionStore(), sessions = new SessionStore();
  const host = new InMemoryRuntimeHost({ toolExecutionStore: store, sessionStore: sessions, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  await host.sendCommand({ kind: CREATE_RUNTIME_SESSION_COMMAND, payload: { sessionId: 's', metadata: { projectDir: f.work } } });
  const createdAt = new Date().toISOString();
  sessions.commitTurn('s', { turnId: 't', turnSequence: 1, createdAt, completedAt: createdAt, status: 'completed', reason: 'fixture',
    messages: [{ messageId: 'message', turnId: 't', turnSequence: 1, messageIndex: 0, createdAt, message: { role: 'user', content: 'fixture' } }], usage: {} });
  const file = join(f.safe, 'item.txt'); writeFileSync(file, 'before');
  const r = runner(f, registry); await r.run('read_file', { path: file });
  const edit = await r.run('write_file', { path: file, content: 'after' });
  assert.equal(edit.outcome.kind, 'returned', JSON.stringify(edit.outcome)); store.record(edit.toolCall, edit.identity, edit.outcome);
  return { ...f, file, undo: () => host.sendCommand({ kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload: { sessionId: 's', turnIds: ['t'] } }) };
}

test('undo refuses redirected parents even when the outside content matches the recorded revision', async t => {
  const f = await editedUndoFixture(t); writeFileSync(join(f.outside, 'item.txt'), 'after');
  renameSync(f.safe, join(f.work, 'original-safe')); linkDirectory(f.outside, f.safe);
  await assert.rejects(f.undo(), { code: 'workspace_authorization_changed' });
  assert.equal(readFileSync(join(f.outside, 'item.txt'), 'utf8'), 'after');
});

test('undo fails closed on sandbox failure and preserves the current version', async t => {
  const f = await editedUndoFixture(t);
  t.mock.method(SandboxFileHandle, 'open', async () => { throw Object.assign(Error('backend denied'), { code: 'sandbox_unavailable' }); });
  await assert.rejects(f.undo(), { code: 'sandbox_unavailable' }); assert.equal(readFileSync(f.file, 'utf8'), 'after');
});

test('Git checkpoint undo and restore use checked file I/O, preserve unrelated edits, and fail closed', async t => {
  const f = fixture(t), path = join(f.safe, 'item.txt'), other = join(f.work, 'unrelated.txt');
  const git = trustedGitSync([f.work]);
  const init = spawnSync(git, ['init', '-q', f.work], { windowsHide: true, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr); writeFileSync(path, 'before');
  const manager = new TaskWorkspaceManager(f.state);
  assert.equal((await manager.create('git', f.work, 'direct')).versioning, 'git');
  await manager.beginTurn('git', 't'); writeFileSync(path, 'after'); await manager.finishTurn('git', 't');
  writeFileSync(other, 'user edit after checkpoint');
  t.mock.method(GitWorkspaceStore.prototype, 'hashFiles', () => { throw Error('Undo must not scan working content using host Git'); });
  const original = fs.open;
  t.mock.method(fs, 'open', (file, flags, ...args) => {
    if (!(process.platform === 'linux' && typeof flags === 'number' && flags & 0x200000)) assert.notEqual(file, path, 'restore content must use the sandbox');
    return original(file, flags, ...args);
  }); syncBuiltinESMExports();
  try {
    assert.equal((await manager.revert('git', ['t'])).revertedFiles, 1); assert.equal(readFileSync(path, 'utf8'), 'before');
    assert.equal((await manager.restore('git', ['t'])).restoredFiles, 1); assert.equal(readFileSync(path, 'utf8'), 'after');
    t.mock.method(SandboxFileHandle, 'open', async () => { throw Object.assign(Error('backend denied'), { code: 'sandbox_unavailable' }); });
    await assert.rejects(manager.revert('git', ['t']), { code: 'sandbox_unavailable' });
    assert.equal(readFileSync(path, 'utf8'), 'after'); assert.equal(readFileSync(other, 'utf8'), 'user edit after checkpoint');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('Git helpers never execute a cwd or relative-PATH Git and explicit invalid configuration does not fall back', async t => {
  const f = fixture(t), marker = join(f.outside, 'marker');
  if (process.platform === 'win32') {
    const source = join(f.root, 'FakeGit.cs'); writeFileSync(source, `using System; using System.IO; class Fixture { static void Main() { File.WriteAllText(@"${marker}", "executed"); Console.WriteLine("FAKE_GIT"); } }`);
    const built = spawnSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', `/out:${join(f.work, 'git.exe')}`, source], { windowsHide: true, encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr || built.stdout);
  } else { writeFileSync(join(f.work, 'git'), `#!/bin/sh\necho executed > '${marker}'\necho FAKE_GIT\n`); chmodSync(join(f.work, 'git'), 0o700); }
  const program = `import {GitWorkspaceStore} from ${JSON.stringify(new URL('gitWorkspaceStore.js', runtime).href)};const store=new GitWorkspaceStore(process.cwd(),process.argv[1],'fixture');console.log((await store.git(['--version'])).toString());`;
  const env = { ...process.env, PATH: `.${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` }; delete env.CARDBUSH_GIT_PATH;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.state], { cwd: f.work, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /git version/); assert.equal(existsSync(marker), false);
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.state], { cwd: f.work, env: { ...env, CARDBUSH_GIT_PATH: join(f.work, process.platform === 'win32' ? 'git.exe' : 'git') }, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /git_unavailable/); assert.equal(existsSync(marker), false);
});

test('directory replacement invalidates both explicit terminal approval and implicit workspace admission', async t => {
  const f = fixture(t), target = join(f.root, 'approved'); mkdirSync(target);
  const config = { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] };
  const context = { sessionId: 's', input: { command: 'echo fixture', shell: process.platform === 'win32' ? 'cmd' : 'posix', additionalPermissions: { readRoots: [target], writeRoots: [], network: false } }, turn: { request: { permissionMode: 'task_free', metadata: { workspaceDir: f.work } } } };
  const admitted = await commandSandboxPlan(config, context, f.work);
  renameSync(target, join(f.root, 'previous')); mkdirSync(target);
  const changed = await commandSandboxPlan(config, context, f.work);
  assert.throws(() => authorizedCommandSandbox(changed, [admitted.requiredGrant]), { code: 'sandbox_approval_changed' });
  const registry = new ToolRegistry(); registerWorkspaceTools(registry, undefined, { commandSandbox: config });
  const r = runner(f, registry, () => { renameSync(f.work, join(f.root, 'old-work')); mkdirSync(f.work); });
  const { outcome } = await r.run('terminal_exec', { command: 'echo must-not-run', shell: context.input.shell, cwd: f.work, yield_time_ms: 1000 });
  assert.equal(outcome.error.code, 'sandbox_approval_changed');
});

test('deletion preserves a revision changed after preflight', async t => {
  const f = fixture(t), registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const path = join(f.safe, 'delete.txt'); writeFileSync(path, 'observed');
  const r = runner(f, registry); await r.run('read_file', { path });
  let injected = false;
  if (process.platform === 'win32') {
    const open = SandboxFileHandle.open;
    t.mock.method(SandboxFileHandle, 'open', async (...args) => { if (args[6]) { injected = true; writeFileSync(path, 'concurrent'); } return open(...args); });
  } else {
    const rename = fs.rename;
    t.mock.method(fs, 'rename', async (...args) => { if (String(args[1]).endsWith('/object')) { injected = true; writeFileSync(path, 'concurrent'); } return rename(...args); }); syncBuiltinESMExports();
  }
  try {
    const { outcome } = await r.run('apply_patch', { patch: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` });
    assert.equal(injected, true); assert.equal(outcome.kind, 'failed'); assert.equal(readFileSync(path, 'utf8'), 'concurrent');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('Windows deletion excludes writers through its commit and closes all pins afterwards', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), registry = new ToolRegistry(); registerWorkspaceTools(registry);
  const path = join(f.safe, 'delete.txt'); writeFileSync(path, 'observed');
  const r = runner(f, registry); await r.run('read_file', { path });
  const request = SandboxFileHandle.prototype.request; let blocked = false;
  t.mock.method(SandboxFileHandle.prototype, 'request', async function(input) {
    if (input.op === 'delete') { assert.throws(() => writeFileSync(path, 'concurrent'), error => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code)); blocked = true; }
    return request.call(this, input);
  });
  const { outcome } = await r.run('apply_patch', { patch: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` });
  assert.equal(outcome.kind, 'returned', JSON.stringify(outcome)); assert.equal(blocked, true); assert.equal(existsSync(path), false);
  writeFileSync(path, 'new file'); assert.equal(readFileSync(path, 'utf8'), 'new file');
});
