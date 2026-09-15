import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/test-plugin-connections-ui.mjs', '--appearance-navigation'], {
  stdio: 'inherit', windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
