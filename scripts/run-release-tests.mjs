// A single build precedes this gate. Keep UI tests serial; their Electron fixtures share ports.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packages = ['cardbush-platform', 'bush-protocol', 'bush-runtime', 'bush-product-agent',
  'cardbush-product-host', 'bush-provider-openai', 'bush-mcp-client', 'cardbush-apps-mcp',
  'cardbush-chrome-mcp', 'bush-runtime-electron'];
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const tests = packages.flatMap(name => readdirSync(path.join(root, 'packages', name, 'test'))
  .filter(file => file.endsWith('.test.mjs')).map(file => `packages/${name}/test/${file}`));
run(['--test', '--test-concurrency=3', ...tests]);
run(['--test', 'scripts/test-windows-app-identity.mjs']);
run(['--test', 'scripts/test-file-preview-registry.mjs']);
run(['--test', 'scripts/test-plugin-local-install.mjs', 'scripts/test-plugin-uninstall.mjs', 'scripts/test-plugin-environment.mjs']);
for (const script of ['test-plugin-install-transaction.mjs', 'test-plugin-marketplaces.mjs']) run(['scripts/' + script]);
for (const script of ['test-background-startup.mjs', 'test-startup-runtime-contract.mjs',
  'test-local-path-metadata.mjs', 'test-settings-layout-contract.mjs', 'test-panel-motion-contract.mjs',
  'test-chat-scroll-contract.mjs', 'test-scroll-anchoring.mjs', 'test-keyboard-shortcuts.mjs', 'test-chrome-connector-contract.mjs',
  'test-release-cleanup-contract.mjs', 'test-visual-theme-context.mjs',
  'test-history-tool-contract.mjs', 'test-turn-guidance-contract.mjs',
  'test-message-media-contract.mjs', 'test-product-skills-contract.mjs']) run(['scripts/' + script]);
if (!process.argv.includes('--no-ui')) {
  for (const script of ['run-app-views-test.mjs', 'test-plugin-connections-ui.mjs', 'test-plugin-appearance.mjs',
    'run-image-preview-test.mjs', 'test-inspector-navigation-ui.mjs']) run(['scripts/' + script]);
  for (const view of ['html-references', 'loop-previews', 'startup-presentation', 'composer-resize']) run(['scripts/run-app-views-test.mjs', view]);
  run(['scripts/test-plugin-uninstall-worker.cjs']);
  run(['scripts/test-window-menu.mjs']);
}
