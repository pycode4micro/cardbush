import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import type { AgentDesktopSetup } from './agentDesktopTypes.js';
import type { CardbushAppsRuntimeConfig } from '@cardbush/apps-mcp';

export interface AgentDesktopBridgeConfig {
  protocol: 'cardbush.agent.desktop-bridge.v1';
  agentId: string;
  port: number;
  token: string;
}

/** Host-owned, ACL-protected installation config. Never accept a remote URL or a client desktop bridge. */
export function readAgentDesktopBridge(path: string | undefined, agentId?: string): AgentDesktopBridgeConfig | undefined {
  if (!path) return;
  if (!isAbsolute(path)) throw Error('Agent desktop bridge path must be absolute.');
  let value: AgentDesktopBridgeConfig;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw Error('Agent desktop bridge configuration could not be read.');
  }
  if (!value || value.protocol !== 'cardbush.agent.desktop-bridge.v1' || typeof value.agentId !== 'string' || !value.agentId ||
      agentId && value.agentId !== agentId || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) ||
      Object.keys(value).some(key => !['protocol','agentId','port','token'].includes(key))) {
    throw Error('Invalid Agent desktop bridge configuration or Agent identity mismatch.');
  }
  return value;
}

export function agentDesktopBridgeTransport(config: AgentDesktopBridgeConfig) {
  return { kind: 'streamable_http' as const, url: `http://127.0.0.1:${config.port}/mcp`,
    headers: { Authorization: `Bearer ${config.token}` } };
}

/** Share only Computer Use policy, never the Agent's full config or credentials. */
export function syncAgentDesktopBridgePolicy(bridgePath: string, appsPath: string) {
  const apps = JSON.parse(readFileSync(appsPath, 'utf8'));
  const plugin = apps.plugins?.find((p: { id: string }) => ['computer-use','computer_use'].includes(p.id));
  const config = plugin?.config ?? {};
  const content = JSON.stringify({ serviceEnabled: apps.serviceEnabled === true, plugins: [{ id: 'computer-use',
    installed: plugin?.installed === true, enabled: plugin?.enabled === true,
    config: { screenshotDirectory: '', allowOpenApp: config.allowOpenApp === true, allowWindowClose: config.allowWindowClose === true,
      yieldToUser: config.yieldToUser !== false, restorePointer: config.restorePointer !== false } }] });
  const path = join(dirname(bridgePath),'apps.json');
  try { if (readFileSync(path,'utf8') === content) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary,content,{mode:0o600,flag:'wx'});renameSync(temporary,path); }
  finally { rmSync(temporary,{force:true}); }
}

/** Missing/invalid projected policy must never enable the permissive standalone defaults. */
export function readAgentDesktopBridgePolicy(path: string): CardbushAppsRuntimeConfig {
  const apps = JSON.parse(readFileSync(path, 'utf8'));
  const plugin = apps.plugins?.find((p: { id: string }) => p.id === 'computer-use');
  const config = plugin?.config;
  if (typeof apps.serviceEnabled !== 'boolean' || typeof plugin?.installed !== 'boolean' ||
      typeof plugin?.enabled !== 'boolean' || !config ||
      ['allowOpenApp', 'allowWindowClose', 'yieldToUser', 'restorePointer'].some(key => typeof config[key] !== 'boolean')) {
    throw Error('Interactive desktop policy is missing or invalid.');
  }
  return { serviceEnabled: apps.serviceEnabled, computerUse: {
    installed: plugin.installed, enabled: apps.serviceEnabled && plugin.enabled,
    config: { screenshotDirectory: '', allowOpenApp: config.allowOpenApp, allowWindowClose: config.allowWindowClose,
      yieldToUser: config.yieldToUser, restorePointer: config.restorePointer },
  } };
}

/** Local IPC must not inherit a model/provider HTTP proxy. No screen capture or input. */
export function inspectAgentDesktopBridge(config: AgentDesktopBridgeConfig): Promise<AgentDesktopSetup> {
  return new Promise((resolve, reject) => {
    const request = get(`http://127.0.0.1:${config.port}/status`, { headers: { Authorization: `Bearer ${config.token}` } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024) request.destroy(Error('Invalid desktop bridge status.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw Error('Desktop bridge is not available.');
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value.agentId !== config.agentId || !['ready','blocked','missing','unknown'].includes(value.setup?.environment) || !Array.isArray(value.setup?.checks)) throw Error('Invalid desktop bridge status.');
          resolve(value.setup);
        } catch { reject(Error('Desktop bridge status could not be verified.')); }
      });
    });
    const timer = setTimeout(() => request.destroy(Error('Desktop bridge status timed out.')), 12_000);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject);
  });
}
