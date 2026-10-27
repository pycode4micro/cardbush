import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { InMemoryRuntimeCapabilityStore, TerminalSessionManager, ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';
import { prepareExecutionSandbox, resolveLinuxSandboxExecutable } from '../dist/executionSandbox.js';

const windows = process.platform === 'win32';
const quote = value => windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const write = (path, content) => windows ? `Set-Content -LiteralPath ${quote(path)} -Value ${quote(content)} -ErrorAction Stop` : `printf '%s' ${quote(content)} > ${quote(path)}`;
const read = path => windows ? `Get-Content -LiteralPath ${quote(path)} -ErrorAction Stop` : `cat ${quote(path)}`;

test('a command installed outside the sandbox is diagnosed without host execution or automatic permission expansion', { skip: !windows, timeout: 60000 }, async t => {
  const base = await realpath(tmpdir()), folder = await realpath(await mkdtemp(join(base, 'cardbush-command-diagnostic-')));
  const work = join(folder, 'work'), tools = join(folder, 'tools'), marker = join(work, 'must-not-exist.txt');
  await mkdir(work); await mkdir(tools);
  const name = 'cardbush_diagnostic_fixture', executable = join(tools, name + '.cmd');
  await writeFile(executable, `@echo off\r\necho should-not-run>"${marker}"\r\n`);
  const key = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH', original = process.env[key];
  process.env[key] = `${tools};${original ?? ''}`;
  const terminals = new TerminalSessionManager();
  t.after(async () => {
    if (original === undefined) delete process.env[key]; else process.env[key] = original;
    await terminals.close(); assert.equal(dirname(folder).toLowerCase(), base.toLowerCase()); await rm(folder, { recursive: true, force: true });
  });
  let result = await terminals.start({ ownerSessionId: 'diagnostic', command: name, cwd: work, shell: 'powershell', yieldTimeMs: 1000,
    sandbox: { readableRoots: [], writableRoots: [work], network: 'disabled' } });
  if (result.state === 'running') result = await terminals.waitForCompletion('diagnostic', result.terminalSessionId, AbortSignal.timeout(45000));
  assert.equal(result.state, 'exited'); assert.notEqual(result.exitCode, 0);
  assert.equal(result.shellDiagnostic.commandName, name);
  assert.equal(result.environmentDiagnostic.host_command.status, 'found');
  assert.equal(result.environmentDiagnostic.installation, 'executable_found_on_host');
  assert.equal(result.environmentDiagnostic.access_granted, false);
  assert.deepEqual(result.sandbox.readableRoots, []); assert.deepEqual(result.sandbox.writableRoots, [work]);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('real sandbox execution and exact approvals preserve file boundaries and full access', { skip: !['linux', 'win32'].includes(process.platform), timeout: 60_000 }, async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-sandbox-live-')));
  const work = join(folder, 'work'), outside = join(folder, 'outside');
  await Promise.all([mkdir(work), mkdir(outside)]);
  const terminals = new TerminalSessionManager();
  t.after(async () => { await terminals.stopWithin(folder); assert.equal(dirname(folder).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); await rm(folder, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), prompts = [];
  registerWorkspaceTools(registry, undefined, { terminals, commandSandbox: { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] } });
  let decision = 'allow_once', serial = 0;
  const coordinator = new ToolExecutionCoordinator({ registry, capabilities: new InMemoryRuntimeCapabilityStore(), permissions: { request: async request => {
    prompts.push(request); return { protocol: 'bush.runtime_permission_answer.v1', permissionId: `p-${prompts.length}`, answerId: 'answer', decision,
      grantedCapabilityIds: decision === 'deny' ? [] : request.capabilityIds };
  } } });
  const run = async (command, additional, mode = 'task_free', shell = windows ? 'powershell' : 'posix') => {
    const identity = { requestId: 'r', sessionId: 'owner', turnId: 't', round: 1, ordinal: ++serial };
    const turn = { contextMessages: [], request: { protocol: 'bush.model_request.v1', ...identity, model: 'fixture', messages: [], tools: registry.definitions(), permissionMode: mode, metadata: { workspaceDir: work } } };
    const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${serial}`, name: 'terminal_exec', argumentsText: JSON.stringify({ command, cwd: work,
      shell, yield_time_ms: 30000, ...(additional ? { additional_permissions: additional } : {}) }) }, identity, undefined, turn);
    if (result.kind === 'returned') assert.notEqual(result.result.state, 'running', 'short fixture commands must finish within the yield');
    return result;
  };
  const inside = await run(write(join(work, 'normal.txt'), 'inside'));
  assert.equal(inside.kind, 'returned', JSON.stringify(inside));
  assert.equal(inside.result.exitCode, 0, JSON.stringify(inside.result));
  assert.equal(inside.result.sandbox.network, 'disabled'); assert.equal(prompts.length, 0);
  assert.equal((await readFile(join(work, 'normal.txt'), 'utf8')).trim(), 'inside');
  if (windows) {
    const located = await run("(Get-Location).ProviderPath; Get-Content -LiteralPath './normal.txt'");
    assert.equal(located.result.exitCode, 0, JSON.stringify(located.result));
    assert.match(located.result.stdout, /inside/);
    assert.ok(located.result.stdout.includes(work), 'provider cwd must match the requested process cwd');
    assert.equal(located.result.commandStarted, true);
    assert.equal(located.result.cwd, work);
  }
  if (windows) assert.equal((await run('echo automatic-cmd', undefined, 'task_free', 'cmd')).result.exitCode, 0);

  const target = join(outside, 'target.txt');
  const blocked = await run(write(target, 'blocked'));
  assert.notEqual(blocked.result.exitCode, 0);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal(prompts.length, 0, 'no automatic retry outside isolation');
  if (windows) {
    const hiddenPath = join(outside, 'hidden.txt'); await writeFile(hiddenPath, 'outside fixture');
    const hidden = await run(`Get-Content -LiteralPath ${quote(hiddenPath)} -ErrorAction SilentlyContinue`);
    assert.equal(hidden.result.exitCode, 1);
    assert.equal(hidden.result.stdout, ''); assert.equal(hidden.result.stderr, '');
    assert.equal(hidden.result.shellDiagnostic.permissionDenied, true);
    assert.equal(hidden.resultError.kind, 'permission');
    assert.equal(hidden.resultError.code, 'terminal_permission_denied');
    assert.equal(hidden.execution.effects, 'possible', 'shell error telemetry never proves no effects');
    assert.equal(hidden.execution.recovery, 'do_not_retry');
    assert.deepEqual(hidden.result.sandbox.writableRoots, [work]);
    const ordinary = await run('exit 1');
    assert.equal(ordinary.resultError.code, 'terminal_command_failed');
    assert.equal(ordinary.result.shellDiagnostic, undefined, 'empty stderr alone is not a permission signal');
  }

  const granted = await run(write(target, 'approved'), { write_roots: [outside] });
  assert.equal(granted.result.exitCode, 0, JSON.stringify(granted.result));
  assert.ok(granted.result.sandbox, 'approval expands scope without removing isolation');
  assert.equal(prompts.length, 1);
  assert.equal((await readFile(target, 'utf8')).trim(), 'approved');
  assert.notEqual((await run(write(target, 'leaked'))).result.exitCode, 0);
  assert.equal((await readFile(target, 'utf8')).trim(), 'approved', 'next command does not inherit the expanded scope');

  const readonly = await run(read(target), { read_roots: [outside] });
  assert.equal(readonly.result.exitCode, 0); assert.match(readonly.result.stdout, /approved/);
  assert.notEqual((await run(write(target, 'readonly-write'), { read_roots: [outside] })).result.exitCode, 0);
  assert.equal((await readFile(target, 'utf8')).trim(), 'approved');
  decision = 'deny';
  assert.equal((await run(write(target, 'denied'), { write_roots: [outside] })).error.code, 'permission_rejected');
  assert.equal((await readFile(target, 'utf8')).trim(), 'approved');
  const before = prompts.length;
  const full = await run(write(target, 'full'), undefined, 'all_free');
  assert.equal(full.result.exitCode, 0); assert.equal(full.result.sandbox, null);
  assert.equal((await readFile(target, 'utf8')).trim(), 'full'); assert.equal(prompts.length, before);
});

test('Linux backend discovery follows a trusted host PATH or explicit override and rejects writable substitutes', { skip: process.platform !== 'linux' }, async t => {
  const executable = await resolveLinuxSandboxExecutable();
  assert.equal(await resolveLinuxSandboxExecutable(executable, ''), executable);
  assert.equal(await resolveLinuxSandboxExecutable(undefined, dirname(executable)), executable);
  await assert.rejects(resolveLinuxSandboxExecutable(undefined, '.:relative'), { code: 'sandbox_unavailable' });
  const folder = await mkdtemp(join(tmpdir(), 'cardbush-backend-test-'));
  t.after(async () => { assert.equal(dirname(folder), resolve(tmpdir())); await rm(folder, { recursive: true, force: true }); });
  const fake = join(folder, 'bwrap'); await writeFile(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await assert.rejects(resolveLinuxSandboxExecutable(fake), { code: 'sandbox_unavailable' });
});

test('backend setup cannot silently recanonicalize an already-approved directory', { skip: !['linux', 'win32'].includes(process.platform) }, async t => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-scope-test-')));
  t.after(async () => { assert.equal(dirname(folder).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); await rm(folder, { recursive: true, force: true }); });
  const work = join(folder, 'work'), other = join(folder, 'other'), changed = join(folder, 'changed');
  await Promise.all([mkdir(work), mkdir(other)]); await symlink(other, changed, 'junction');
  await assert.rejects(prepareExecutionSandbox({ executable: process.execPath, args: [], cwd: work,
    policy: { writableRoots: [work], readableRoots: [changed], network: 'disabled', requireCanonicalRoots: true } }), { code: 'sandbox_approval_changed' });
});
