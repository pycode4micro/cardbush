import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { createPlatformContext, findExecutable, terminalInvocation, commandInvocation, defaultTerminalRuntime, normalizeTerminalRuntime, platformFeatures, bundledToolPath, terminalRuntimes, localPath, decodeCommandOutput } from '../dist/index.js';

test('Windows output decoding preserves Unicode cmd built-ins and native UTF-8/legacy output', () => {
  for (const text of ['中文目录.txt\r\n', '中文\r\n', 'plain\r\n']) {
    assert.equal(decodeCommandOutput(Buffer.from(text, 'utf16le'), 'win32'), text);
    assert.equal(decodeCommandOutput(Buffer.from(text, 'utf8'), 'win32'), text);
  }
  assert.equal(decodeCommandOutput(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'win32'), '中文');
  assert.equal(decodeCommandOutput(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]), 'win32'), '中文');
  assert.equal(decodeCommandOutput(Buffer.from('plain\n'), 'linux'), 'plain\n');
});

test('file URLs retain native separators, Unicode, escaped punctuation and UNC shares', () => {
  assert.equal(localPath('file:///home/user/a%20b/%E4%B8%AD%E6%96%87%23.txt', 'linux'), '/home/user/a b/中文#.txt');
  assert.equal(localPath('file:///C:/a%20b/%E4%B8%AD%E6%96%87.txt', 'win32'), 'C:\\a b\\中文.txt');
  assert.equal(localPath('file://server/share/a%20b.txt', 'win32'), '\\\\server\\share\\a b.txt');
  assert.equal(localPath('/home/user/a b.txt', 'linux'), '/home/user/a b.txt');
  assert.equal(localPath('file:///invalid%ZZ', 'linux'), 'file:///invalid%ZZ');
});

function context(platform, files = [], env = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalized = new Set(files.map(file => platform === 'win32' ? file.toLowerCase() : file));
  return createPlatformContext({ platform, arch: 'x64', env,
    isExecutable: file => normalized.has(platform === 'win32' ? pathApi.normalize(file).toLowerCase() : pathApi.normalize(file)) });
}
test('Linux defaults to a native shell without PowerShell, WSL, or Windows tools', () => {
  const linux = context('linux', ['/bin/bash', '/bin/sh'], { SHELL:'/bin/bash',PATH:'/bin' });
  assert.equal(defaultTerminalRuntime('linux'), 'bash');
  assert.deepEqual(terminalRuntimes(linux), ['bash']);
  assert.deepEqual(terminalInvocation(undefined, undefined, undefined, linux), {command:'/bin/bash',args:[]});
  assert.deepEqual(terminalInvocation('wsl', undefined, undefined, linux), {command:'/bin/bash',args:[]});
  assert.equal(normalizeTerminalRuntime('git_bash', 'linux'), 'bash');
  assert.equal(terminalInvocation('powershell', undefined, undefined, linux).command, '/bin/bash');
});
test('PowerShell on Linux is explicit and only discovered through executable PATH entries', () => {
  const linux=context('linux', ['/bin/bash','/usr/bin/pwsh'], {PATH:'/missing:/usr/bin', SHELL:'/bin/bash'});
  assert.equal(findExecutable('pwsh',linux), '/usr/bin/pwsh');
  assert.deepEqual(terminalRuntimes(linux), ['bash','powershell']);
  assert.equal(terminalInvocation('powershell',undefined,undefined,linux).command,'/usr/bin/pwsh');
  assert.equal(findExecutable('where.exe',linux),undefined);
});
test('Windows PATH and Git installations tolerate spaces, Unicode, and case variations', () => {
  const windows=context('win32',['C:\\工具 空间\\pwsh.exe','D:\\Git Tools\\cmd\\git.exe','D:\\Git Tools\\bin\\bash.exe'],
    {Path:'"C:\\工具 空间";D:\\Git Tools\\cmd', PATHEXT:'.EXE;.CMD'});
  assert.equal(findExecutable('pwsh',windows),'C:\\工具 空间\\pwsh.EXE');
  assert.equal(terminalInvocation('powershell',undefined,undefined,windows).command,'C:\\工具 空间\\pwsh.exe');
  assert.equal(terminalInvocation('git_bash',undefined,undefined,windows).command,'D:\\Git Tools\\bin\\bash.exe');
  assert.equal(defaultTerminalRuntime('win32'),'powershell');
});
test('commands and paths remain separate arguments and keep literal metacharacters', () => {
  const command='printf "%s" "中文; $HOME && `whoami`"';
  const cwd='C:\\项目 空间\\$(bad)';
  const windows=context('win32');
  assert.deepEqual(terminalInvocation('wsl',cwd,command,windows),{command:'wsl.exe',args:['--cd',cwd,'--','sh','-lc',command]});
  const linux=context('linux',['/bin/sh']);
  assert.deepEqual(commandInvocation('posix',command,linux),{executable:'/bin/sh',args:['-c',command]});
  assert.throws(()=>commandInvocation('cmd',command,linux),/unavailable/);
  assert.throws(()=>commandInvocation('powershell',command,linux),/unavailable/);
});
test('a custom shell is an executable path, never parsed as a command string', () => {
  const linux=context('linux',['/bin/sh','/tools/终端 shell'],{CARDBUSH_TERMINAL_SHELL:'/tools/终端 shell'});
  assert.equal(terminalInvocation(undefined,undefined,undefined,linux).command,'/tools/终端 shell');
  const invalid=context('linux',['/bin/sh'],{CARDBUSH_TERMINAL_SHELL:'sh -c unsafe'});
  assert.throws(()=>terminalInvocation(undefined,undefined,undefined,invalid),/executable/);
  assert.equal(findExecutable('tool',context('linux',['tool'],{PATH:':'})),undefined);
});
test('resource paths and advertised native features are tied to platform and architecture', () => {
  assert.equal(bundledToolPath('/bundle','ripgrep','linux','x64'),'/bundle/runtime-tools/ripgrep/linux-x64/rg');
  assert.equal(bundledToolPath('C:\\bundle','ripgrep','win32','x64'),'C:\\bundle\\runtime-tools\\ripgrep\\win32-x64\\rg.exe');
  assert.equal(bundledToolPath('/bundle','ripgrep','linux','arm64'),undefined);
  assert.equal(platformFeatures('linux','x64').computerUse,false);
  assert.equal(platformFeatures('linux','x64').nativeProcessLimits,false);
  assert.equal(platformFeatures('win32','x64').nativeProcessLimits,true);
  assert.equal(platformFeatures('win32','arm64').nativeProcessLimits,false);
});
test('CommonJS desktop entry and ESM runtime entry expose the same contract', () => {
  const cjs=createRequire(import.meta.url)('../dist-cjs/index.js');
  assert.equal(cjs.defaultTerminalRuntime('linux'),defaultTerminalRuntime('linux'));
  assert.deepEqual(cjs.platformFeatures('win32','x64'),platformFeatures('win32','x64'));
});
test('native shell preserves Unicode, stderr, exact exit status, and trailing comments', () => {
  const invocation=commandInvocation(process.platform==='win32'?'powershell':'posix',process.platform==='win32'
    ? "[Console]::Out.Write('中文'); [Console]::Error.Write('problem'); exit 7 # trailing comment"
    : "printf '中文'; printf problem >&2; exit 7 # trailing comment");
  const result=spawnSync(invocation.executable,invocation.args,{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(result.error,undefined); assert.equal(result.status,7); assert.equal(result.stdout,'中文'); assert.equal(result.stderr,'problem');
});
