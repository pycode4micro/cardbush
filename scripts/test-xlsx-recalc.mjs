import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const candidates = process.platform === 'win32'
  ? [['py', '-3'], ['python']]
  : [['python3'], ['python']];
const python = candidates.find(([command, ...prefix]) =>
  spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 5000 }).status === 0);
assert.ok(python, 'Python 3.10+ is required for the XLSX recalculation tests');
const [command, ...prefix] = python;
const result = spawnSync(command, [...prefix, '-B', fileURLToPath(new URL('./test-xlsx-recalc.py', import.meta.url))], {
  stdio: 'inherit', timeout: 120_000,
});
assert.equal(result.status, 0, result.error?.message || 'XLSX recalculation tests failed');
