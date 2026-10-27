import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TerminalSessionManager } from '../dist/terminalSessionManager.js';

test('sandboxed cmd preserves quoted paths, pipelines, native output and built-in output', { skip: process.platform !== 'win32' }, async t => {
  const temp = await realpath(tmpdir()), root = await mkdtemp(join(temp, 'cardbush-cmd-text-'));
  const cwd = join(root, 'work'); await mkdir(cwd);
  const terminal = new TerminalSessionManager();
  t.after(async () => { await terminal.close(); assert.equal(dirname(root), temp); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(cwd, 'two words & 中文.txt'), 'marker line\r\n');
  const run = command => terminal.start({ ownerSessionId: 'cmd-text', command, cwd, shell: 'cmd', yieldTimeMs: 10000,
    sandbox: { writableRoots: [cwd], network: 'disabled' } });
  const quoted = await run('type "two words & 中文.txt" | findstr /c:"marker line" > "result file.txt"');
  assert.equal(quoted.exitCode, 0, JSON.stringify(quoted));
  assert.equal(await readFile(join(cwd, 'result file.txt'), 'utf8'), 'marker line\r\n');
  const mixed = await run('curl.exe --version & echo DONE');
  assert.equal(mixed.exitCode, 0, JSON.stringify(mixed));
  assert.match(mixed.stdout, /^curl [\d.]+/); assert.match(mixed.stdout, /DONE\r\n$/);
  assert.equal(mixed.stdout.includes('\0'), false); assert.equal(mixed.stdout.isWellFormed(), true);
  assert.equal(mixed.sandbox.network, 'disabled');
});
