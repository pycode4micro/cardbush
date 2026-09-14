import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
for (const preference of ['force-prefers-no-reduced-motion', 'force-prefers-reduced-motion']) {
  const result = spawnSync(require('electron'), ['--' + preference, 'scripts/test-image-preview.cjs'], {
    env, windowsHide: true, stdio: 'inherit', timeout: 30000,
  });
  if (result.error) console.error(result.error);
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
