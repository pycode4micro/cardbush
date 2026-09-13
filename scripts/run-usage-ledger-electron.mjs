import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const prefix = join(tmpdir(), 'cardbush-usage-electron-');
const root = mkdtempSync(prefix);
try {
  const result = spawnSync(require('electron'), ['scripts/test-usage-ledger-electron.cjs', root], { env, windowsHide: true, stdio: 'inherit', timeout: 20000 });
  assert.equal(result.status, 0, String(result.error ?? 'Electron usage test failed'));
} finally {
  assert.ok(resolve(root).startsWith(prefix));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
