import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { commandInvocation, createPlatformContext, findExecutable, powerShellExecutable, terminalInvocation } from '../dist/index.js';

const local = 'C:\\Users\\测试 用户\\AppData\\Local';
const alias = path.win32.join(local, 'Microsoft', 'WindowsApps', 'pwsh.exe');
const binary = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.9.0_x64__fixture\\pwsh.exe';
const missing = () => Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
const denied = () => Object.assign(new Error('denied fixture'), { code: 'EACCES' });
const env = { Path: path.win32.dirname(alias), LocalAppData: local, ProgramFiles: 'C:\\Program Files' };

function store(t, options = {}) {
  const state = { installed: true, target: binary, blocked: false, ...options };
  const equal = (a, b) => String(a).toLowerCase() === b.toLowerCase();
  t.mock.method(fs, 'statSync', file => {
    if (equal(file, alias)) throw denied(); // The original bug, even though the alias is launchable.
    if (state.installed && equal(file, binary)) {
      if (state.blocked) throw denied();
      return { isFile: () => true };
    }
    throw missing();
  });
  t.mock.method(fs, 'lstatSync', file => {
    if (state.installed && equal(file, alias)) return { isSymbolicLink: () => true };
    throw missing();
  });
  t.mock.method(fs, 'readlinkSync', file => {
    assert.ok(equal(file, alias));
    return state.target;
  });
  t.mock.method(fs, 'accessSync', file => {
    assert.ok(equal(file, binary));
    if (state.blocked) throw denied();
  });
  return state;
}

test('Store execution aliases resolve to a checked binary for terminal and tool commands', t => {
  store(t);
  const host = createPlatformContext({ platform: 'win32', env });
  assert.equal(findExecutable('pwsh.exe', host), binary);
  assert.equal(powerShellExecutable(host), binary);
  assert.equal(commandInvocation('powershell', 'Write-Output ok', host).executable, binary);
  assert.equal(terminalInvocation('powershell', undefined, undefined, host).command, binary);
  const explicit = createPlatformContext({ platform: 'win32', env: { ...env, CARDBUSH_TERMINAL_SHELL: alias } });
  assert.equal(terminalInvocation('powershell', undefined, undefined, explicit).command, binary);
  assert.match(commandInvocation('powershell', 'Write-Output ok', host).args.at(-1), /PSVersionTable.PSVersion.Major -lt 7/);
});

test('a Store installation is rediscovered without restarting or changing the host PATH', t => {
  const state = store(t, { installed: false });
  const host = createPlatformContext({ platform: 'win32', env: { ...env, Path: '' } });
  assert.throws(() => powerShellExecutable(host), { code: 'powershell_not_found' });
  state.installed = true;
  assert.equal(powerShellExecutable(host), binary);
});

test('denied Store target is an unresolved installation, never a missing or permitted executable', t => {
  store(t, { blocked: true });
  const host = createPlatformContext({ platform: 'win32', env });
  assert.equal(findExecutable('pwsh.exe', host), undefined);
  assert.throws(() => powerShellExecutable(host), error => {
    assert.equal(error.code, 'powershell_lookup_failed');
    assert.equal(error.details.reason, 'lookup_failed');
    assert.ok(error.details.candidates.some(item => item.path === alias && item.code === 'EACCES'));
    assert.doesNotMatch(error.message, /Ask the user to install/);
    return true;
  });
});

test('alias handling rejects relative, renamed and missing targets', t => {
  const state = store(t);
  const host = createPlatformContext({ platform: 'win32', env });
  for (const target of ['..\\pwsh.exe', 'C:\\Tools\\powershell.exe', 'C:\\Missing\\pwsh.exe']) {
    state.target = target;
    assert.equal(findExecutable('pwsh.exe', host), undefined, target);
  }
});

test('ordinary access denial is not bypassed through a link or confused with a missing installation', t => {
  t.mock.method(fs, 'statSync', () => { throw denied(); });
  const links = t.mock.method(fs, 'readlinkSync', () => { throw new Error('must not resolve arbitrary denied paths'); });
  const host = createPlatformContext({ platform: 'win32', env: { PATH: 'C:\\Private', LOCALAPPDATA: local } });
  assert.equal(findExecutable('pwsh.exe', host), undefined);
  assert.equal(links.mock.callCount(), 0);
  assert.throws(() => powerShellExecutable(host), { code: 'powershell_lookup_failed' });
  assert.equal(links.mock.callCount(), 0);
});

test('normal executable directories and inaccessible Linux files retain their existing boundaries', t => {
  t.mock.method(fs, 'statSync', file => {
    if (file === '/tools/pwsh') throw denied();
    return { isFile: () => false };
  });
  const links = t.mock.method(fs, 'readlinkSync', () => { throw new Error('Windows alias logic must not run'); });
  const linux = createPlatformContext({ platform: 'linux', env: { PATH: '/tools', LOCALAPPDATA: local } });
  assert.equal(findExecutable('folder', linux), undefined);
  assert.throws(() => powerShellExecutable(linux), { code: 'powershell_lookup_failed' });
  assert.equal(links.mock.callCount(), 0);
});
