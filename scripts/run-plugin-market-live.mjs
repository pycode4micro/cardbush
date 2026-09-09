import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-market-live-'));
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
try {
  const code = await new Promise((fulfill, reject) => {
    const child = spawn(require('electron'), ['scripts/test-plugin-market-live.cjs', root], { env, windowsHide: true, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', fulfill);
  });
  assert.equal(code, 0, 'Live marketplace check failed');
} finally {
  assert.ok(root.startsWith(parent + sep + 'cardbush-market-live-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
