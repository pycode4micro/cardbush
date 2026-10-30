import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LinuxProcessMemory } from '../dist/linuxProcessMemory.js';

function fixture(t) {
  const proc = mkdtempSync(join(tmpdir(), 'cardbush-proc-memory-'));
  t.after(() => { assert.equal(dirname(resolve(proc)), resolve(tmpdir())); assert.match(proc, /cardbush-proc-memory-/); rmSync(proc, { recursive: true, force: true }); });
  const process = (pid, parent, group, start, kib, name = 'worker') => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[2] = String(group); fields[19] = String(start);
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${name}) ${fields.join(' ')}\n`);
    writeFileSync(join(proc, String(pid), 'status'), `Name:\t${name}\nState:\tS (sleeping)\nVmRSS:\t${kib} kB\n`);
  };
  return { proc, process, sample: new LinuxProcessMemory(proc, 10) };
}

test('Linux accounting measures complete owned trees and process groups without crediting foreign processes', t => {
  const f = fixture(t);
  f.process(20, 10, 20, 100, 1000, 'has ) space');
  f.process(21, 20, 21, 101, 2000); // Descendant in a different group.
  f.process(22, 1, 20, 102, 3000); // Reparented member of the owned group.
  f.process(30, 1, 30, 103, 4000);
  f.sample.track('service', 20);
  assert.deepEqual(f.sample.sample(), [{ id: 'service', memoryBytes: 6000 * 1024 }]);
  assert.throws(() => f.sample.track('foreign', 30), /child of this host/);
  assert.throws(() => f.sample.track('service', 20), /already associated/);
  f.sample.release('service'); assert.deepEqual(f.sample.sample(), []);
});

test('missing measurements and reused PIDs retain conservative reservations', t => {
  const f = fixture(t); f.process(20, 10, 20, 100, 500); f.sample.track('job', 20);
  writeFileSync(join(f.proc, '20', 'status'), 'State:\tS\n');
  assert.equal(f.sample.sample(), undefined);
  f.process(20, 10, 20, 999, 200000);
  assert.deepEqual(f.sample.sample(), []);
});
