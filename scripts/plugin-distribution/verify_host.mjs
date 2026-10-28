import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers } from '../../dist-electron/productPlugins.js';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const root = path.resolve(process.argv[2]);
const receipt = JSON.parse(await readFile(path.join(path.dirname(root), 'plugin-verification.json'), 'utf8'));
const roots = [{ path: root, source: 'user' }];
const plugins = await loadProductPluginCatalog(roots);
const servers = await loadEnabledProductPluginMcpServers(roots, path.join(path.dirname(root), 'not-created-apps.json'));
assert.equal(plugins.length, receipt.results.length);
assert.ok(receipt.results.every(x => x.passed));
const local = servers.filter(x => x.transport.command);
assert.equal(local.length, receipt.results.filter(x => x.isolatedRuntime).length);
for (const server of local) {
  assert.ok(server.transport.command.endsWith('.exe'));
  assert.ok(existsSync(server.transport.command));
}
const result = { passed: true, plugins: plugins.length, localExeServers: local.length, remoteServers: servers.length - local.length };
await writeFile(path.join(path.dirname(root), 'plugin-host-compatibility.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
