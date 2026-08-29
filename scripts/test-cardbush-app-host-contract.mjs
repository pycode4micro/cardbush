import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const main = read('electron', 'main.ts');
const preload = read('electron', 'preload.ts');
const service = read('electron', 'cardbushAppService.ts');
const api = read('src', 'backend', 'api.ts');
const server = read('cardbush_app', 'src', 'cardbush_app', 'server.py');
const bots = read('cardbush_app', 'src', 'cardbush_app', 'bots.py');
const backend = read(
  'cardbush_app', 'src', 'cardbush_app', 'adapters', 'common', 'backend.py',
);

assert.match(main, /cardbushAppService\.start\(\)/);
assert.match(main, /cardbushAppService\.stop\(\)/);
assert.match(preload, /cardbushAppRequest/);
assert.match(service, /async mcpServer\(\)/);
assert.match(service, /transport: 'streamable_http'/);
assert.doesNotMatch(service, /\/v1\/mcp\/servers\/cardbush_app/);
assert.doesNotMatch(service, /registerWithBushServer|unregisterFromBushServer/);
assert.match(service, /requestPath\.startsWith\('\/host\/v1\/'\)/);
assert.match(preload, /cardbushAppMcpServer/);
assert.match(api, /synchronizeProductMcpSnapshot/);

assert.match(api, /readCardbushAppJson\('\/host\/v1\/bots'/);
assert.doesNotMatch(api, /requestJson<[^>]*>\('\/v1\/bots/);
assert.match(server, /name="computer_use"/);
assert.match(server, /name="transport_deliver"/);
assert.match(server, /"cardbush\/action_manifest"/);
assert.doesNotMatch(server, /"bushserver\/dispatch"/);
assert.match(server, /\/host\/v1\/bots/);
assert.match(server, /"protocol": "bush\.tool_result\.v1"/);
assert.doesNotMatch(server, /bushserver\.tool_result/);
assert.match(server, /"send_confirmed": False/);

assert.match(bots, /CARDBUSH_BOT_STREAM_BASE_URL/);
assert.doesNotMatch(bots, /CARDBUSH_BOT_BACKEND/);
assert.doesNotMatch(backend, /EchoConversationBackend|StaticConversationBackend/);
assert.doesNotMatch(backend, /BUSH_BACKEND_AUTH_TOKEN/);
assert.match(backend, /load_bushserver_backend_from_env/);

console.log('CardBush host MCP and Bot ownership contract tests passed');
