import type { RuntimeRendererHost } from '@cardbush/bush-runtime';
let host: RuntimeRendererHost;
export function setHost(value: RuntimeRendererHost) { host = value; }
export const command = <T = unknown>(kind: string, payload: unknown): Promise<T> => host.command(kind, payload) as Promise<T>;
export const synchronizeTools = () => host.synchronizeTools();
export const runtimeClient = {
  getToolCatalog: () => command<import('@cardbush/bush-protocol').ToolDefinition[]>('runtime.get_tool_catalog', {}),
  getTeamSnapshot: () => command<import('@cardbush/bush-protocol').TeamSnapshotResult | null>('runtime.get_team_snapshot', {}),
  applyTeamSnapshot: (snapshot: import('@cardbush/bush-protocol').TeamSnapshot) => command<import('@cardbush/bush-protocol').TeamSnapshotResult>('runtime.apply_team_snapshot', snapshot),
};
export async function teamConfiguration(input: { action: string; configuration?: unknown; expectedHash?: string; migration?: unknown }) {
  if (input.action === 'import') {
    const text = await host.configurationFile({ action: 'import' });
    return text === null ? null : command('plugin.team.configuration', { action: 'decode', text });
  }
  if (input.action === 'export') {
    const [text, yaml] = await Promise.all(['json', 'yaml'].map(format => command<string>('plugin.team.configuration', { action: 'encode', configuration: input.configuration, format })));
    return host.configurationFile({ action: 'export', name: 'teams.json', text, yaml });
  }
  if (input.action === 'reveal') return host.configurationFile({ action: 'reveal' });
  return command('plugin.team.configuration', input);
}
