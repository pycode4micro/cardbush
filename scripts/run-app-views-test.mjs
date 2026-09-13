import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = { ...process.env };
if (process.argv[2]) env.CARDBUSH_APP_VIEWS_CASE = process.argv[2];
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(require('electron'), ['scripts/test-app-views.cjs'], {
  // The full suite includes both themes and 100-operation transcript fixtures;
  // individual UI assertions still use their own short timeout.
  env, windowsHide: true, stdio: 'inherit', timeout: env.CARDBUSH_APP_VIEWS_CASE ? 90000 : 180000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
