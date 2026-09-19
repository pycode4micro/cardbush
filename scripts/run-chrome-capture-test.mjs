import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = mkdtempSync(path.join(tmpdir(), 'cardbush-capture-ui-'));
const env = { ...process.env, CARDBUSH_CAPTURE_TEST_ROOT: root };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
try {
  const result = spawnSync(require('electron'), ['scripts/test-chrome-capture.cjs'], { env, windowsHide: true, stdio: 'inherit', timeout: 60_000 });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('cardbush-capture-ui-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
