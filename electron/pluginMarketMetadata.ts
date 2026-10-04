import { readPluginManifestHeader } from './pluginManifest';
import { safePackagePath } from './pluginPackagePaths';
import { missingPluginVariables } from './pluginEnvironment';
import type { PluginMarketPreview } from './pluginMarketplaceTypes';

type Json = Record<string, unknown>;

/** A declaration preview is deliberately not a claim that all package files were validated. */
export async function readMarketMetadata(read: (file: string) => Promise<string>, entry: Json) {
  const files = new Map<string, Promise<Json | null>>();
  const json = (file: string) => {
    const path = safePackagePath(file);
    let pending = files.get(path);
    if (!pending) {
      if (files.size >= 64) throw new Error('Plugin metadata references too many configuration files.');
      pending = read(path).then(text => {
        const value = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid plugin JSON object: ${path}`);
        return value as Json;
      }, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
      files.set(path, pending);
    }
    return pending;
  };
  const { manifest, format, issues } = await readPluginManifestHeader(json, entry);
  if (manifest.name !== entry.name) throw new Error('Marketplace entry does not match the plugin manifest name.');
  const metadata = object(manifest.interface), author = object(manifest.author);
  const components: PluginMarketPreview['components'] = [];
  const sources = format === 'agent-plugins' ? ['mcp.json'] : list(manifest.mcpServers);
  if (format === 'claude' || manifest.mcpServers === undefined) sources.unshift('.mcp.json');
  const servers: Json = {};
  for (const source of sources) {
    const config = typeof source === 'string' ? await json(source) : object(source);
    if (!config) continue;
    for (const [name, server] of Object.entries(object(config.mcpServers ?? config))) if (name !== '$schema') servers[name] = server;
  }
  const overrides = object(object(object(object(manifest.cardbush).runtime).mcpServersByPlatform)[process.platform]);
  for (const [name, server] of Object.entries(overrides)) servers[name] = { ...object(servers[name]), ...object(server) };
  for (const name of Object.keys(servers)) components.push({ kind: 'mcp', name, description: '' });
  for (const [key, kind] of [['skills', 'skill'], ['agents', 'agent'], ['commands', 'command'], ['hooks', 'hook'], ['apps', 'app']] as const) {
    const paths = key === 'skills' && format === 'agent-plugins' ? ['./skills'] : list(manifest[key]);
    for (const value of paths) components.push({ kind, name: typeof value === 'string' ? value : key, description: '' });
  }
  const variables = missingPluginVariables(servers);
  return {
    id: String(entry.name), name: text(metadata.displayName) || String(entry.name),
    description: text(metadata.longDescription ?? metadata.shortDescription ?? manifest.description),
    version: text(manifest.version), developerName: text(metadata.developerName ?? author.name) || 'Unknown',
    format, components, issues, requirements: [...new Set(Object.values(servers).map(server => text(object(server).command)).filter(Boolean))],
    warnings: variables.length ? [{ code: 'variables', detail: variables.join(', ') }] : [],
    validation: 'metadata' as const,
  };
}

function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function list(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
