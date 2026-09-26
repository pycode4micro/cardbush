import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
if (process.platform !== 'win32') {
  console.log('Windows shortcut icon test skipped on this platform.');
} else {
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = spawnSync(require('electron'), ['scripts/test-local-applications-native.cjs'], {
    env, stdio: 'inherit', windowsHide: true, timeout: 45_000,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
}
