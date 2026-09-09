import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { McpDesktopHost } from '../dist-electron/mcpDesktopHost.js';
import { readPluginPresentation } from '../dist-electron/pluginPresentation.js';
import { PluginMarketplaceService } from '../dist-electron/pluginMarketplaces.js';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';
import { pluginMcpServer } from '../dist-electron/pluginMcpConfiguration.mjs';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';

test('plugin OAuth config preserves package scopes and resource while normalizing higher-priority user overrides', () => {
  const server = pluginMcpServer('fixture', 'docs', 'D:/fixture', {
    type: 'http', url: 'https://docs.example/mcp', scopes: ['read'], oauth_resource: 'https://docs.example/mcp',
    oauth: { client_id: 'package-client', callback_port: 12798, client_secret: '<CLIENT_SECRET>' },
  }, { oauth: { clientId: 'user-client', callbackUrl: 'http://127.0.0.1:23000/finish', clientSecretEnv: 'FIXTURE_SECRET' } });
  assert.deepEqual(server.transport.oauth, { clientId: 'user-client', clientSecretEnv: 'FIXTURE_SECRET',
    callbackUrl: 'http://127.0.0.1:23000/finish', resourceUrl: 'https://docs.example/mcp', scopes: ['read'] });
  assert.ok(!JSON.stringify(server).includes('<CLIENT_SECRET>'));
});

test('plugin presentation obeys the canonical overlay, preserves logo bytes and loads lazily by pinned revision', async () => {
  const sha = 'a'.repeat(40), logo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
  const files = {
    '.agents/plugins/marketplace.json': { name: 'fixture', plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }] },
    'plugins/demo/plugin.json': { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'demo', extensions: { 'com.openai': { interface: { displayName: 'Visible name', logo: './assets/logo.svg' } } } },
    'plugins/demo/assets/logo.svg': logo,
  };
  const requests = [];
  const root = await mkdtemp(join(tmpdir(), 'cardbush-logo-'));
  try {
    const service = new PluginMarketplaceService({ dataRoot: root, userPluginRoot: join(root, 'installed'), bundledPluginRoot: join(root, 'bundled'), fetch: async input => {
      const url = String(input); requests.push(url);
      if (url.includes('/commits/')) return Response.json({ sha });
      const relative = url.split(`/${sha}/`)[1], value = files[relative];
      return value ? Buffer.isBuffer(value) ? new Response(value) : Response.json(value) : new Response('', { status: 404 });
    } });
    const source = await service.addGitHub('fixture/plugins');
    assert.equal(requests.filter(url => url.includes('/plugins/demo')).length, 0);
    const views = await Promise.all([service.presentation(source.id, 'demo'), service.presentation(source.id, 'demo')]);
    assert.equal(views[0].displayName, 'Visible name');
    assert.equal(views[0].logo, 'data:image/svg+xml;base64,' + logo.toString('base64'));
    assert.equal(requests.filter(url => url.endsWith('/assets/logo.svg')).length, 1);
    assert.ok(requests.filter(url => url.includes('/plugins/demo')).every(url => url.includes(sha)));
    const empty = await readPluginPresentation(async file => { if (file === 'plugin.json') return Buffer.from(JSON.stringify({ ...files['plugins/demo/plugin.json'], extensions: { 'com.openai': {} } })); throw Error('overlay must not be read'); });
    assert.equal(empty.logo, '');
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'cardbush-'))); await rm(root, { recursive: true, force: true }); }
});

