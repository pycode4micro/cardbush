import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectHostCommand, terminalEnvironmentDiagnostic } from '../dist/terminalEnvironmentDiagnostic.js';
import { TerminalDiagnosticStream } from '../dist/terminalDiagnostics.js';
import { projectTerminalResult, renderTerminalResult } from '../dist/toolResultText.js';

const missing = { source: 'powershell', phase: 'command', category: 'ObjectNotFound', permissionDenied: false,
  exceptionType: 'System.Management.Automation.CommandNotFoundException', commandName: 'python' };
const sandbox = { backend: 'windows-appcontainer', network: 'disabled', readableRoots: [], writableRoots: ['D:\\work'] };
test('host command lookup inspects trusted absolute PATH metadata, never command paths or relative search roots', () => {
  const inspected = [];
  const host = { platform: 'win32', arch: 'x64', env: { Path: '.;relative;\\\\server\\share;//server/share;\\device;C:relative;C:\\Tools', SECRET: 'never disclosed' },
    isExecutable: path => { inspected.push(path); return path.toLowerCase() === 'c:\\tools\\python.exe'; } };
  assert.deepEqual(inspectHostCommand('python', host), { command: 'python', status: 'found', path: 'C:\\Tools\\python.EXE' });
  assert.deepEqual(inspected, ['C:\\Tools\\python.EXE']);
  for (const command of ['C:\\private\\secret', '..', '.', '../python', 'python; echo secret', '$env:SECRET', 'x'.repeat(129)]) assert.equal(inspectHostCommand(command, host), undefined);
  assert.equal(inspected.length, 1);
  assert.equal(inspectHostCommand('missing', host).status, 'not_found_in_host_path');
});
test('typed missing-command names survive streaming; arbitrary stderr cannot manufacture a host probe', () => {
  const output = [], found = [];
  const stream = new TerminalDiagnosticStream('nonce', data => output.push(data), value => found.push(value));
  for (const byte of Buffer.from('\x1enonce:' + JSON.stringify(missing) + '\x1f')) stream.write(Buffer.from([byte]));
  stream.flush(); assert.deepEqual(found, [missing]); assert.equal(Buffer.concat(output).length, 0);
  stream.write(Buffer.from('No Python at C:\\private\\python.exe\n')); stream.flush();
  assert.equal(found.length, 1);
});
test('installed but unresolved, denied and unverified native-interpreter failures remain distinct', () => {
  const result = { state: 'exited', exitCode: 1, shellDiagnostic: missing, sandbox, stdout: '', stderr: '' };
  const installed = terminalEnvironmentDiagnostic(result, { command: 'python', status: 'found', path: 'C:\\Tools\\python.exe' });
  assert.equal(installed.installation, 'executable_found_on_host'); assert.equal(installed.availability, 'not_resolved_by_shell');
  assert.equal(installed.access_granted, false);
  const absent = terminalEnvironmentDiagnostic(result, { command: 'python', status: 'not_found_in_host_path' });
  assert.equal(absent.installation, 'unknown', 'a PATH miss is not proof of missing installation');
  const venv = { state: 'exited', exitCode: 103, sandbox, stdout: '', stderr: 'No Python at C:\\Tools\\python.exe' };
  const diagnostic = terminalEnvironmentDiagnostic(venv);
  assert.equal(diagnostic.host_command.status, 'not_checked'); assert.equal(diagnostic.installation, 'unknown');
  assert.equal(diagnostic.availability, 'unverified');
  const denied = terminalEnvironmentDiagnostic({ ...result, exitCode: 0, shellDiagnostic: { ...missing, exceptionType: 'System.UnauthorizedAccessException', permissionDenied: true } });
  assert.equal(denied.availability, 'access_denied');
  assert.equal(terminalEnvironmentDiagnostic({ state: 'exited', exitCode: 0, sandbox }), undefined);
  for (const value of [venv, { ...result, environmentDiagnostic: installed }]) {
    assert.match(renderTerminalResult(value), /environmentDiagnostic/);
    for (const budget of [0, 1000, 5000]) {
      const text = projectTerminalResult({ ...value, stdout: 'large\n'.repeat(10000) }, budget);
      assert.match(text, /environmentDiagnostic/); assert.match(text, /access_granted.*false/);
      assert.match(text, /not host installation/);
    }
  }
});
