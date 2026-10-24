import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalDiagnosticStream } from '../dist/terminalDiagnostics.js';

const token = '0123456789abcdef0123456789abcdef';
const detail = { source: 'powershell', phase: 'command', permissionDenied: true, category: 'PermissionDenied', exceptionType: 'System.UnauthorizedAccessException' };
const frame = value => Buffer.from(`\x1e${token}:${JSON.stringify(value)}\x1f`);

test('typed shell diagnostics survive every stream boundary and leave native stderr intact', () => {
  const native = Buffer.from('native 中文😀\n');
  const bytes = Buffer.concat([native, frame(detail), native]);
  for (let split = 0; split <= bytes.length; split++) {
    const output = [], diagnostics = [];
    const parser = new TerminalDiagnosticStream(token, chunk => output.push(chunk), value => diagnostics.push(value));
    parser.write(bytes.subarray(0, split)); parser.write(bytes.subarray(split)); parser.flush();
    assert.deepEqual(Buffer.concat(output), Buffer.concat([native, native]));
    assert.deepEqual(diagnostics, [detail]);
  }
});

test('unknown, malformed, oversized and incomplete frames stay ordinary output', () => {
  for (const bytes of [Buffer.from(`\x1eother:${JSON.stringify(detail)}\x1f`),
    frame({ source: 'business', permissionDenied: true }),
    Buffer.from(`\x1e${token}:broken\x1f`),
    Buffer.from(`\x1e${token}:` + 'a'.repeat(10000)), frame(detail).subarray(0, -1),
    Buffer.from('Access denied\n拒绝访问\n')]) {
    const output = [], diagnostics = [];
    const parser = new TerminalDiagnosticStream(token, chunk => output.push(chunk), value => diagnostics.push(value));
    for (let index = 0; index < bytes.length; index += 7) parser.write(bytes.subarray(index, index + 7));
    parser.flush(); assert.deepEqual(Buffer.concat(output), bytes); assert.deepEqual(diagnostics, []);
  }
});