test('registered app mappings and per-plugin service/tool policies use the installed package and user config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-app-map-'));
  const plugin = join(root, 'plugins', 'mapped');
  const save = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  try {
    await save(join(plugin, '.codex-plugin/plugin.json'), { name: 'mapped', version: '1', apps: './.app.json', mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp', oauth: { client_id: 'package-client' } } } });
    await save(join(plugin, '.app.json'), { apps: { design: { id: 'plugin_asdk_app_fixture', required: true } } });
    const config = join(root, 'apps.json'), roots = [{ path: join(root, 'plugins'), source: 'user' }];
    const catalog = await loadProductPluginCatalog(roots);
    assert.equal(catalog[0].components.find(item => item.kind === 'app').mcp.registeredAppId, 'plugin_asdk_app_fixture');
    const defaults = await loadEnabledProductPluginMcpServers(roots, config);
    assert.equal(defaults.find(item => item.id === 'plugin_mapped_design').transport.auth, 'openai');
    await save(config, { serviceEnabled: true, plugins: [{ id: 'mapped', installed: true, enabled: true, config: { mcp_servers: { design: { provider: 'direct' } } } }] });
    await assert.rejects(loadEnabledProductPluginMcpServers(roots, config), /requires MCP connection design/, 'an explicitly direct required app cannot disappear without its connection');
    await save(config, { serviceEnabled: true, plugins: [{ id: 'mapped', installed: true, enabled: true, config: { mcp_servers: {
      docs: { default_tools_approval_mode: 'approve', enabled_tools: ['search'], tools: { search: { approval_mode: 'prompt' }, blocked: { enabled: false } } },
      design: { server: 'design-local' },
    } } }] });
    const servers = await loadEnabledProductPluginMcpServers(roots, config, [{ id: 'design-local', transport: { kind: 'streamable_http', url: 'https://design.example/mcp', oauth: { clientId: 'local-client' } } }]);
    assert.equal(servers.length, 2);
    assert.equal(servers[0].defaultToolPolicy.permission, 'allow');
    assert.equal(servers[0].toolPolicies.search.permission, 'ask');
    assert.equal(servers[0].toolPolicies.blocked.enabled, false);
    assert.deepEqual(servers[0].exposeTools, ['search']);
    assert.equal(servers[1].id, 'plugin_mapped_design');
    assert.equal(servers[1].transport.oauth.clientId, 'local-client');
    assert.equal(servers[1].defaultToolPolicy.permission, 'ask');
    assert.equal(servers[1].required, true);
    assert.equal(pluginMcpServer('mapped', 'docs', plugin, {}, { enabled: false }), null);
    assert.equal(JSON.parse(await readFile(join(plugin, '.app.json'), 'utf8')).apps.design.id, 'plugin_asdk_app_fixture');
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'cardbush-'))); await rm(root, { recursive: true, force: true }); }
});

