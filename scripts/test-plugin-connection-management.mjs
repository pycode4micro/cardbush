import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';
import { McpDesktopHost } from '../dist-electron/mcpDesktopHost.js';
import { startProductMcpManagement } from '../dist-electron/productMcpManagement.mjs';
import { loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';

test('plugin owner tools configure connections and save private credentials with revision and cancellation fences', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-management-'));
  const pluginRoot = join(root, 'plugins', 'fixture'), configPath = join(root, 'product', 'config', 'apps.json');
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.stringify({ name: 'fixture', mcpServers: {
    calendar: { type: 'http', url: 'https://calendar.example/mcp', oauth: { client_id: '<CLIENT_ID>', client_secret_env: 'MISSING_SECRET', scopes: ['read'] } },
    files: { type: 'http', url: 'https://files.example/mcp' },
  } });
  await writeFile(manifestPath, manifest);
  const vault = new Map(); let afterSecretWrite, failRefresh = false, failStatus = false;
  const desktop = new McpDesktopHost({ path: join(root, 'unused-vault'), encrypt: () => { throw Error('not used'); }, decrypt: () => { throw Error('not used'); }, changed: () => {}, openUrl: async () => {} });
  const host = new ElectronProductHostController({ dataRoot: join(root, 'product'), runtimeStateRoot: join(root, 'runtime'),
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'skills-user'), bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'plugins-user'),
    credentials: { read: async key => structuredClone(vault.get(key)), write: async (key, value) => {
      if (value) vault.set(key, structuredClone(value)); else vault.delete(key);
      if (value?.clientSecret && afterSecretWrite) { const effect = afterSecretWrite; afterSecretWrite = undefined; await effect(); }
    } },
    requestClientCredentials: (input, signal) => desktop.requestClientCredentials(input, signal),
    runtimeBridge: { command: async request => {
      if (request.command.kind === 'runtime.apply_mcp_snapshot' && failRefresh) throw Error('fixture refresh failed');
      if (request.command.kind === 'runtime.get_mcp_snapshot' && failStatus) throw Error('fixture status unavailable');
      return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true, result: null };
    }, cancelOperation: async () => {} },
  });
  const endpoint = await startProductMcpManagement(() => host);
  const client = new Client({ name: 'plugin-owner-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } } });
  const invoke = async (name, args) => { const result = await client.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const list = () => invoke('list_plugin_connections', { pluginId: 'fixture' });
  const pending = async () => { const until = Date.now() + 2000; while (!desktop.requests().length) { if (Date.now() > until) throw Error('No credential form'); await new Promise(resolve => setTimeout(resolve, 10)); } return desktop.requests()[0]; };
  try {
    await client.connect(transport);
    let info = await list();
    assert.equal(info.connections.length, 2);
    assert.equal(info.connections[0].effective.oauth.clientId, '<CLIENT_ID>');
    let result = await invoke('configure_plugin_connection', { pluginId: 'fixture', componentId: 'calendar', expectedRevision: info.configurationRevision,
      settings: { oauth: { client_id: 'personal-client', callback_port: 12798 }, tools: { list: { approval_mode: 'prompt', parallel_safe: true } } } });
    assert.equal(result.saved, true);
    await host.savePluginConnections({ pluginId: 'fixture', expectedRevision: result.configurationRevision,
      connections: { ...result.connections, files: { connection: { headers: { Authorization: 'PRIVATE_HEADER_FIXTURE' } }, providerOption: { preserved: true } } } });
    const oldRevision = info.configurationRevision;
    info = await list();
    await assert.rejects(host.configurePluginConnection({ pluginId: 'fixture', componentId: 'files', expectedRevision: oldRevision, settings: { enabled: false } }), /configuration changed/);
    const secret = 'PRIVATE_CLIENT_SECRET_FIXTURE';
    const requested = invoke('request_plugin_credentials', { pluginId: 'fixture', componentId: 'calendar', expectedRevision: info.configurationRevision });
    const form = await pending();
    assert.equal(form.params.mode, 'client_credentials');
    assert.equal(form.params.endpoint, 'https://calendar.example/mcp');
    await assert.rejects(desktop.answer(form.id, { action: 'accept', content: { clientId: '<CLIENT_ID>', clientSecret: secret } }), /valid OAuth/);
    assert.equal(desktop.requests().length, 1);
    await desktop.answer(form.id, { action: 'accept', content: { clientId: 'personal-client', clientSecret: secret } });
    result = await requested;
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CLIENT_SECRET_FIXTURE/);
    const ref = result.connections.calendar.oauth.clientSecretRef;
    assert.equal(vault.get(ref).clientSecret.value, secret);
    assert.doesNotMatch(await readFile(configPath, 'utf8'), /PRIVATE_CLIENT_SECRET_FIXTURE/);
    const servers = await loadEnabledProductPluginMcpServers([{ path: join(root, 'plugins'), source: 'bundled' }], configPath);
    assert.equal(servers[0].transport.oauth.clientSecretRef, ref);
    assert.equal(servers[0].transport.oauth.clientSecretEnv, undefined, 'private credentials override stale inherited environment requirements');
    assert.deepEqual(servers[0].transport.oauth.scopes, ['read']);
    info = await list();
    assert.doesNotMatch(JSON.stringify(info), /PRIVATE_CLIENT_SECRET_FIXTURE/);
    result = await invoke('configure_plugin_connection', { pluginId: 'fixture', componentId: 'calendar', expectedRevision: info.configurationRevision,
      settings: { tools: { list: { approval_mode: 'approve' } } } });
    assert.equal(result.connections.calendar.tools.list.parallel_safe, true, 'tool policy patches preserve other fields');
    assert.equal(result.connections.calendar.oauth.clientSecretRef, ref);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_HEADER_FIXTURE/);
    const stored = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(stored.plugins.find(plugin => plugin.id === 'fixture').config.mcp_servers.files.connection.headers.Authorization, 'PRIVATE_HEADER_FIXTURE');
    assert.deepEqual(stored.plugins.find(plugin => plugin.id === 'fixture').config.mcp_servers.files.providerOption, { preserved: true });
    // A concurrent configuration update after vault write must roll back only the uncommitted secret.
    info = await list();
    afterSecretWrite = () => host.configurePluginConnection({ pluginId: 'fixture', componentId: 'files', expectedRevision: info.configurationRevision, settings: { enabled: false } });
    await assert.rejects(host.savePluginConnections({ pluginId: 'fixture', expectedRevision: info.configurationRevision,
      connections: result.connections, secrets: { calendar: 'UNCOMMITTED_FIXTURE_SECRET' } }), /configuration changed/);
    assert.equal(vault.size, 1);
    assert.equal(vault.has(ref), true);
    info = await list();
    assert.equal(info.connections.find(item => item.componentId === 'files').settings.enabled, false);
    const abort = new AbortController();
    const cancelled = host.requestPluginCredentials({ pluginId: 'fixture', componentId: 'calendar', expectedRevision: info.configurationRevision }, abort.signal);
    await pending(); abort.abort(); await assert.rejects(cancelled, /abort/i);
    assert.equal(desktop.requests().length, 0);
    assert.equal((await list()).configurationRevision, info.configurationRevision);
    // Saving is successful even if applying the new snapshot fails; report the separate fact.
    failRefresh = true;
    result = await host.configurePluginConnection({ pluginId: 'fixture', componentId: 'calendar', expectedRevision: info.configurationRevision, settings: { enabled_tools: ['list'] } });
    assert.equal(result.saved, true); assert.match(result.applicationError, /fixture refresh failed/);
    assert.equal(vault.has(ref), true);
    failRefresh = false; failStatus = true;
    result = await host.configurePluginConnection({ pluginId: 'fixture', componentId: 'calendar', expectedRevision: result.configurationRevision, settings: { enabled_tools: ['list', 'read'] } });
    assert.equal(result.saved, true); assert.equal(result.runtime, null); assert.match(result.runtimeError, /fixture status unavailable/);
    assert.match((await list()).runtimeError, /fixture status unavailable/);
    assert.equal(await readFile(manifestPath, 'utf8'), manifest, 'all changes belong to user configuration, not plugin packages');
    const invalid = await client.callTool({ name: 'configure_plugin_connection', arguments: { pluginId: 'fixture', componentId: 'calendar', expectedRevision: result.configurationRevision, settings: { oauth: { client_secret: secret } } } });
    assert.equal(invalid.isError, true);
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_CLIENT_SECRET_FIXTURE/);
  } finally {
    await client.close(); await endpoint.close();
    assert.ok(root.startsWith(join(tmpdir(), 'cardbush-plugin-management-'))); await rm(root, { recursive: true, force: true });
  }
});
