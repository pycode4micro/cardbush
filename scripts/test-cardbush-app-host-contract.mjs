import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const main = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const productController = read('electron', 'productHostController.mts');
const productTools = read('electron', 'runtimeProductTools.mts');
const runtimeWorker = read('electron', 'runtimeHostWorker.mts');
const api = read('src', 'backend', 'api.ts');
const productMcp = read('src', 'backend', 'productMcp.ts');

assert.equal(fs.existsSync(path.join(root, 'cardbush_app', 'pyproject.toml')), false);
assert.equal(fs.existsSync(path.join(root, 'electron', 'cardbushAppService.ts')), false);
assert.match(main, /cardbush-product-host:command/);
assert.match(main, /executeHostTool: executeProductHostTool/);
assert.match(preload, /productHostCommand/);
assert.match(productController, /ProductRuntimeConversationBackend/);
assert.match(productController, /executeTool/);
assert.match(productTools, /name: 'computer_use'/);
assert.match(productTools, /name: 'transport_deliver'/);
assert.match(runtimeWorker, /registerProductHostTools/);
assert.doesNotMatch(api, /\/host\/v1\/bots/);
assert.doesNotMatch(productMcp, /cardbush_app/);
assert.doesNotMatch(main, /CARDBUSH_APP_EXECUTABLE|cardbushAppService/);

console.log('CardBush typed Product Host ownership contract tests passed');