for (const format of ['explicit', 'discovered', 'portable']) test(`same-name app and bundled MCP share one connection throughout preview, install and runtime (${format})`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-dual-connection-'));
  const name = `dual-${format}`, alias = 'service', market = join(root, 'market'), source = join(market, 'plugins', name);
  const installed = join(root, 'installed'), config = join(root, 'apps.json'), roots = [{ path: installed, source: 'user' }];
  const save = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
  try {
    const app = { id: 'asdk_app_fixture', required: true };
    const bundled = { type: format === 'portable' ? 'streamable-http' : 'http', url: 'https://bundled.example/mcp',
      headers: { 'X-Fixture': 'bundled' }, oauth: { client_id: 'bundle-client', scopes: ['read'] } };
    const manifestFile = format === 'portable' ? 'plugin.json' : '.codex-plugin/plugin.json';
    const mcpFile = format === 'portable' ? 'mcp.json' : '.mcp.json';
    await save(join(source, manifestFile), format === 'portable'
      ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, extensions: { 'com.openai': { apps: './.app.json' } } }
      : { name, apps: './.app.json', ...(format === 'explicit' ? { mcpServers: './.mcp.json' } : {}) });
    await save(join(source, '.app.json'), { apps: { [alias]: app } });
    await save(join(source, mcpFile), { ...(format === 'portable' ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' } : {}), mcpServers: { [alias]: bundled } });
    const before = await Promise.all([manifestFile, '.app.json', mcpFile].map(file => readFile(join(source, file))));
    await save(join(market, '.agents/plugins/marketplace.json'), { name: 'dual-fixture', plugins: [
      { name, source: { source: 'local', path: `./plugins/${name}` }, policy: { installation: 'AVAILABLE' } },
    ] });
    const marketService = new PluginMarketplaceService({ dataRoot: join(root, 'data'), userPluginRoot: installed,
      bundledPluginRoot: join(root, 'bundled'), fetch: async () => { throw Error('local fixture must not access the network'); } });
    const marketSource = await marketService.addLocal(market);
    const preview = await marketService.preview(marketSource.id, name);
    assert.deepEqual(preview.issues, []);
    const services = preview.components.filter(item => item.kind === 'mcp' || item.kind === 'app');
    assert.equal(services.length, 1, 'the two declarations describe one service, not two UI entries');
    assert.equal(services[0].kind, 'mcp');
    assert.equal(services[0].id, alias);
    assert.equal(services[0].mcp.url, bundled.url);
    assert.equal(services[0].mcp.registeredAppId, app.id);
    assert.equal(services[0].mcp.required, true);
    await marketService.install(preview.token);
    const catalog = await loadProductPluginCatalog(roots);
    assert.deepEqual(catalog[0].components, preview.components);
    for (const [i, file] of [manifestFile, '.app.json', mcpFile].entries()) {
      assert.deepEqual(await readFile(join(source, file)), before[i], 'preview leaves the source unchanged');
      assert.deepEqual(await readFile(join(installed, name, file)), before[i], 'installation preserves both original declarations');
    }
    const defaults = await loadEnabledProductPluginMcpServers(roots, config);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, `plugin_${name}_${alias}`);
    assert.equal(defaults[0].transport.auth, 'openai');
    assert.equal(defaults[0].transport.openaiAppId, app.id);
    assert.equal(defaults[0].required, true);
    const configure = policy => save(config, { serviceEnabled: true, plugins: [{ id: name, installed: true, enabled: true,
      config: { mcp_servers: { [alias]: policy } } }] });
    await configure({ provider: 'direct' });
    const [direct] = await loadEnabledProductPluginMcpServers(roots, config);
    assert.equal(direct.transport.url, bundled.url);
    assert.equal(direct.transport.oauth.clientId, 'bundle-client');
    await configure({ connection: { url: 'https://override.example/mcp' } });
    const [overridden] = await loadEnabledProductPluginMcpServers(roots, config);
    assert.equal(overridden.transport.url, 'https://override.example/mcp');
    assert.equal(overridden.transport.oauth.clientId, 'bundle-client', 'endpoint overrides retain the bundled connection options');
    assert.deepEqual(overridden.transport.oauth.scopes, ['read']);
    assert.equal(overridden.transport.headers['X-Fixture'], 'bundled');
    const binding = { id: 'chosen', transport: { kind: 'streamable_http', url: 'https://bound.example/mcp', oauth: { clientId: 'bound-client' } } };
    await configure({ server: 'chosen', connection: { url: 'https://old-override.example/mcp' }, tools: { search: { approval_mode: 'approve' } } });
    const bound = await loadEnabledProductPluginMcpServers(roots, config, [binding]);
    assert.equal(bound.length, 1, 'an explicit binding replaces the bundled transport');
    assert.equal(bound[0].transport.url, binding.transport.url, 'a previously entered endpoint cannot override the selected binding');
    assert.equal(bound[0].transport.oauth.clientId, 'bound-client');
    assert.deepEqual(bound[0].transport.headers, {}, 'bundled transport settings do not leak into an explicit binding');
    assert.equal(bound[0].toolPolicies.search.permission, 'allow');
    await assert.rejects(loadEnabledProductPluginMcpServers(roots, config), /requires MCP connection service/);
    await assert.rejects(loadEnabledProductPluginMcpServers(roots, config, [{ ...binding, enabled: false }]), /requires MCP connection service/);
    await configure({ enabled: false });
    await assert.rejects(loadEnabledProductPluginMcpServers(roots, config), /requires MCP connection service/);
    await configure({ enabled: false, required: false });
    assert.deepEqual(await loadEnabledProductPluginMcpServers(roots, config), []);
    await configure({ server: 'missing', required: false });
    assert.deepEqual(await loadEnabledProductPluginMcpServers(roots, config), [], 'an optional missing binding never falls back to the bundled endpoint');
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'cardbush-dual-connection-'))); await rm(root, { recursive: true, force: true }); }
});

test('two bundled MCP configs with the same alias remain an invalid declaration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-duplicate-mcp-'));
  try {
    await mkdir(join(root, '.codex-plugin'));
    const declaration = { service: { type: 'http', url: 'https://fixture.example/mcp' } };
    await writeFile(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'duplicate', mcpServers: [declaration, declaration] }));
    await assert.rejects(resolvePluginManifest(root), /Multiple MCP configs use the same server name/);
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'cardbush-duplicate-mcp-'))); await rm(root, { recursive: true, force: true }); }
});

