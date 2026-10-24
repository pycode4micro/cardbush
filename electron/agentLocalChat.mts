import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import { AgentChatDiagnostics } from './agentChatDiagnostics.mjs';
import { connectLocalRuntime } from './agentLocalRuntime.mjs';

export type ChatClient = Pick<AgentHttpClient, 'info' | 'call' | 'events'> & {
  readonly modelConfigurationPath?: string;
  readonly settingsDirectory?: string;
  readonly diagnostics?: Pick<AgentChatDiagnostics, 'path' | 'error'>;
  reloadSettings?(): Promise<unknown>;
  reconnect?(): Promise<void>;
  close(): void | Promise<void>;
};

/** Electron's default profile location; a caller may choose an explicit profile.
 * Session data stays in the CLI directory, never in the desktop Runtime. */
export function localDesktopProfile(env = process.env, home = homedir(), platform = process.platform) {
  if (env.CARDBUSH_CLI_PROFILE_DIR) return resolve(env.CARDBUSH_CLI_PROFILE_DIR);
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'cardbush');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'cardbush');
  const xdg = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(xdg, 'cardbush');
}

export async function openLocalChatClient(options: { dataRoot?: string; profileRoot?: string; bundledRoot?: string } = {}): Promise<ChatClient> {
  const path = resolve(options.dataRoot ?? process.env.CARDBUSH_CLI_DATA_DIR ?? join(homedir(), '.cardbush', 'cli-agent'));
  await mkdir(path, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(path);
  // One settings source, even before the App has been installed or configured.
  // dataRoot owns CLI conversations/logs, never a competing models.json.
  const profile = resolve(options.profileRoot ?? localDesktopProfile());
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const localProfileRoot = await realpath(profile);
  const settingsDirectory = join(localProfileRoot, 'product-host', 'config');
  const { verifyAgentBundledAssets, verifyAgentBundledMcp } = await import('./agentBundledAssets.mjs');
  const bundledRoot = await realpath(await verifyAgentBundledAssets(options.bundledRoot));
  await verifyAgentBundledMcp(resolve(bundledRoot, '..'));
  let shared = await connectLocalRuntime(dataRoot, localProfileRoot, bundledRoot);
  let closed = false, reconnecting: Promise<void> | undefined;
  const reconnect = (): Promise<void> => {
    if (closed) return Promise.reject(new Error('This local CLI connection is closed.'));
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      // Release only this window's old lease. The host still owns all jobs;
      // reconnecting may replace a crashed host but never resubmits a turn.
      await shared.close();
      if (closed) return;
      const next = await connectLocalRuntime(dataRoot, localProfileRoot, bundledRoot);
      if (closed) { await next.close(); return; }
      shared = next;
    })().finally(() => { reconnecting = undefined; });
    return reconnecting;
  };
  return {
    diagnostics: { path: join(dataRoot, 'logs', 'runtime.log'), get error() { return shared.diagnostics.error; } },
    settingsDirectory,
    modelConfigurationPath: join(settingsDirectory, 'models.json'),
    reloadSettings: async () => { const response = await shared.client.localRequest('reload'); return response.json(); },
    info: signal => shared.client.info(signal),
    call: (operation, input, signal) => shared.client.call(operation, input, signal),
    events: (input, signal) => shared.client.events(input, signal),
    reconnect,
    close: async () => { closed = true; await shared.close(); await reconnecting?.catch(() => undefined); },
  };
}
