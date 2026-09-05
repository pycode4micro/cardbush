import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(require('electron'), ['scripts/test-inspector-tabs.cjs'], {
  env, stdio: 'inherit', timeout: 30000,
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