test('desktop credentials stay encrypted, form validation keeps drafts pending, and URL responses are scoped and cancellable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-vault-'));
  const key = randomBytes(32), iv = randomBytes(16), path = join(root, 'vault');
  let changes = 0; const opened = [];
  const host = new McpDesktopHost({ path, changed: () => { changes++; }, openUrl: async url => opened.push(url),
    encrypt: text => { const cipher = createCipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(text), cipher.final()]); },
    decrypt: bytes => { const cipher = createDecipheriv('aes-256-cbc', key, iv); return Buffer.concat([cipher.update(bytes), cipher.final()]).toString(); } });
  try {
    const signal = new AbortController().signal;
    await Promise.all(['a', 'b'].map(key => host.handle('credentials.write', { key: key.repeat(64), value: { access_token: 'SECRET_FIXTURE' } }, signal)));
    assert.ok(!(await readFile(path)).includes(Buffer.from('SECRET_FIXTURE')));
    assert.equal((await host.handle('credentials.read', { key: 'a'.repeat(64) }, signal)).access_token, 'SECRET_FIXTURE');
    assert.equal((await host.handle('credentials.read', { key: 'b'.repeat(64) }, signal)).access_token, 'SECRET_FIXTURE');
    const abort = new AbortController();
    const pending = host.handle('elicitation', { serverId: 'forms', sessionId: 'task-a', turnId: 'turn', params: { message: 'Age', requestedSchema: { type: 'object', properties: { age: { type: 'integer', minimum: 18 } }, required: ['age'] } } }, abort.signal);
    const id = host.requests()[0].id;
    await assert.rejects(host.answer(id, { action: 'accept', content: { age: 12 } }));
    assert.equal(host.requests().length, 1);
    await host.answer(id, { action: 'accept', content: { age: 22 } });
    assert.deepEqual(await pending, { action: 'accept', content: { age: 22 } });
    const urlRequest = host.handle('elicitation', { serverId: 'url', sessionId: 'task-b', turnId: 'turn', params: { mode: 'url', message: 'Authorize', url: 'https://auth.example/consent', elicitationId: 'e' } }, abort.signal);
    const second = host.requests()[0].id;
    await host.openRequestUrl(second); assert.deepEqual(opened, ['https://auth.example/consent']);
    abort.abort(); assert.deepEqual(await urlRequest, { action: 'cancel' });
    await assert.rejects(host.openRequestUrl(second), /no longer pending/);
    const loginAbort = new AbortController();
    const login = host.handle('authentication', { serverId: 'login', sessionId: 'task-c', turnId: 'turn-c', toolCallId: 'call-c' }, loginAbort.signal);
    const loginRequest = host.requests()[0];
    assert.equal(loginRequest.sessionId, 'task-c'); assert.equal(loginRequest.turnId, 'turn-c');
    assert.deepEqual(loginRequest.params, { mode: 'authentication', toolCallId: 'call-c' });
    await assert.rejects(host.openRequestUrl(loginRequest.id), /no longer pending/);
    await host.answer(loginRequest.id, { action: 'accept', content: { ignored: true } });
    assert.deepEqual(await login, { action: 'accept' });
    const cancelledLogin = host.handle('authentication', { serverId: 'login', sessionId: 'task-c', turnId: 'turn-c', toolCallId: 'call-d' }, loginAbort.signal);
    loginAbort.abort(); assert.deepEqual(await cancelledLogin, { action: 'cancel' });
    assert.deepEqual(opened, ['https://auth.example/consent'], 'consent does not navigate before the runtime starts OAuth');
    await assert.rejects(host.handle('open-url', { url: 'file:///C:/Windows' }, signal));
    assert.equal(host.requests().length, 0); assert.ok(changes >= 4);
    await assert.rejects(host.handle('elicitation', { params: { mode: 'client_credentials' } }, signal), /Unsupported MCP elicitation mode/, 'a remote server cannot impersonate the host credential form');
    await writeFile(path, 'plaintext must not be accepted');
    await assert.rejects(host.handle('credentials.read', { key: 'a'.repeat(64) }, signal), /decrypted/);
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'cardbush-'))); await rm(root, { recursive: true, force: true }); }
});
