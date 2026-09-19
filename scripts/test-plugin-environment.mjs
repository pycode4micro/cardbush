import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PluginMarketplaceService } from '../dist-electron/pluginMarketplaces.js';
import { loadEnabledProductPluginMcpServers, loadProductPluginCatalog } from '../dist-electron/productPlugins.js';
import { PluginConnectionManager } from '../dist-electron/pluginConnectionManagement.mjs';
import { pluginMcpServer } from '../dist-electron/pluginMcpConfiguration.mjs';
import { MissingPluginEnvironmentError, pluginDataDirectory } from '../dist-electron/pluginEnvironment.js';

const execute = promisify(execFile);
const absent = 'CARDBUSH_TEST_PLUGIN_UNCONFIGURED_37CB';
assert.equal(process.env[absent], undefined);

async function fixture(t, servers) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, 'cardbush-plugin-env-'));
  t.after(async () => {
    assert.ok(directory.startsWith(parent + sep + 'cardbush-plugin-env-'));
    await rm(directory, { recursive: true, force: true });
  });
  const market = join(directory, 'market'), plugin = join(market, 'demo');
  await mkdir(plugin, { recursive: true });
  await writeFile(join(market, 'marketplace.json'), JSON.stringify({ name: 'env-test', plugins: [{ name: 'demo', source: './demo', policy: { installation: 'AVAILABLE' } }] }));
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'demo', version: '1.0.0' }));
  await writeFile(join(plugin, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, { type: 'stdio', ...server }])) }));
  const installedRoot = join(directory, 'installed'), dataRoot = join(directory, 'runtime-state', 'plugin-data');
  const config = join(directory, 'apps.json');
  const service = new PluginMarketplaceService({ dataRoot: join(directory, 'markets'), userPluginRoot: installedRoot, bundledPluginRoot: resolve('assets/plugins') });
  const source = await service.addLocal(market);
  const preview = () => service.preview(source.id, 'demo');
  const load = () => loadEnabledProductPluginMcpServers([{ path: installedRoot, source: 'user' }], config, [], dataRoot);
  return { directory, plugin, config, service, preview, load, dataRoot, installedRoot };
}

test('PLUGIN_DATA is provided automatically through preview, installation and the child process, and survives updates', async t => {
  const f = await fixture(t, { echo: { command: process.execPath, args: ['${PLUGIN_ROOT}/server.cjs', '${PLUGIN_DATA}/argument.txt'],
    env: { DATA_COPY: '${PLUGIN_DATA}', ALIAS_COPY: '${CLAUDE_PLUGIN_DATA}', PLUGIN_DATA: 'package-cannot-replace-host-directory' } } });
  await writeFile(join(f.plugin, 'server.cjs'), `const fs=require('node:fs');fs.writeFileSync(process.argv[2], 'retained');console.log(JSON.stringify({data:process.env.PLUGIN_DATA,copy:process.env.DATA_COPY,alias:process.env.ALIAS_COPY,root:process.env.PLUGIN_ROOT}));`);
  const preview = await f.preview();
  assert.equal(preview.format, 'agent-plugins');
  assert.deepEqual(preview.issues, []);
  assert.deepEqual(preview.warnings, []);
  await f.service.install(preview.token);
  const [server] = await f.load();
  const expected = pluginDataDirectory('demo', f.dataRoot);
  assert.equal((await stat(expected)).isDirectory(), true);
  const { stdout } = await execute(server.transport.command, server.transport.args, { cwd: server.transport.cwd, env: { ...process.env, ...server.transport.env }, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { data: expected, copy: expected, alias: expected, root: join(f.installedRoot, 'demo') });
  assert.notEqual(pluginDataDirectory('other', f.dataRoot), expected);
  await f.service.install((await f.preview()).token);
  assert.equal((await f.load())[0].transport.env.PLUGIN_DATA, expected);
  assert.equal(await readFile(join(expected, 'argument.txt'), 'utf8'), 'retained');
  assert.match(await readFile(join(f.installedRoot, 'demo', 'mcp.json'), 'utf8'), /\$\{PLUGIN_DATA\}/, 'the package retains its portable declaration');
});

test('missing user configuration warns but permits installation and cannot launch with empty placeholders', async t => {
  const f = await fixture(t, { ready: { command: process.execPath, args: ['--version'] },
    needsConfig: { command: process.execPath, env: { TOKEN: '${' + absent + '}' } } });
  const preview = await f.preview();
  assert.deepEqual(preview.issues, []);
  assert.deepEqual(preview.warnings, [{ code: 'variables', detail: absent }]);
  await f.service.install(preview.token);
  assert.deepEqual((await f.load()).map(server => server.id), ['plugin_demo_ready'], 'an optional incomplete connection does not block healthy ones');
  const plugins = (await loadProductPluginCatalog([{ path: f.installedRoot, source: 'user' }])).map(plugin => ({ ...plugin, installed: true, enabled: true, config: {} }));
  const manager = new PluginConnectionManager({ apps: { read: async () => ({ revision: 1, plugins }) }, mcp: { read: async () => ({ servers: [] }) },
    pluginDataRoot: f.dataRoot, refresh: async () => assert.fail('diagnostics must not start services'), runtime: async () => ({ runtime: null }) });
  const connections = (await manager.list()).connections;
  assert.equal(connections.find(item => item.componentId === 'ready').configurationError, undefined);
  assert.match(connections.find(item => item.componentId === 'needsConfig').configurationError, new RegExp(absent));
  await writeFile(f.config, JSON.stringify({ plugins: [{ id: 'demo', installed: true, enabled: true, config: { mcp_servers: { needsConfig: { required: true } } } }] }));
  await assert.rejects(f.load(), error => error instanceof MissingPluginEnvironmentError && error.required && error.message.includes(absent));
  await writeFile(f.config, JSON.stringify({ plugins: [{ id: 'demo', installed: true, enabled: true, config: { mcp_servers: { needsConfig: { connection: { env: { TOKEN: 'configured-test-value' } } } } } }] }));
  assert.equal((await f.load()).find(server => server.id === 'plugin_demo_needsConfig').transport.env.TOKEN, 'configured-test-value');
});

test('fallbacks do not require configuration and explicit connection settings resolve missing values', () => {
  const declaration = { command: 'node', args: ['${' + absent + ':-default-value}', '${' + absent + ':-}'] };
  assert.deepEqual(pluginMcpServer('demo', 'echo', '/fixture', declaration, {}).transport.args, ['default-value', '']);
  assert.throws(() => pluginMcpServer('demo', 'echo', '/fixture', { command: 'node', args: ['${' + absent + '}'] }, {}), MissingPluginEnvironmentError);
});

test('URL variables warn without turning configuration into an installation blocker', async t => {
  const f = await fixture(t, { remote: { type: 'streamable-http', url: '${' + absent + '}' } });
  const preview = await f.preview();
  assert.deepEqual(preview.issues, []);
  assert.deepEqual(preview.warnings, [{ code: 'variables', detail: absent }]);
  await f.service.install(preview.token);
  assert.deepEqual(await f.load(), []);
});

test('structural incompatibility still blocks installation even with missing variables', async t => {
  const f = await fixture(t, { unsupported: { command: '', env: { TOKEN: '${' + absent + '}' } } });
  const preview = await f.preview();
  assert.ok(preview.issues.some(issue => issue.code === 'configuration'));
  assert.equal(preview.warnings[0].detail, absent);
  await assert.rejects(f.service.install(preview.token), /not compatible/);
});
