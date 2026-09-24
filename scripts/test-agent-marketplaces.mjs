import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { AgentHttpClient } from '../dist-electron/agentHttpClient.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { createHeadlessProxySession } from '../dist-electron/headlessProxySession.mjs';

test('remote marketplace uses shared preview/install/update/activation with host-isolated persistence over HTTP', async () => {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'agent-market-'));
  const source = join(root, 'source'), plugin = join(source, 'plugins', 'market-fixture');
  await mkdir(join(source, '.agents', 'plugins'), { recursive: true });
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'greet'), { recursive: true });
  await writeFile(join(source, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({ name: 'fixture-market', plugins: [
    { name: 'market-fixture', source: { source: 'local', path: './plugins/market-fixture' }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' } },
  ] }));
  const version = async value => {
    await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'market-fixture', version: value, description: 'Remote marketplace fixture', skills: './skills',
      interface: { displayName: 'Market fixture', logo: './logo.svg' },
      cardbush: { runtimeExtension: { apiVersion: 1, entry: './runtime.mjs' } } }));
    await writeFile(join(plugin, 'runtime.mjs'), `export const apiVersion=1;export default()=>({id:'market-fixture',features:['market_fixture'],commands:{'plugin.market-fixture.version':async()=>(${JSON.stringify(value)})}});`);
  };
  await version('1.0.0');
  await writeFile(join(plugin, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(plugin, 'skills', 'greet', 'SKILL.md'), '---\nname: greet\ndescription: Greet from the service\n---\nSay hello.');
  let service, other, server, client;
  try {
    service = await AgentService.open({ dataRoot: join(root, 'agent') });
    other = await AgentService.open({ dataRoot: join(root, 'other') });
    const token = 'marketplace-test-access-token-32-characters';
    server = await serveAgentHttp(service, { port: 0, token });
    client = new AgentHttpClient(`http://127.0.0.1:${server.port}/`, token);
    assert.equal((await client.info()).capabilities.pluginMarketplace, true);
    const market = (action, input = {}) => client.call('plugins.marketplace', { action, ...input });
    assert.deepEqual((await market('catalog', { sourceId: 'builtin' })).entries, [], 'an Agent without bundled plugins has a usable empty market');
    await assert.rejects(market('addLocal', { directory: './relative' }), /absolute directory/);
    await assert.rejects(market('unsupported'), /Invalid|invalid/i);
    const entry = await market('addLocal', { directory: source });
    const catalog = await market('catalog', { sourceId: entry.id, refresh: true });
    assert.equal(catalog.entries[0].name, 'market-fixture');
    const presentation = await market('presentation', { sourceId: entry.id, name: 'market-fixture' });
    assert.equal(presentation.displayName, 'Market fixture');
    assert.match(presentation.logo, /^data:image\/svg\+xml;base64,/);
    const preview = await market('preview', { sourceId: entry.id, name: 'market-fixture' });
    assert.equal(preview.updating, false); assert.deepEqual(preview.issues, []);
    assert.equal((await service.call('product.command', { kind: 'apps.get' })).plugins.length, 0, 'preview does not install');
    await assert.rejects(other.call('plugins.marketplace', { action: 'install', token: preview.token }), /expired|invalid/i, 'preview tokens cannot cross Agents');
    await version('2.0.0'); // Install must use the reviewed snapshot, not the mutable market source.
    assert.equal((await market('install', { token: preview.token })).id, 'market-fixture');
    await assert.rejects(market('install', { token: preview.token }), /expired/);
    let apps = await client.call('product.command', { kind: 'apps.get' });
    assert.equal(apps.plugins[0].version, '1.0.0');
    assert.equal(apps.plugins[0].source, 'user');
    await client.call('product.command', { kind: 'apps.update', config: { ...apps, expectedRevision: apps.revision, plugins: [{ id: 'market-fixture', installed: true, enabled: true, config: {} }] } });
    assert.equal(await client.call('runtime.command', { kind: 'plugin.market-fixture.version' }), '1.0.0');
    assert.ok((await client.call('conversation.catalog', {})).skills.some(skill => skill.name.includes('greet')));
    const update = await market('preview', { sourceId: entry.id, name: 'market-fixture' });
    assert.equal(update.updating, true);
    await market('install', { token: update.token });
    assert.equal(await client.call('runtime.command', { kind: 'plugin.market-fixture.version' }), '2.0.0', 'update reloads an enabled runtime through shared replacement');
    assert.equal((await other.call('product.command', { kind: 'apps.get' })).plugins.length, 0);
    assert.equal((await other.call('plugins.marketplace', { action: 'sources' })).length, 1);
    await client.close(); client = undefined; await server.close(); server = undefined; await service.close();
    service = await AgentService.open({ dataRoot: join(root, 'agent') });
    assert.ok((await service.call('plugins.marketplace', { action: 'sources' })).some(item => item.id === entry.id));
    assert.equal(await service.call('runtime.command', { kind: 'plugin.market-fixture.version' }), '2.0.0');
    await service.call('plugins.marketplace', { action: 'remove', sourceId: entry.id });
    assert.equal(JSON.parse(await readFile(join(root, 'agent', 'plugins', 'market-fixture', '.codex-plugin', 'plugin.json'), 'utf8')).version, '2.0.0', 'removing a source retains installed plugins');
    await service.call('plugins.uninstall', { id: 'market-fixture' });
    assert.equal((await service.call('product.command', { kind: 'apps.get' })).plugins.length, 0);
  } finally {
    await client?.close(); await server?.close(); await service?.close(); await other?.close();
    assert.ok(root.startsWith(parent + sep + 'agent-market-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('headless proxy routing follows the Agent environment and explicit plugin proxy settings', async () => {
  const session = createHeadlessProxySession({ HTTPS_PROXY: 'http://user:secret@proxy.example:3128', HTTP_PROXY: 'http://plain.example:8080', NO_PROXY: 'localhost,.internal.example,[::1],port.example:444' });
  assert.equal(await session.resolveProxy('https://market.example/a'), 'PROXY user:secret@proxy.example:3128');
  assert.equal(await session.resolveProxy('http://market.example/a'), 'PROXY plain.example:8080');
  for (const url of ['https://localhost', 'http://node.internal.example', 'http://[::1]', 'https://port.example:444']) assert.equal(await session.resolveProxy(url), 'DIRECT');
  assert.notEqual(await session.resolveProxy('https://port.example:443'), 'DIRECT');
  await session.setProxy({ mode: 'fixed_servers', proxyRules: 'https=socks5://manual.example:1080', proxyBypassRules: 'bypass.example' });
  assert.equal(await session.resolveProxy('https://market.example'), 'SOCKS5 manual.example:1080');
  assert.equal(await session.resolveProxy('https://bypass.example'), 'DIRECT');
  assert.equal(await session.resolveProxy('http://market.example'), 'DIRECT');
});
