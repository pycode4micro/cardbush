import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
// Use a fresh renderer for attachment cases; the main suite mutates model and
// connection fixtures throughout its settings and recovery scenarios.
const args = process.argv.slice(2);
for (const scenario of args.length ? [args] : [[], ['--images']]) {
  const result = spawnSync(process.env.CARDBUSH_TEST_ELECTRON || require('electron'), ['scripts/test-agents-ui.cjs', ...scenario], {
    env, windowsHide: true, stdio: 'inherit', timeout: 90_000,
  });
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
  if (process.exitCode) break;
}
