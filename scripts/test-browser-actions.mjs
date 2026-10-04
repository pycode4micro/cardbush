import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'browser-actions-'));
try {
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = spawnSync(require('electron'), ['scripts/test-browser-actions-worker.cjs', directory], {
    env, windowsHide: true, stdio: 'inherit', timeout: 55_000,
  });
  assert.equal(result.status, 0, String(result.error ?? 'Browser action regression failed'));
} finally {
  assert.ok(resolve(directory).startsWith(parent + sep + 'browser-actions-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
