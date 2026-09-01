import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const worker = read('electron', 'runtimeHostWorker.mts');
const main = read('electron', 'main.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const productAgent = read('packages', 'bush-product-agent', 'src', 'index.ts');
const extendedBuiltins = read('packages', 'bush-runtime', 'src', 'extendedBuiltins.ts');
const appsPlugin = read(
  'packages',
  'cardbush-apps-mcp',
  'src',
  'plugins',
  'computerUse.ts',
);

assert.equal(fs.existsSync(path.join(root, 'electron', 'runtimeProductTools.mts')), false);
assert.doesNotMatch(worker, /registerProductHostTools|host_tool_request|product_host_tools/);
assert.doesNotMatch(main, /executeProductHostTool|captureDesktopForRuntime/);
assert.match(worker, /id: 'cardbush_apps'/);
assert.match(appsPlugin, /registerTool\('computer_use'/);
assert.match(appsPlugin, /annotations: \{/);
assert.doesNotMatch(appsPlugin, /cardbush\/action_manifest|execution_fact|receipt_id/);
assert.match(appsPlugin, /Observe and interact with the user's current desktop/);
assert.doesNotMatch(appsPlugin, /LAST-RESORT|last-resort fallback|prefer chrome_devtools/i);
assert.doesNotMatch(runtimeChat, /entry\.manifest\.dispatch_scope !== 'resource'/);
assert.match(runtimeChat, /filesystemLocations/);
assert.doesNotMatch(
  productAgent,
  /Computer Use is a last-resort|prefer any purpose-built|chrome_devtools Tools as the primary route/,
);
assert.match(extendedBuiltins, /name: "consult_logic"/);
assert.match(extendedBuiltins, /name: "learn_logic"/);
assert.doesNotMatch(extendedBuiltins, /name: "ked_/);

console.log('Runtime built-in/MCP tool boundary contract passed');
