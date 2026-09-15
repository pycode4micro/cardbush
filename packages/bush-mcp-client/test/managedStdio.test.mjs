import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';
import { ManagedStdioClientTransport, stdioEnvironment } from '../dist/managedStdio.js';

const windows = { skip: process.platform !== 'win32', timeout: 15_000 };
const snapshot = transport => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'stdio-errors', revision: 1,
  servers: [{ id: 'fixture', startupTimeoutMs: 5_000, transport: { kind: 'stdio', ...transport } }] });

test('Windows environment preserves command essentials and applies case-insensitive overrides', windows, () => {
  const env = stdioEnvironment({ Path: 'fixture-path', pAtHeXt: '.CMD;.EXE', temp: 'fixture-temp', Example: 'first', EXAMPLE: 'last' });
  assert.equal(env.PATH, 'fixture-path');
  assert.equal(env.PATHEXT, '.CMD;.EXE');
  assert.equal(env.TEMP, 'fixture-temp');
  assert.equal(env.EXAMPLE, 'last');
  assert.equal(Object.keys(env).filter(key => key.toUpperCase() === 'PATH').length, 1);
  for (const key of ['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TMP']) {
    assert.equal(stdioEnvironment()[key], process.env[key]);
  }
  assert.equal(stdioEnvironment({ PATHEXT: '' }).PATHEXT, '', 'explicit empty values are not silently replaced');
});

test('POSIX environment names remain case-sensitive', { skip: process.platform === 'win32' }, () => {
  const env = stdioEnvironment({ PATH: '/one', Path: '/two', PATHEXT: '' });
  assert.equal(env.PATH, '/one'); assert.equal(env.Path, '/two');
});

test('Windows PowerShell finds and runs a bare command from a mixed-case Path override', windows, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'cardbush-stdio-env-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith('cardbush-stdio-env-'));
    await rm(dir, { recursive: true, force: true });
  });
  const launcher = join(dir, 'command with spaces.cmd');
  await writeFile(launcher, '@echo off\r\necho command-ran\r\n');
  const script = "$ErrorActionPreference = 'Stop'; "
    + "$command = Get-Command 'command with spaces' -CommandType Application; "
    + "[Console]::Error.WriteLine('resolved=' + [IO.Path]::GetExtension($command.Source)); "
    + "[Console]::Error.WriteLine('result=' + (& $command.Source)); "
    + "[Console]::Error.WriteLine('systemRoot=' + [bool]$env:SYSTEMROOT)";
  const transport = new ManagedStdioClientTransport({
    command: join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], env: { Path: dir }, cwd: dir,
  });
  let output = '', timer;
  transport.stderr.on('data', chunk => { output += chunk.toString(); });
  const finished = new Promise((resolve, reject) => {
    transport.onclose = resolve;
    timer = setTimeout(() => reject(Error('Command probe did not finish')), 5_000);
  });
  try { await transport.start(); await finished; }
  finally { clearTimeout(timer); await transport.close(); }
  assert.match(output, /resolved=\.cmd/i);
  assert.match(output, /result=command-ran/);
  assert.match(output, /systemRoot=True/);
});

test('startup failure reports the process exit and bounded UTF-8 stderr instead of a handshake symptom', { timeout: 15_000 }, async t => {
  const messages = [];
  const manager = new McpClientManager({ registry: new ToolRegistry(), onServerStderr: entry => messages.push(entry.message) });
  t.after(() => manager.close());
  const code = `process.stderr.write('x'.repeat(20000));
    const bytes=Buffer.from('缺少运行依赖：fixture');
    process.stderr.write(bytes.subarray(0,2));
    setTimeout(()=>{process.stderr.write(bytes.subarray(2));process.exitCode=17},30);`;
  const result = await manager.apply(snapshot({ command: process.execPath, args: ['-e', code] }));
  const failed = result.servers[0];
  assert.equal(failed.health, 'unavailable');
  assert.equal(failed.restartAttempts, 0);
  assert.match(failed.lastError, /exited with code 17/);
  assert.match(failed.lastError, /缺少运行依赖：fixture/);
  assert.ok(failed.lastError.length < 8_400);
  assert.doesNotMatch(failed.lastError, /version negotiation|�/i);
  assert.match(messages.join(''), /缺少运行依赖：fixture/);
});

test('a missing command reports its launch error rather than only a closed connection', { timeout: 15_000 }, async t => {
  const manager = new McpClientManager({ registry: new ToolRegistry() });
  t.after(() => manager.close());
  const result = await manager.apply(snapshot({ command: 'cardbush-command-that-does-not-exist-8d740' }));
  assert.equal(result.servers[0].health, 'unavailable');
  assert.match(result.servers[0].lastError, /ENOENT/);
  assert.equal(result.servers[0].restartAttempts, 0);
});
