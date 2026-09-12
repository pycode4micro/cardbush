import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const preview = process.argv.includes('--preview');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const result = spawnSync(require('electron'), [
  'scripts/test-window-appearance-ui.cjs', ...(preview ? ['--preview'] : []),
], { env, stdio: 'inherit', windowsHide: !preview, ...(preview ? {} : { timeout: 60000 }) });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
