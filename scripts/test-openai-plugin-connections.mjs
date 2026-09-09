import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mcpServerSnapshotSchema, OPENAI_HOSTED_PROTOCOL } from '@cardbush/bush-protocol';
import { resolvePluginMcpConnection } from '../dist-electron/pluginMcpConfiguration.mjs';
import { loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';

const bundled = { calendar: { type: 'http', url: 'https://calendar.example/mcp', oauth: { client_id: '<CLIENT_ID>' }, headers: { 'X-Package': 'private-fixture' } } };
const apps = { calendar: { id: 'connector_fixture' } };
const connection = (settings = {}, declarations = bundled, standalone = []) => mcpServerSnapshotSchema.parse(resolvePluginMcpConnection('calendar', 'calendar', process.cwd(), declarations, apps, settings, standalone));

test('registered applications use hosted MCP by default without inheriting bundled OAuth or headers; explicit direct settings win', () => {
  for (const declarations of [bundled, {}]) {
    const server = connection({}, declarations);
    assert.deepEqual(server.transport, { kind: 'streamable_http', url: OPENAI_HOSTED_PROTOCOL.mcpEndpoint, headers: {}, auth: 'openai', openaiAppId: 'connector_fixture' });
    assert.equal(server.defaultToolPolicy.permission, 'ask'); assert.equal(server.versionMode, 'legacy');
  }
  for (const settings of [{ provider: 'direct' }, { oauth: { client_id: 'personal-client' } }, { connection: { url: 'https://personal.example/mcp' } }, { connection: { headers: { Authorization: 'personal-token' } } }]) {
    const server = connection(settings); assert.equal(server.transport.auth, 'oauth');
    assert.equal(server.transport.url, settings.connection?.url ?? bundled.calendar.url);
  }
  const standalone = [{ id: 'personal', enabled: true, transport: { kind: 'stdio', command: 'fixture', args: [] } }];
  assert.equal(connection({ server: 'personal' }, bundled, standalone).transport.kind, 'stdio');
  const hosted = connection({ provider: 'openai', oauth: { clientId: 'personal-client' }, required: true,
    enabled_tools: ['read'], default_tools_approval_mode: 'approve', tools: { read: { approval_mode: 'prompt' }, write: { approval_mode: 'deny' } } });
  assert.equal(hosted.required, true); assert.deepEqual(hosted.exposeTools, ['read']);
  assert.equal(hosted.defaultToolPolicy.permission, 'allow'); assert.equal(hosted.toolPolicies.read.permission, 'ask');
  assert.equal(hosted.toolPolicies.write.enabled, false); assert.equal(hosted.transport.oauth, undefined);
  assert.equal(resolvePluginMcpConnection('calendar', 'calendar', process.cwd(), bundled, apps, { enabled: false }), null);
  assert.throws(() => resolvePluginMcpConnection('calendar', 'calendar', process.cwd(), bundled, apps, { enabled: false, required: true }), /requires MCP/);
});

test('installed OpenAI app-only and combined packages load directly without editing package sources', async () => {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-openai-plugin-'));
  try {
    const roots = [{ path: join(root, 'plugins'), source: 'user' }], originals = new Map();
    for (const name of ['app-only', 'combined']) {
      const directory = join(roots[0].path, name); await mkdir(join(directory, '.codex-plugin'), { recursive: true });
      for (const [file, value] of [['.codex-plugin/plugin.json', { name, apps: './.app.json', ...(name === 'combined' ? { mcpServers: bundled } : {}) }], ['.app.json', { apps }]]) {
        const path = join(directory, file), content = JSON.stringify(value); await writeFile(path, content); originals.set(path, content);
      }
    }
    const servers = await loadEnabledProductPluginMcpServers(roots, join(root, 'apps.json'));
    assert.equal(servers.length, 2);
    for (const server of servers) {
      assert.equal(server.transport.auth, 'openai'); assert.equal(server.transport.openaiAppId, 'connector_fixture');
      assert.doesNotMatch(JSON.stringify(server), /CLIENT_ID|private-fixture|personal-client/);
    }
    for (const [path, content] of originals) assert.equal(await readFile(path, 'utf8'), content);
  } finally { assert.ok(root.startsWith(parent + sep + 'cardbush-openai-plugin-')); await rm(root, { recursive: true, force: true }); }
});
