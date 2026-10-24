import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { SandboxFileHandle } from '../dist/workspaceSandboxFile.js';
import { ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';

function fixture(t, options = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cardbush-path-authorization-')));
  t.after(() => {
    assert.equal(dirname(root), realpathSync.native(tmpdir()));
    assert.ok(basename(root).startsWith('cardbush-path-authorization-'));
    rmSync(root, { recursive: true, force: true });
  });
  const work = join(root, 'work'), safe = join(work, 'safe'), outside = join(root, 'outside');
  for (const path of [safe, outside]) mkdirSync(path, { recursive: true });
  writeFileSync(join(safe, 'file.txt'), 'authorized'); writeFileSync(join(outside, 'file.txt'), 'outside secret');
  const link = join(work, 'link'); symlinkSync(safe, link, process.platform === 'win32' ? 'junction' : 'dir');
  const registry = new ToolRegistry(); registerWorkspaceTools(registry, undefined, options);
  let nextAction, onApproval, prompts = 0, ordinal = 0;
  const coordinator = new ToolExecutionCoordinator({ registry,
    observer: { running() { const action = nextAction; nextAction = undefined; action?.(); } },
    permissions: { async request(request) { prompts++; onApproval?.(); return { decision: onApproval ? 'allow_once' : 'deny', grantedCapabilityIds: onApproval ? request.capabilityIds : [] }; } },
  });
  const turn = { request: { protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'fixture', tools: registry.definitions(), messages: [], permissionMode: 'task_free', metadata: { workspaceDir: work } }, contextMessages: [] };
  return { root, work, safe, outside, link, registry, get prompts() { return prompts; },
    beforeExecute(action) { nextAction = action; }, onApproval(action) { onApproval = action; },
    redirect() { renameSync(link, join(work, 'old-link')); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); },
    run(name, input) { return coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++ordinal}`, name, argumentsText: JSON.stringify(input) }, { requestId: 'request', sessionId: 'session', turnId: 'turn', round: 1, ordinal }, undefined, turn); },
  };
}

for (const ranged of [false, true]) test(`read_file rejects a redirected authorized path (${ranged ? 'ranged' : 'full'})`, async t => {
  const f = fixture(t);
  assert.equal((await f.run('read_file', { path: join(f.outside, 'file.txt') })).error.code, 'permission_rejected');
  f.beforeExecute(() => f.redirect());
  const result = await f.run('read_file', { path: join(f.link, 'file.txt'), ...(ranged ? { start_line: 1 } : {}) });
  assert.equal(result.error.code, 'workspace_authorization_changed');
  assert.equal(result.execution.dispatch, 'not_started'); assert.equal(result.execution.effects, 'none');
  assert.equal(f.prompts, 1); assert.equal(result.result, undefined);
});

test('an approved external target cannot redirect its grant to another target', async t => {
  const f = fixture(t);
  const alias = join(f.root, 'approved-link'); symlinkSync(f.outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const different = join(f.root, 'different'); mkdirSync(different); writeFileSync(join(different, 'file.txt'), 'not approved');
  f.onApproval(() => { renameSync(alias, join(f.root, 'old-approved-link')); symlinkSync(different, alias, process.platform === 'win32' ? 'junction' : 'dir'); });
  const result = await f.run('read_file', { path: join(alias, 'file.txt') });
  assert.equal(f.prompts, 1); assert.equal(result.error.code, 'workspace_authorization_changed');
});

test('write_file rejects a changed missing-file parent before creating anything', async t => {
  const f = fixture(t); f.beforeExecute(() => f.redirect());
  const result = await f.run('write_file', { path: join(f.link, 'new', 'file.txt'), content: 'unauthorized write' });
  assert.equal(result.error.code, 'workspace_authorization_changed');
  assert.equal(existsSync(join(f.outside, 'new')), false); assert.equal(existsSync(join(f.safe, 'new')), false);
});

test('edit_file does not read or mutate a replacement target', async t => {
  const f = fixture(t); await f.run('read_file', { path: join(f.link, 'file.txt') });
  f.beforeExecute(() => f.redirect());
  const result = await f.run('edit_file', { path: join(f.link, 'file.txt'), old_text: 'authorized', new_text: 'edited' });
  assert.equal(result.error.code, 'workspace_authorization_changed');
  assert.equal(readFileSync(join(f.safe, 'file.txt'), 'utf8'), 'authorized');
  assert.equal(readFileSync(join(f.outside, 'file.txt'), 'utf8'), 'outside secret');
});

test('search rejects a redirected directory before traversal', async t => {
  const f = fixture(t); f.beforeExecute(() => f.redirect());
  const result = await f.run('search_file_content', { path: f.link, query: 'secret' });
  assert.equal(result.error.code, 'workspace_authorization_changed'); assert.equal(result.result, undefined);
});

test('multi-file patch validates every source and move destination before its first write', async t => {
  const f = fixture(t); const source = join(f.safe, 'file.txt');
  await f.run('read_file', { path: source }); f.beforeExecute(() => f.redirect());
  const result = await f.run('apply_patch', { patch: `*** Begin Patch\n*** Add File: ${join(f.work, 'first.txt')}\n+first\n*** Update File: ${source}\n*** Move to: ${join(f.link, 'moved.txt')}\n@@\n-authorized\n+edited\n*** End Patch` });
  assert.equal(result.error.code, 'workspace_authorization_changed');
  assert.equal(existsSync(join(f.work, 'first.txt')), false); assert.equal(existsSync(join(f.outside, 'moved.txt')), false);
  assert.equal(readFileSync(source, 'utf8'), 'authorized');
});

test('same-name file replacement after approval is rejected by identity', async t => {
  const f = fixture(t); const path = join(f.safe, 'file.txt');
  f.beforeExecute(() => { renameSync(path, join(f.safe, 'old.txt')); writeFileSync(path, 'replacement'); });
  const result = await f.run('read_file', { path });
  assert.equal(result.error.code, 'workspace_authorization_changed');
});

test('replacement during asynchronous preflight cannot redirect a subsequent truncation', async t => {
  let replace;
  const f = fixture(t, { ownsFileVersion: async () => { replace?.(); return false; } });
  const path = join(f.safe, 'file.txt'); await f.run('read_file', { path });
  let blocked = false;
  replace = () => {
    try { renameSync(path, join(f.safe, 'old.txt')); copyFileSync(join(f.outside, 'file.txt'), path); }
    catch (error) { assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); blocked = true; }
  };
  const result = await f.run('write_file', { path, content: 'replacement should survive' });
  if (blocked) assert.equal(result.kind, 'returned', JSON.stringify(result));
  else { assert.equal(result.error.code, 'workspace_authorization_changed'); assert.equal(readFileSync(path, 'utf8'), 'outside secret'); }
  assert.equal(readFileSync(join(f.outside, 'file.txt'), 'utf8'), 'outside secret');
});

test('parent identities remain protected during I/O and are released afterwards', async t => {
  let attempt;
  const f = fixture(t, { ownsFileVersion: async () => { attempt?.(); return false; } });
  const path = join(f.safe, 'file.txt'); await f.run('read_file', { path });
  let denied = false;
  attempt = () => {
    try { renameSync(f.safe, join(f.work, 'moved-safe')); symlinkSync(f.outside, f.safe, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(error.code)); denied = true; }
  };
  const result = await f.run('write_file', { path, content: 'edited' });
  assert.equal(result.kind, 'returned', JSON.stringify(result));
  assert.equal(readFileSync(join(f.outside, 'file.txt'), 'utf8'), 'outside secret');
  if (process.platform === 'win32') {
    assert.equal(denied, true); renameSync(f.safe, join(f.work, 'released'));
    assert.equal(readFileSync(join(f.work, 'released', 'file.txt'), 'utf8'), 'edited');
  } else assert.equal(readFileSync(join(f.work, 'moved-safe', 'file.txt'), 'utf8'), 'edited');
});

test('redirecting the worker open request cannot read or truncate an ungranted file', async t => {
  const f = fixture(t), path = join(f.safe, 'file.txt'), outside = join(f.outside, 'file.txt');
  await f.run('read_file', { path });
  const original = SandboxFileHandle.prototype.request;
  let redirectWrites = false;
  const mocked = t.mock.method(SandboxFileHandle.prototype, 'request', async function(input) {
    if (input.op === 'open' && input.write === redirectWrites) input = { ...input, path: outside };
    return original.call(this, input);
  });
  try {
    const read = await f.run('read_file', { path });
    assert.ok(['EACCES', 'ENOENT'].includes(read.error.code), JSON.stringify(read)); assert.equal(read.result, undefined);
    redirectWrites = true;
    const write = await f.run('write_file', { path, content: 'must not truncate the other object' });
    assert.ok(['EACCES', 'ENOENT'].includes(write.error.code), JSON.stringify(write));
    assert.equal(readFileSync(outside, 'utf8'), 'outside secret'); assert.equal(readFileSync(path, 'utf8'), 'authorized');
  } finally { mocked.mock.restore(); }
});

test('nested creation and unchanged approved targets remain usable', async t => {
  const f = fixture(t); f.onApproval(() => {});
  assert.equal((await f.run('read_file', { path: join(f.outside, 'file.txt') })).result.content, 'outside secret');
  const path = join(f.work, 'a', 'b', 'new.txt');
  assert.equal((await f.run('write_file', { path, content: 'new' })).kind, 'returned');
  assert.equal(readFileSync(path, 'utf8'), 'new');
  renameSync(join(f.work, 'a'), join(f.work, 'released-a'));
});
