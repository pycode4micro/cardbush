import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { windowsSftpPath, windowsShellPath, sshWorkspace, parseSshWorkspace } from '@cardbush/bush-protocol';
import { windowsTerminalCommand, windowsTerminalInput, windowsStopCommand, powershellQuote } from '../dist-electron/sshShell.mjs';

test('Windows SSH separates native drive paths, SFTP identities and virtual roots', () => {
  for (const path of ['C:\\Users\\fixture', 'C:/Users/fixture', '/C:/Users/fixture']) {
    assert.equal(windowsSftpPath(path), '/C:/Users/fixture');
    assert.equal(windowsShellPath(path), 'C:\\Users\\fixture');
    assert.equal(parseSshWorkspace(sshWorkspace('fixture', path)).path, '/C:/Users/fixture');
  }
  assert.equal(windowsShellPath('/D:/'), 'D:\\');
  assert.equal(windowsSftpPath('目录\\file.txt'), '目录/file.txt');
  for (const path of ['/', 'C:relative', '\\\\server\\share', '\\\\?\\C:\\Users', '/C:/file:stream', '/C:/file:/stream', '/C:/bad\npath']) {
    assert.throws(() => windowsShellPath(path));
  }
});

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-ssh-shell-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(root.includes('cardbush-ssh-shell-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const cwd = join(root, "项目 O'Brien & space"); await mkdir(cwd); return cwd;
}
function spawnControl(command) {
  const child = spawn('pwsh.exe', command.slice('pwsh.exe '.length).split(' '), { windowsHide: true, stdio: 'pipe' });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}
function launch(t, cwd, command, shell = 'powershell', release = true) {
  const job = 'Global\\CardBushSsh_' + randomUUID().replaceAll('-', ''), marker = 'CARDBUSH_PID_' + randomUUID().replaceAll('-', '') + ':', startToken = randomUUID();
  const invocation = windowsTerminalCommand({ cwd, shell, job, marker, startToken });
  assert.ok(invocation.command.length < 8191);
  const process = spawnControl(invocation.command);
  let pending = '', ready;
  const started = new Promise(resolve => { ready = resolve; });
  process.child.stderr.on('data', value => {
    pending += value;
    if (pending.includes(marker) && ready) {
      if (release) process.child.stdin.write(windowsTerminalInput(command, shell, startToken));
      ready(); ready = undefined;
    }
  });
  process.child.stdin.write(invocation.prelude);
  const deadline = setTimeout(() => { void spawnControl(windowsStopCommand(job)).completed; }, 12_000);
  process.completed.then(() => clearTimeout(deadline), () => clearTimeout(deadline));
  t.after(async () => { if (process.child.exitCode === null) await spawnControl(windowsStopCommand(job)).completed; });
  return { ...process, started, job };
}
const win = { skip: process.platform !== 'win32', timeout: 30_000 };

test('actual Windows launcher preserves cwd, Unicode, exit codes and large command payloads', win, async t => {
  const cwd = await directory(t);
  const command = `$value = '${'x'.repeat(30_000)}'; [Console]::WriteLine($value.Length); [Console]::WriteLine((Get-Location).Path); [Console]::WriteLine('中文'); exit 7`;
  const process = launch(t, cwd, command);
  const result = await process.completed;
  assert.equal(result.code, 7, result.stderr);
  assert.ok(result.stdout.includes(cwd)); assert.match(result.stdout, /30000/); assert.match(result.stdout, /中文/);
});

test('actual Windows cmd uses its native syntax and UTF-8 output', win, async t => {
  const cwd = await directory(t);
  const process = launch(t, cwd, 'echo 中文 & echo "%CD%" & exit /b 9', 'cmd');
  const result = await process.completed;
  assert.equal(result.code, 9, result.stderr);
  assert.ok(result.stdout.includes(cwd), JSON.stringify({ cwd, result })); assert.match(result.stdout, /中文/);
});

test('actual Windows SSH PowerShell shares local cmdlet status and recovery semantics', win, async t => {
  const cwd = await directory(t);
  for (const [command, code] of [
    ["Get-Item -LiteralPath './missing'", 1],
    ["Get-Item -LiteralPath './missing'; Write-Output 'recovered'", 0],
    ["Write-Output 'ok' # trailing comment", 0],
    ["throw 'fixture failure'", 1],
  ]) {
    const result = await launch(t, cwd, command).completed;
    assert.equal(result.code, code, JSON.stringify({ command, result }));
  }
});

test('actual Windows launcher keeps interactive stdin available after the startup gate', win, async t => {
  const cwd = await directory(t);
  const process = launch(t, cwd, "[Console]::WriteLine('READY'); [Console]::WriteLine([Console]::ReadLine())");
  process.child.stdout.on('data', value => { if (value.includes('READY')) process.child.stdin.write('用户输入\n'); });
  const result = await process.completed;
  assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /用户输入/);
});

