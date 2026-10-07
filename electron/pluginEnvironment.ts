import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const rootVariables = ['PLUGIN_ROOT', 'CARDBUSH_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'];
const dataVariables = ['PLUGIN_DATA', 'CLAUDE_PLUGIN_DATA'];
const processHostVariables = ['CARDBUSH_PROCESS_HOST_DIRECTORY', 'CARDBUSH_PROCESS_HOST_PATH'];
export const pluginHostVariables = new Set([...rootVariables, ...dataVariables, ...processHostVariables, 'CARDBUSH_NODE_EXECUTABLE', 'CARDBUSH_DOCUMENT_TOOLS_ENTRY']);

/** Share the existing Hook data directory; package updates never replace it. */
export function pluginDataDirectory(pluginId: string, dataRoot: string) {
  return join(dataRoot, createHash('sha256').update(pluginId).digest('hex').slice(0, 24));
}

export function pluginHostEnvironment(pluginId: string, root: string, dataRoot?: string): Record<string, string> {
  let documents: string | undefined;
  try { documents = createRequire(__filename).resolve('@cardbush/document-tools/server'); } catch { /* Older standalone hosts may not include document tools. */ }
  return Object.fromEntries([
    ['CARDBUSH_NODE_EXECUTABLE', process.execPath],
    ...(documents ? [['CARDBUSH_DOCUMENT_TOOLS_ENTRY', documents]] : []),
    ...processHostVariables.filter(name => process.env[name]).map(name => [name, process.env[name]!]),
    ...rootVariables.map(name => [name, root]),
    ...(dataRoot ? dataVariables.map(name => [name, pluginDataDirectory(pluginId, dataRoot)]) : []),
  ]);
}

export function missingPluginVariables(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)]
    .filter(([, name, fallback]) => !pluginHostVariables.has(name) && fallback === undefined && !process.env[name])
    .map(([, name]) => name))];
}

export class MissingPluginEnvironmentError extends Error {
  constructor(pluginId: string, name: string, variables: Set<string>, readonly required: boolean) {
    super(`Plugin ${pluginId} / ${name}: configure environment variables before connecting: ${[...variables].join(', ')}`);
    this.name = 'MissingPluginEnvironmentError';
  }
}
