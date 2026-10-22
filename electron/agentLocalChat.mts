import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentHttpClient } from './agentHttpClient.mjs';
import type { AgentEventFrame, AgentEventRequest, AgentOperation } from './agentTypes.js';
import { AgentChatDiagnostics } from './agentChatDiagnostics.mjs';

export type ChatClient = Pick<AgentHttpClient, 'info' | 'call' | 'events'> & {
  readonly modelConfigurationPath?: string;
  readonly settingsDirectory?: string;
  readonly diagnostics?: Pick<AgentChatDiagnostics, 'path' | 'error'>;
  reloadSettings?(): Promise<unknown>;
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
  const dataRoot = resolve(options.dataRoot ?? process.env.CARDBUSH_CLI_DATA_DIR ?? join(homedir(), '.cardbush', 'cli-agent'));
  // One settings source, even before the App has been installed or configured.
  // dataRoot owns CLI conversations/logs, never a competing models.json.
  const localProfileRoot = resolve(options.profileRoot ?? localDesktopProfile());
  const settingsDirectory = join(localProfileRoot, 'product-host', 'config');
  const [{ AgentService }, { verifyAgentBundledAssets, verifyAgentBundledMcp }] = await Promise.all([
    import('./agentService.mjs'), import('./agentBundledAssets.mjs'),
  ]);
  const bundledRoot = await verifyAgentBundledAssets(options.bundledRoot);
  await verifyAgentBundledMcp(resolve(bundledRoot, '..'));
  const diagnostics = new AgentChatDiagnostics(join(dataRoot, 'logs', 'runtime.log'));
  const service = await AgentService.open({ dataRoot, localProfileRoot, bundledRoot, local: true, name: 'CardBush CLI', runtimeDiagnostic: diagnostics.write })
    .catch(error => { diagnostics.close(); throw error; });
  const closed = new AbortController();
  return {
    diagnostics,
    settingsDirectory,
    modelConfigurationPath: join(settingsDirectory, 'models.json'),
    reloadSettings: () => service.product.refreshMcp(),
    async info(signal?: AbortSignal) { signal?.throwIfAborted(); return service.info(); },
    async call(operation: AgentOperation, input: Record<string, unknown>, signal?: AbortSignal) {
      signal?.throwIfAborted(); closed.signal.throwIfAborted();
      return service.call(operation, input, signal ? AbortSignal.any([closed.signal, signal]) : closed.signal);
    },
    async *events(input: AgentEventRequest, signal: AbortSignal): AsyncIterable<AgentEventFrame> {
      let cursor = input.afterSequence ?? null;
      for await (const event of service.eventStream(input, AbortSignal.any([closed.signal, signal]))) { cursor = event.sequence; yield { type: 'event', event }; }
      yield { type: 'end', afterSequence: cursor };
    },
    async close() { closed.abort(); try { await service.close(); } finally { diagnostics.close(); } },
  };
}
