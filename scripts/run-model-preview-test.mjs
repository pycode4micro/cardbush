import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-model-view-test-'));
const result = spawnSync(require('electron'), ['scripts/test-model-preview-viewer.cjs', scratch], {
  env, windowsHide: true, timeout: 120000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error);
process.exitCode = result.status === 0 && result.stdout?.includes('Model preview viewer passed:') ? 0 : 1;
if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('cardbush-model-view-test-')) throw new Error('Invalid test cleanup path');
fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
