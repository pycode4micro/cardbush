import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { powerShellExecutable } from '@cardbush/platform';
import { TerminalSessionManager, ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';

const alias = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe') : undefined;
let storeInstalled = false;
try { storeInstalled = Boolean(alias && fs.lstatSync(alias).isSymbolicLink() && fs.statSync(fs.readlinkSync(alias)).isFile()); } catch { /* Optional Store installation. */ }

test('installed Store PowerShell runs on the host and sandbox launch failures never bypass isolation', { skip: !storeInstalled, timeout: 60000 }, async t => {
  const base = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(base, 'cardbush-pwsh-store-')));
  const work = join(root, 'work'), outside = join(root, 'outside');
  const terminals = new TerminalSessionManager();
  const keys = Object.keys(process.env).filter(key => /^(path|programfiles|cardbush_terminal_shell)$/i.test(key));
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(async () => {
    delete process.env.PATH; Object.assign(process.env, previous);
    await terminals.close();
    assert.equal(dirname(root).toLowerCase(), base.toLowerCase());
    assert.ok(basename(root).startsWith('cardbush-pwsh-store-'));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(work); await mkdir(outside);
  await writeFile(join(outside, 'private.txt'), 'outside-fixture');
  // No Codex/private runtime or MSI fallback can satisfy discovery in this test.
  for (const key of keys) delete process.env[key];
  process.env.PATH = dirname(alias);
  const executable = powerShellExecutable();
  assert.equal(executable, fs.readlinkSync(alias));
  // Restore ProgramFiles solely for the normal interpreter-root admission policy.
  for (const [key, value] of Object.entries(previous)) if (/^programfiles$/i.test(key)) process.env[key] = value;

  const registry = new ToolRegistry();
  registerWorkspaceTools(registry, undefined, { terminals,
    commandSandbox: { mode: 'auto', network: 'disabled', readableRoots: [], writableRoots: [] } });
  let approvals = 0, serial = 0;
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => {
    approvals++; throw new Error('the fixture must never expand its sandbox');
  } } });
  const run = async (command, permissionMode = 'task_free') => {
    const identity = { requestId: 'store-r', sessionId: 'store-s', turnId: 'store-t', round: 1, ordinal: ++serial };
    const outcome = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: `store-${serial}`, name: 'terminal_exec',
      argumentsText: JSON.stringify({ command, cwd: work, shell: 'powershell', yield_time_ms: 1000 }) }, identity, undefined,
    { contextMessages: [], request: { protocol: 'bush.model_request.v1', ...identity, model: 'fixture', messages: [], tools: registry.definitions(),
      permissionMode, metadata: { workspaceDir: work } } });
    assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
    let result = outcome.result;
    if (result.state === 'running') result = await terminals.waitForCompletion(identity.sessionId, result.terminalSessionId, AbortSignal.timeout(30000));
    assert.equal(result.shellExecutable, executable);
    return result;
  };
  const direct = await run('$PSVersionTable.PSVersion.ToString()', 'all_free');
  assert.equal(direct.exitCode, 0, JSON.stringify(direct));
  assert.equal(direct.commandStarted, true);
  assert.match(direct.stdout, /^7\./);
  assert.equal(direct.sandbox, null);

  const isolated = await run("Set-Content -LiteralPath './inside.txt' -Value 'inside-fixture' -ErrorAction Stop; $PSVersionTable.PSVersion.ToString()");
  assert.equal(isolated.sandbox.backend, 'windows-appcontainer');
  assert.equal(isolated.sandbox.network, 'disabled');
  assert.deepEqual(isolated.sandbox.writableRoots, [work]);
  assert.deepEqual(isolated.sandbox.readableRoots, []);
  if (isolated.commandStarted === false) {
    // The current AppContainer setup can reject a packaged launch. This is
    // distinct from discovery or a missing install; preserve the native evidence.
    assert.equal(isolated.nativeErrorCode, 87, JSON.stringify(isolated));
    assert.equal(isolated.state, 'failed');
    assert.equal(isolated.environmentDiagnostic.availability, 'shell_launch_failed');
    assert.equal(isolated.environmentDiagnostic.installation, 'executable_found_on_host');
    assert.equal(isolated.environmentDiagnostic.access_granted, false);
    assert.match(isolated.environmentDiagnostic.next_step, /Keep isolation enabled/);
    await assert.rejects(readFile(join(work, 'inside.txt')), { code: 'ENOENT' });
    assert.equal(approvals, 0);
    t.diagnostic('Host launch succeeded; Windows rejected Store launch in AppContainer with error 87, with no command execution or fallback.');
    return;
  }
  assert.equal(isolated.exitCode, 0, JSON.stringify(isolated));
  assert.match(isolated.stdout, /^7\./);
  assert.equal((await readFile(join(work, 'inside.txt'), 'utf8')).trim(), 'inside-fixture');
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  const denied = await run(`Get-Content -LiteralPath ${quote(join(outside, 'private.txt'))} -ErrorAction Stop`);
  assert.notEqual(denied.exitCode, 0);
  assert.equal(denied.shellDiagnostic.permissionDenied, true);
  assert.doesNotMatch(denied.stdout, /outside-fixture/);
  assert.deepEqual(denied.sandbox.writableRoots, [work]);
  assert.equal(approvals, 0);
});
