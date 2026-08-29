import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const main = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const productController = read('electron', 'productHostController.mts');
const runtimeWorker = read('electron', 'runtimeHostWorker.mts');
const api = read('src', 'backend', 'api.ts');
const productMcp = read('src', 'backend', 'productMcp.ts');

assert.equal(fs.existsSync(path.join(root, 'cardbush_app', 'pyproject.toml')), false);
assert.equal(fs.existsSync(path.join(root, 'electron', 'cardbushAppService.ts')), false);
assert.match(main, /cardbush-product-host:command/);
assert.match(preload, /productHostCommand/);
assert.doesNotMatch(productController, /BotSupervisor|Weixin|Telegram|Discord|Feishu/);
assert.equal(fs.existsSync(path.join(root, 'electron', 'runtimeProductTools.mts')), false);
assert.doesNotMatch(runtimeWorker, /registerProductHostTools|host_tool_request/);
assert.match(runtimeWorker, /id: 'cardbush_apps'/);
assert.match(runtimeWorker, /CARDBUSH_APPS_CONFIG_PATH/);
assert.match(runtimeWorker, /appsConfig\.serviceEnabled/);
assert.equal(fs.existsSync(path.join(root, 'packages', 'cardbush-apps-mcp', 'src', 'index.ts')), true);
assert.equal(fs.existsSync(path.join(root, 'packages', 'cardbush-product-host', 'src', 'appsConfigStore.ts')), true);
assert.match(api, /fetchCardbushAppsConfiguration/);
assert.match(api, /saveCardbushAppsConfiguration/);
assert.doesNotMatch(api, /\/host\/v1\/bots/);
assert.doesNotMatch(productMcp, /computer_use/);
assert.doesNotMatch(main, /CARDBUSH_APP_EXECUTABLE|cardbushAppService/);
assert.doesNotMatch(api, /bots\.list|bot\.config|weixin\.login/);

console.log('CardBush core, bundled Apps MCP, and independent Bot boundary contract tests passed');
