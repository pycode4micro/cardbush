import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const { mcpConnectionState, pluginMcpConnections } = await loadChatTranscript({ source:
  ['src/backend/mcpConnectionOverview.ts', 'src/features/plugins/pluginConnections.ts']
    .map(file => `export * from ${JSON.stringify(resolve(file))};`).join('\n') });
const snapshot = { protocol: 'bush.mcp_snapshot_result.v1', snapshotId: 'cardbush-product-mcp',
  revision: 2_000_004, configurationRevision: 2, applicationState: 'applied',
  servers: [{ id: 'blender', health: 'ready', tools: [{ remoteName: 'summary', runtimeName: 'mcp__blender__summary' }] }] };
assert.equal(mcpConnectionState('blender', true, snapshot, 2), 'connected', 'runtime composite revision is distinct from configuration revision');
assert.equal(mcpConnectionState('blender', true, snapshot, 3), 'unknown', 'older connection cannot confirm a newly saved config');
assert.equal(mcpConnectionState('missing', true, snapshot, 2), 'unknown');
assert.equal(mcpConnectionState('blender', true, { ...snapshot, applicationState: 'pending', pendingRevision: 3_000_004, configurationRevision: 3 }, 3), 'pending');
assert.equal(mcpConnectionState('blender', false, { ...snapshot, applicationState: 'pending' }, 2), 'pending', 'queued disable is not applied yet');
assert.equal(mcpConnectionState('blender', true, { ...snapshot, applicationState: 'failed' }, 2), 'unavailable');
assert.equal(mcpConnectionState('blender', true, { ...snapshot, servers: [{ id: 'blender', health: 'unavailable', tools: [] }] }, 2), 'unavailable');
assert.equal(mcpConnectionState('blender', true, { ...snapshot, servers: [{ id: 'blender', health: 'restarting', tools: [] }] }, 2), 'restarting');
assert.equal(mcpConnectionState('blender', false, snapshot, 2), 'disabled');
assert.equal(mcpConnectionState('blender', true, null, 2), 'unknown');
assert.equal(mcpConnectionState('blender', true, { ...snapshot, snapshotId: 'different' }, 2), 'unknown');

const plugin = (id, component) => ({ id, name: id, installed: true, enabled: true,
  components: [{ kind: 'mcp', id: component, name: component, description: '' }] });
const plugins = [plugin('computer-use', 'cardbush_apps'), plugin('chrome', 'chrome-devtools'), plugin('example.tools', 'echo')];
const overview = { revision: 2, snapshot, servers: [{ id: 'blender', name: 'Blender MCP', description: '', enabled: true, transport: 'stdio' }] };
const entries = pluginMcpConnections(plugins, overview, true);
assert.equal(entries.map(item => item.id).join(','), 'cardbush_apps,chrome_devtools,plugin_example_tools_echo,blender');
assert.equal(entries.at(-1).plugin, undefined);
assert.equal(entries.at(-1).state, 'connected');
assert.equal(entries.at(-1).toolCount, 1);
assert.equal(pluginMcpConnections(plugins, { ...overview, servers: [...overview.servers, { id: 'plugin_example_tools_echo', name: 'Conflicting config', enabled: true }] }, true).length, 5, 'a standalone ID collision must remain visible and editable');
assert.equal(pluginMcpConnections(plugins, overview, false).at(-1).state, 'connected', 'plugin service switch does not disable independent MCP');
assert.equal(pluginMcpConnections(plugins.map(item => ({ ...item, installed: false })), overview, true).length, 1);
assert.equal(pluginMcpConnections(plugins, { ...overview, snapshot: null }, true).at(-1).state, 'unknown', 'runtime outage keeps configured servers visible');
console.log('Plugin connections passed: ownership, visibility, runtime health and configuration revision.');
