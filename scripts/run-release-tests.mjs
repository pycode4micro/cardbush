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
run(['--test', 'scripts/test-windows-app-identity.mjs', 'scripts/test-windows-release-signatures.mjs']);
run(['--test', 'scripts/test-app-center.mjs', 'scripts/test-local-applications.mjs', 'scripts/test-calendar-import.mjs']);
run(['scripts/test-local-applications-native.mjs']);
run(['scripts/test-automation-calendar.mjs']);
run(['--test', 'scripts/test-file-preview-registry.mjs']);
run(['--test', 'scripts/test-permission-modes.mjs']);
run(['--test', 'scripts/test-sandbox-setup.mjs']);
run(['--test', 'scripts/test-runtime-startup-races.mjs']);
run(['--test', '--test-timeout=45000', 'scripts/test-agent-service.mjs']);
run(['--test', 'scripts/test-plugin-local-install.mjs', 'scripts/test-plugin-uninstall.mjs', 'scripts/test-plugin-environment.mjs']);
for (const script of ['test-plugin-install-transaction.mjs', 'test-plugin-marketplaces.mjs']) run(['scripts/' + script]);
for (const script of ['test-background-startup.mjs', 'test-first-message.mjs', 'test-conversation-switching.mjs', 'test-session-read-fences.mjs', 'test-startup-runtime-contract.mjs', 'test-runtime-host-lifecycle.mjs',
  'test-local-path-metadata.mjs', 'test-settings-layout-contract.mjs', 'test-panel-motion-contract.mjs',
  'test-chat-scroll-contract.mjs', 'test-scroll-anchoring.mjs', 'test-keyboard-shortcuts.mjs', 'test-chrome-connector-contract.mjs',
  'test-release-cleanup-contract.mjs', 'test-visual-theme-context.mjs',
  'test-history-tool-contract.mjs', 'test-turn-guidance-contract.mjs',
  'test-message-media-contract.mjs', 'test-product-skills-contract.mjs']) run(['scripts/' + script]);
if (!process.argv.includes('--no-ui')) {
  run(['scripts/test-runtime-host-env.cjs']);
  run(['scripts/run-settings-context-ui-test.mjs', 'sandbox']);
  run(['scripts/run-agents-ui-test.mjs']);
  for (const script of ['run-app-views-test.mjs', 'test-plugin-connections-ui.mjs', 'test-plugin-appearance.mjs',
    'run-image-preview-test.mjs', 'test-inspector-navigation-ui.mjs']) run(['scripts/' + script]);
  for (const view of ['html-references', 'loop-previews', 'startup-presentation', 'composer-resize', 'sidebar-menu', 'app-center']) run(['scripts/run-app-views-test.mjs', view]);
  run(['scripts/test-automations-ui.mjs']);
  run(['scripts/test-plugin-uninstall-worker.cjs']);
  run(['scripts/test-window-menu.mjs']);
}
