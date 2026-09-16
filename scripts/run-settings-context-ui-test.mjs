import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const env = { ...process.env };
if (process.argv[2]) env.CARDBUSH_SETTINGS_CASE = process.argv[2];
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(createRequire(import.meta.url)('electron'), ['scripts/test-settings-context-ui.cjs'], {
  env, windowsHide: true, stdio: 'inherit', timeout: 45000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
