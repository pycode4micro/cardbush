import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync, statSync, renameSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxFileHandle } from '../dist/workspaceSandboxFile.js';
import { searchWorkspaceContent } from '../dist/workspaceSearch.js';
import { ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';
import { runResourceManagedCommand } from '../dist/processes.js';
import { commandSandboxPlan, authorizedCommandSandbox, decodeAdditionalCommandPermissions } from '../dist/commandSandboxAdmission.js';

const identity = path => { const s = statSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };
function fixture(t, options) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cardbush-file-sandbox-')));
  const work = join(root, 'work'), external = join(root, 'external'), host = join(root, 'host');
  for (const path of [work, external, host]) mkdirSync(path);
  const path = join(external, 'allowed.txt'), sibling = join(external, 'secret.txt');
  writeFileSync(path, 'allowed'); writeFileSync(sibling, 'sibling secret');
  t.after(() => { assert.equal(dirname(root), realpathSync(tmpdir())); assert.ok(basename(root).startsWith('cardbush-file-sandbox-')); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
  const registry = new ToolRegistry(); registerWorkspaceTools(registry, undefined, options);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { async request(request) { return { decision: 'allow_once', grantedCapabilityIds: request.capabilityIds }; } } });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: registry.definitions(), messages: [], metadata: { workspaceDir: work } };
  let ordinal = 0;
  return { root, work, external, host, path, sibling, request, run(name, input, signal) {
    return coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c${++ordinal}`, name, argumentsText: JSON.stringify(input) },
      { requestId: 'r', sessionId: 's', turnId: 't', ordinal, round: 1 }, signal, { request, contextMessages: [] });
  } };
}

test('sandbox file metadata preserves native modification-time precision for reference versions', async t => {
  const f = fixture(t);
  await fs.utimes(f.path, 1700000000.123459, 1700000000.123459);
  const native = await fs.stat(f.path), precise = await fs.stat(f.path, { bigint: true });
  const handle = await SandboxFileHandle.open(f.path, identity(f.path), false);
  try {
    assert.equal((await handle.stat()).mtimeMs, native.mtimeMs);
    const actual = await handle.stat({ bigint: true });
    assert.equal(actual.mtimeNs, precise.mtimeNs);
    assert.equal(actual.mtimeMs, precise.mtimeMs);
  } finally { await handle.close(); }
});

test('Windows exact-file grants allow only the selected object and clean up file ACLs', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const f = fixture(t), executable = join(f.host, 'probe.exe');
  const compiled = spawnSync(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', '/target:exe', '/platform:x64', `/out:${executable}`, fileURLToPath(new URL('./fixtures/SandboxWorker.cs', import.meta.url))], { windowsHide: true, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const acl = (path, directory = false) => {
    const r = spawnSync(executable, [directory ? 'acl' : 'file-acl', path], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const before = [acl(f.path), acl(f.sibling), acl(f.external, true), acl(executable)];
  for (const write of [false, true]) {
    const result = await runResourceManagedCommand({ executable, args: ['exact-file', f.path, f.sibling, join(f.external, 'new.txt')], cwd: f.work, timeoutMs: 10000,
      sandbox: { network: 'disabled', readableRoots: [], writableRoots: [], privateWorkingDirectory: true,
        readableFiles: [executable, ...(!write ? [f.path] : [])], writableFiles: write ? [f.path] : [], expectedIdentities: { [f.path]: identity(f.path) } } });
    assert.equal(result.exitCode, 0, result.stderr);
    const facts = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => line.split('=')));
    assert.equal(facts.targetRead, 'allowed'); assert.equal(facts.targetWrite, write ? 'allowed' : 'UnauthorizedAccessException');
    for (const key of ['siblingRead', 'siblingWrite', 'siblingCreate', 'parentList', 'targetDelete']) assert.notEqual(facts[key], 'allowed', JSON.stringify(facts));
    assert.deepEqual([acl(f.path), acl(f.sibling), acl(f.external, true), acl(executable)], before);
    assert.equal(readFileSync(f.sibling, 'utf8'), 'sibling secret'); assert.equal(existsSync(join(f.external, 'new.txt')), false);
  }
});

test('Linux exact-file mounts expose neither sibling files nor host parent directory entries', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t);
  const program = `const fs=require('fs');for(const [key,op] of Object.entries({read:()=>fs.readFileSync(process.argv[1]),sibling:()=>fs.readFileSync(process.argv[2]),create:()=>fs.writeFileSync(process.argv[2]+'.new','bad')})){try{op();console.log(key+'=allowed')}catch{console.log(key+'=denied')}}`;
  const result = await runResourceManagedCommand({ executable: process.execPath, args: ['-e', program, f.path, f.sibling], cwd: f.work, timeoutMs: 10000,
    sandbox: { network: 'disabled', readableRoots: [], writableRoots: [], readableFiles: [process.execPath, f.path], privateWorkingDirectory: true, expectedIdentities: { [f.path]: identity(f.path) } } });
  assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /read=allowed/); assert.match(result.stdout, /sibling=denied/); assert.match(result.stdout, /create=denied/);
});

test('file tools use isolated content I/O even when terminal sandbox configuration is off', async t => {
  const f = fixture(t, { commandSandbox: { mode: 'off', network: 'enabled', readableRoots: [], writableRoots: [] } });
  const originalOpen = SandboxFileHandle.open, policies = [];
  t.mock.method(SandboxFileHandle, 'open', async (...args) => { const handle = await originalOpen(...args); policies.push(handle.process.sandbox); return handle; });
  const originalRead = fs.readFile, originalWrite = fs.writeFile, originalOpenFile = fs.open;
  t.mock.method(fs, 'readFile', (path, ...args) => { assert.notEqual(path, f.path, 'no host content reads'); return originalRead(path, ...args); });
  t.mock.method(fs, 'writeFile', (path, ...args) => { assert.notEqual(path, f.path, 'no host content writes'); return originalWrite(path, ...args); });
  t.mock.method(fs, 'open', (path, ...args) => {
    if (process.platform !== 'linux' || !(args[0] & 0x200000)) assert.notEqual(path, f.path, 'existing content handles belong to the sandbox worker');
    return originalOpenFile(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const read = await f.run('read_file', { path: f.path, start_line: 1 });
    assert.equal(read.result.content, 'allowed'); assert.equal(read.result.sandbox.network, 'disabled');
    assert.equal(read.result.sandbox.backend, process.platform === 'win32' ? 'windows-appcontainer' : 'linux-bubblewrap');
    assert.equal((await f.run('edit_file', { path: f.path, old_text: 'allowed', new_text: 'edited' })).kind, 'returned');
    assert.equal(readFileSync(f.path, 'utf8'), 'edited');
    assert.ok(policies.length >= 3);
    for (const policy of policies) {
      assert.equal(policy.network, 'disabled'); assert.deepEqual(policy.writableRoots, []); assert.deepEqual(policy.readableRoots, []);
      assert.ok([...policy.readableFiles ?? [], ...policy.writableFiles ?? []].includes(f.path));
      assert.ok(![...policy.readableFiles ?? [], ...policy.writableFiles ?? []].includes(f.sibling));
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('the last revision check happens inside the sandbox before truncation', async t => {
  const f = fixture(t); await f.run('read_file', { path: f.path });
  const original = SandboxFileHandle.prototype.request;
  t.mock.method(SandboxFileHandle.prototype, 'request', async function(input) {
    if (input.op === 'open' && input.write) writeFileSync(f.path, 'new external revision');
    return original.call(this, input);
  });
  const result = await f.run('write_file', { path: f.path, content: 'must not overwrite' });
  assert.equal(result.error.code, 'workspace_revision_conflict'); assert.equal(readFileSync(f.path, 'utf8'), 'new external revision');
});

test('single-file search uses a read-only file grant, including for an approved external file', async t => {
  const f = fixture(t);
  const result = await f.run('search_file_content', { path: f.path, query: 'allowed' });
  assert.equal(result.kind, 'returned', JSON.stringify(result));
  assert.deepEqual(result.result.sandbox.readableRoots, []); assert.deepEqual(result.result.sandbox.writableRoots, []);
  assert.ok(result.result.sandbox.readableFiles.includes(f.path)); assert.ok(!result.result.sandbox.readableFiles.includes(f.sibling));
  assert.doesNotMatch(result.result.output, /sibling secret/);
});

test('missing sandbox backend rejects reads and searches, and cannot fall back to host content I/O', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t), previous = process.env.CARDBUSH_PROCESS_HOST_PATH;
  process.env.CARDBUSH_PROCESS_HOST_PATH = join(f.host, 'missing.exe');
  try {
    await assert.rejects(SandboxFileHandle.open(f.path, identity(f.path), false), error => /sandbox|host|spawn/i.test(error.message));
    const search = await f.run('search_file_content', { path: f.path, query: 'allowed' });
    assert.equal(search.kind, 'failed'); assert.equal(search.result, undefined);
    assert.equal(readFileSync(f.path, 'utf8'), 'allowed');
  } finally { if (previous === undefined) delete process.env.CARDBUSH_PROCESS_HOST_PATH; else process.env.CARDBUSH_PROCESS_HOST_PATH = previous; }
});

test('worker startup failure removes an exact-name reservation and preserves existing files', async t => {
  const f = fixture(t), newPath = join(f.external, 'new.txt');
  t.mock.method(SandboxFileHandle, 'open', async () => { throw Object.assign(Error('Sandbox is unavailable'), { code: 'sandbox_unavailable' }); });
  for (const path of [newPath, f.path]) {
    const result = await f.run('write_file', { path, content: 'must not be written' });
    assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'sandbox_unavailable');
  }
  assert.equal(existsSync(newPath), false); assert.equal(readFileSync(f.path, 'utf8'), 'allowed'); assert.equal(readFileSync(f.sibling, 'utf8'), 'sibling secret');
});

test('a missing configured rg never falls back to built-in host search', async t => {
  const f = fixture(t), previous = process.env.CARDBUSH_RG_PATH;
  process.env.CARDBUSH_RG_PATH = join(f.host, 'missing-rg');
  try { const result = await f.run('search_file_content', { path: f.path, query: 'allowed' }); assert.equal(result.error.code, 'workspace_search_unavailable'); assert.equal(result.result, undefined); }
  finally { if (previous === undefined) delete process.env.CARDBUSH_RG_PATH; else process.env.CARDBUSH_RG_PATH = previous; }
});

test('denied sandbox process creation never retries rg or file content access on the host', async t => {
  const f = fixture(t), original = childProcess.spawn;
  let refused = 0;
  t.mock.method(childProcess, 'spawn', (executable, args, options) => {
    if (args.includes('--sandbox') || process.platform === 'linux' && String(executable).endsWith('/bwrap')) {
      refused++; throw Object.assign(Error('Fixture sandbox launch denied'), { code: 'EACCES' });
    }
    return original(executable, args, options);
  });
  syncBuiltinESMExports();
  try {
    for (const [name, input] of [['read_file', { path: f.path }], ['search_file_content', { path: f.path, query: 'allowed' }]]) {
      const result = await f.run(name, input); assert.equal(result.kind, 'failed', JSON.stringify(result)); assert.equal(result.result, undefined);
    }
    assert.ok(refused >= 2); assert.equal(readFileSync(f.path, 'utf8'), 'allowed');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('new external files receive exact grants and keep sibling content private', async t => {
  const f = fixture(t), path = join(f.external, 'nested', 'created.txt');
  const original = SandboxFileHandle.open, grants = [];
  t.mock.method(SandboxFileHandle, 'open', async (...args) => { const handle = await original(...args); grants.push(handle.process.sandbox); return handle; });
  const result = await f.run('write_file', { path, content: 'created in sandbox' });
  assert.equal(result.kind, 'returned', JSON.stringify(result)); assert.equal(readFileSync(path, 'utf8'), 'created in sandbox');
  assert.equal(readFileSync(f.sibling, 'utf8'), 'sibling secret');
  for (const grant of grants) { assert.deepEqual(grant.writableRoots, []); assert.deepEqual(grant.readableRoots, []); }
  assert.ok(grants.some(grant => grant.writableFiles?.includes(path)));
});

test('an identity mismatch never returns bytes, and worker termination cannot produce a successful result', async t => {
  const f = fixture(t);
  await assert.rejects(SandboxFileHandle.open(f.path, '0:0', false));
  const handle = await SandboxFileHandle.open(f.path, identity(f.path), false);
  handle.process.stop(); await handle.process.complete();
  await assert.rejects(handle.request({ op: 'read', offset: 0, count: 64 })); await handle.close();
});

test('file mutation refuses hard-link aliases that would update another path', async t => {
  const f = fixture(t); linkSync(f.path, join(f.work, 'alias.txt')); await f.run('read_file', { path: f.path });
  const result = await f.run('write_file', { path: f.path, content: 'unsafe alias update' });
  assert.equal(result.error.code, 'workspace_authorization_changed'); assert.equal(readFileSync(f.path, 'utf8'), 'allowed');
});

test('terminal file extensions approve exact files and invalidate the grant on same-name replacement', async t => {
  const f = fixture(t);
  const config = { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] };
  const context = { sessionId: 's', input: { command: 'echo fixture', shell: process.platform === 'win32' ? 'cmd' : 'posix',
    additionalPermissions: decodeAdditionalCommandPermissions({ read_files: [f.path] }) }, turn: { request: f.request } };
  const admitted = await commandSandboxPlan(config, context, f.work);
  assert.equal(admitted.admission.kind, 'ask'); assert.deepEqual(admitted.policy.readableFiles, [f.path]);
  assert.ok(!admitted.policy.readableRoots.includes(f.external));
  assert.equal(authorizedCommandSandbox(admitted, [admitted.requiredGrant]), admitted.policy);
  renameSync(f.path, join(f.external, 'previous.txt')); writeFileSync(f.path, 'replacement');
  const changed = await commandSandboxPlan(config, context, f.work);
  assert.throws(() => authorizedCommandSandbox(changed, [admitted.requiredGrant]), { code: 'sandbox_approval_changed' });
  const required = await commandSandboxPlan({ ...config, mode: 'required' }, context, f.work);
  assert.equal(required.admission.kind, 'deny'); assert.equal(required.admission.code, 'sandbox_host_limit');
});
