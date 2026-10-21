import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentBundledMcpEnvironment } from '../dist-electron/agentBundledAssets.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';

const base = resolve('tmp/agent-bundled-mcp-tests');
async function fixture(t) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'agent-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/apps.json'), JSON.stringify({ protocol: 'cardbush.apps.config.v1', revision: 1,
    serviceEnabled: true, plugins: ['computer-use','chrome'].map(id => ({ id, installed: true, enabled: true,
      config: id==='computer-use' ? {screenshotDirectory:'',allowOpenApp:true,allowWindowClose:true,yieldToUser:true,restorePointer:true} : {} })) }));
  return root;
}

test('Agent MCP paths come from its release and isolated data, not a connecting desktop profile', () => {
  const root = resolve('tmp/isolated-agent'), bundled = resolve('assets');
  const env = agentBundledMcpEnvironment(root, bundled);
  assert.equal(env.CARDBUSH_APPS_MCP_ENTRY, resolve('packages/cardbush-apps-mcp/dist/index.js'));
  assert.equal(env.CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY, resolve('packages/cardbush-chrome-mcp/dist/index.js'));
  assert.equal(env.CARDBUSH_CHROME_CONNECTOR_CONFIG, join(root,'browser-connector','bridge.json'));
  assert.equal(env.CARDBUSH_BROWSER_CONFIG_PATH, join(root,'config','browser.json'));
  assert.equal(env.CARDBUSH_AGENT_DESKTOP_BRIDGE, join(root,'desktop-bridge','connection.json'));
  assert.equal(env.CARDBUSH_MCP_DESKTOP_BRIDGE, undefined);
  assert.equal(agentBundledMcpEnvironment(root,join(root,'empty-release/assets')).CARDBUSH_APPS_MCP_ENTRY,undefined);
});

test('enabled desktop and browser MCP tools are discoverable in service mode without running a model or controlling a desktop', async t => {
  const root = await fixture(t);
  const service = await AgentService.open({ dataRoot: root, bundledRoot: resolve('assets'), env: {
    CARDBUSH_APPS_MCP_ENTRY: '/unrelated-client/apps.js', CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY: '/unrelated-client/browser.js',
    CARDBUSH_CHROME_CONNECTOR_CONFIG: '/unrelated-client/bridge.json', CARDBUSH_MCP_DESKTOP_BRIDGE: '1',
    CARDBUSH_AGENT_DESKTOP_BRIDGE: '/unrelated-client/desktop-bridge.json',
  } });
  try {
    let servers;
    const start = Date.now();
    do {
      servers = (await service.call('mcp.list', {})).runtime?.servers ?? [];
      if (servers.some(s=>s.id==='cardbush_apps'&&s.health==='ready') && servers.some(s=>s.id==='browser_use'&&s.health==='ready')) break;
      await delay(50);
    } while (Date.now()-start<15000);
    for (const id of ['cardbush_apps','browser_use']) {
      const server=servers.find(s=>s.id===id);
      assert.equal(server?.health,'ready',JSON.stringify(servers));
      assert.ok(server.tools.length>0);
    }
    assert.equal(service.info().capabilities.desktop,false,'the built-in Linux backend is not falsely advertised');
  } finally { await service.close(); }
});