test('actual Windows cmd keeps interactive stdin available and native PowerShell output stays UTF-8', win, async t => {
  const cwd = await directory(t);
  const interactive = launch(t, cwd, 'set /p value=READY & call echo %%value%%', 'cmd');
  interactive.child.stdout.on('data', value => { if (value.includes('READY')) interactive.child.stdin.write('用户输入\r\n'); });
  const input = await interactive.completed;
  assert.equal(input.code, 0, input.stderr); assert.match(input.stdout, /用户输入/);
  const native = launch(t, cwd, "& $env:ComSpec /d /c 'echo 中文'");
  const output = await native.completed;
  assert.equal(output.code, 0, output.stderr); assert.match(output.stdout, /中文/);
});

test('actual Windows Job stops its descendants and verifies the job is empty', win, async t => {
  const cwd = await directory(t);
  const command = `$child = New-Object Diagnostics.Process; $child.StartInfo.FileName = ${powershellQuote(process.execPath)}; $child.StartInfo.Arguments = '-e "setInterval(()=>{},1000)"'; $child.StartInfo.UseShellExecute = $false; $child.StartInfo.CreateNoWindow = $true; [void]$child.Start(); [Console]::WriteLine('CHILD=' + $child.Id); $child.WaitForExit()`;
  const running = launch(t, cwd, command);
  let childPid;
  const created = new Promise(resolve => running.child.stdout.on('data', value => {
    const match = /CHILD=(\d+)/.exec(value); if (match) { childPid = Number(match[1]); resolve(); }
  }));
  await Promise.race([created, running.completed.then(result => { throw Error(JSON.stringify(result)); })]);
  const stopped = await spawnControl(windowsStopCommand(running.job)).completed;
  assert.equal(stopped.code, 0, stopped.stderr); assert.match(stopped.stdout, /CARDBUSH_STOPPED_V1/);
  await running.completed;
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});

test('actual Windows startup EOF executes no command and a missing job is safe to stop', win, async t => {
  const cwd = await directory(t);
  const running = launch(t, cwd, "[Console]::WriteLine('MUST_NOT_RUN')", 'powershell', false);
  await Promise.race([running.started, running.completed.then(result => { throw Error(JSON.stringify(result)); })]);
  running.child.stdin.end();
  const result = await running.completed;
  assert.equal(result.code, 125, result.stderr); assert.doesNotMatch(result.stdout, /MUST_NOT_RUN/);
  const stopped = await spawnControl(windowsStopCommand(running.job)).completed;
  assert.equal(stopped.code, 0, stopped.stderr);
});

test('actual Windows wrapper exit releases its job and cleans up outstanding child processes', win, async t => {
  const cwd = await directory(t);
  const command = `$child = New-Object Diagnostics.Process; $child.StartInfo.FileName = ${powershellQuote(process.execPath)}; $child.StartInfo.Arguments = '-e "setInterval(()=>{},1000)"'; $child.StartInfo.UseShellExecute = $false; $child.StartInfo.CreateNoWindow = $true; [void]$child.Start(); [Console]::WriteLine('CHILD=' + $child.Id)`;
  const running = launch(t, cwd, command);
  const result = await running.completed;
  assert.equal(result.code, 0, result.stderr);
  const childPid = Number(/CHILD=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
});
