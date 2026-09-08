import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(require('electron'), ['scripts/test-app-views.cjs'], {
  // The full suite includes both themes and 100-operation transcript fixtures;
  // individual UI assertions still use their own short timeout.
  env, stdio: 'inherit', timeout: 90000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
