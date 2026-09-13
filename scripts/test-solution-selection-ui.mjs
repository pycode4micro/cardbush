import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/run-app-views-test.mjs'], {
  env: { ...process.env, CARDBUSH_APP_VIEWS_CASE: 'solution-selection' },
  windowsHide: true, stdio: 'inherit', timeout: 90000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
