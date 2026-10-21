import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProductPluginCatalog } from './productPlugins.js';

/** Release-owned assets are separate from mutable Agent data and follow the installed version. */
export const agentBundledRoot = fileURLToPath(new URL('../assets', import.meta.url));

const bundledMcpEntries = {
  CARDBUSH_APPS_MCP_ENTRY: 'packages/cardbush-apps-mcp/dist/index.js',
  CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY: 'packages/cardbush-chrome-mcp/dist/index.js',
  CARDBUSH_CHROME_REMOTE_DEBUGGING_MCP_ENTRY: 'assets/plugins/chrome/runtime/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
};

/** Register installed transports without assuming that a service has no display.
 * Connections and captures belong to this Agent; never inherit the client's bridge. */
export function agentBundledMcpEnvironment(dataRoot: string, bundledRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CARDBUSH_CHROME_CONNECTOR_CONFIG: join(dataRoot, 'browser-connector', 'bridge.json'),
    CARDBUSH_BROWSER_CONFIG_PATH: join(dataRoot, 'config', 'browser.json'),
    CARDBUSH_AGENT_DESKTOP_BRIDGE: join(dataRoot, 'desktop-bridge', 'connection.json'),
  };
  for (const [key, relative] of Object.entries(bundledMcpEntries)) {
    const file = join(dirname(bundledRoot), relative);
    if (statSync(file, { throwIfNoEntry: false })?.isFile()) env[key] = file;
  }
  return env;
}

export async function verifyAgentBundledMcp(root: string): Promise<void> {
  for (const file of Object.values(bundledMcpEntries)) {
    if (!(await stat(join(root, file))).isFile()) throw Error(`Agent bundled MCP entry is missing: ${file}`);
  }
}

export async function verifyAgentBundledAssets(root = agentBundledRoot): Promise<string> {
  const plugins = join(root, 'plugins');
  const marketplace = JSON.parse(await readFile(join(plugins, 'marketplace.json'), 'utf8'));
  if (!Array.isArray(marketplace.plugins)) throw Error('Agent bundled plugin marketplace is invalid.');
  const catalog = await loadProductPluginCatalog([{ path: plugins, source: 'bundled' }]);
  const available = new Set(catalog.map(plugin => plugin.id));
  for (const entry of marketplace.plugins) {
    if (typeof entry.name !== 'string' || !available.has(entry.name)) {
      throw Error(`Agent bundled plugin is missing or invalid: ${String(entry.name)}. Install the complete Agent package.`);
    }
  }
  if (!(await stat(join(root, 'skills'))).isDirectory()) throw Error('Agent bundled skills directory is missing.');
  return root;
}
