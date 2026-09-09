import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, isAbsolute } from 'node:path';
import type { PluginMarketPreview } from './pluginMarketplaceTypes';
import { readPluginExtensions } from './pluginExtensions';

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const string = (value: unknown) => typeof value === 'string' ? value : '';

/** Adapt acquisition formats into CardBush's existing OpenAI plugin representation. */
export async function importPluginManifest(root: string, entry: Json) {
  const native = await jsonIfPresent(join(root, '.codex-plugin', 'plugin.json'));
  const claude = native ? null : await jsonIfPresent(join(root, '.claude-plugin', 'plugin.json')) ?? (entry.strict === false ? { name: entry.name } : null);
  if (!native && !claude) throw new Error('The plugin has no .codex-plugin/plugin.json or .claude-plugin/plugin.json.');
  const format = native ? 'openai' as const : 'claude' as const;
  const original = native ?? claude!;
  const manifest: Json = { ...original };
  const issues: PluginMarketPreview['issues'] = [];
  if (format === 'claude') {
    for (const key of ['skills', 'mcpServers', 'hooks', 'agents', 'commands', 'lspServers', 'dependencies', 'apps', 'userConfig', 'channels', 'experimental', 'themes', 'monitors', 'workflows', 'outputStyles']) {
      if (entry[key] !== undefined && manifest[key] === undefined) manifest[key] = entry[key];
      else if (entry[key] !== undefined && JSON.stringify(entry[key]) !== JSON.stringify(manifest[key])) issues.push({ code: 'conflicting', detail: key });
    }
    manifest.version ||= entry.version || '0.0.0';
    manifest.description ||= entry.description || manifest.name;
    manifest.author ||= entry.author;
    manifest.interface = { ...object(manifest.interface), category: string(entry.category) || 'Other' };
  }
  if (manifest.name !== entry.name) throw new Error('Marketplace entry does not match the plugin manifest name.');
  // Both formats conventionally bundle Skills under skills/ and MCP in .mcp.json.
  if (manifest.skills === undefined && await exists(join(root, 'skills'))) manifest.skills = './skills';
  if (manifest.mcpServers === undefined && await exists(join(root, '.mcp.json'))) manifest.mcpServers = './.mcp.json';
  if (manifest.commands === undefined && await exists(join(root, 'commands'))) manifest.commands = './commands';
  if (format === 'claude' && manifest.skills !== undefined) {
    const paths = Array.isArray(manifest.skills) ? [...manifest.skills] : [manifest.skills];
    if (await exists(join(root, 'skills')) && !paths.some(value => typeof value === 'string' && resolve(root, value) === join(root, 'skills'))) paths.unshift('./skills');
    manifest.skills = paths;
  }
  if (Array.isArray(manifest.skills)) {
    const paths = manifest.skills;
    const gathered = join(root, '.cardbush-imported-skills');
    await mkdir(gathered);
    const names = new Set<string>();
    for (const candidate of paths) {
      if (typeof candidate !== 'string') throw new Error('Skill paths must be strings.');
      const directory = child(root, candidate);
      const packages = await exists(join(directory, 'SKILL.md')) ? [directory]
        : (await readdir(directory, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => join(directory, item.name));
      for (const path of packages) {
        if (!await exists(join(path, 'SKILL.md'))) continue;
        const name = basename(path);
        if (names.has(name.toLowerCase())) throw new Error('Multiple Skill roots contain the same Skill folder name.');
        names.add(name.toLowerCase());
        await cp(path, join(gathered, name), { recursive: true, errorOnExist: true });
      }
    }
    manifest.skills = './.cardbush-imported-skills';
  }
  const configured = manifest.mcpServers;
  if (configured !== undefined) {
    const sources = Array.isArray(configured) ? [...configured] : [configured];
    if (format === 'claude' && await exists(join(root, '.mcp.json')) && !sources.some(value => typeof value === 'string' && resolve(root, value) === join(root, '.mcp.json'))) sources.unshift('./.mcp.json');
    const servers: Json = {};
    for (const candidate of sources) {
      const config = typeof candidate === 'string'
        ? object(JSON.parse(await readFile(child(root, candidate), 'utf8'))) : object(candidate);
      for (const [name, server] of Object.entries(object(config.mcpServers ?? config))) {
        if (name in servers) throw new Error('Multiple MCP configs use the same server name.');
        servers[name] = server;
      }
    }
    // Expand to the installed root later, never to the temporary preview directory.
    const normalized = JSON.stringify(servers).replaceAll('${CLAUDE_PLUGIN_ROOT}', '${CARDBUSH_PLUGIN_ROOT}')
      .replaceAll('${CODEX_PLUGIN_ROOT}', '${CARDBUSH_PLUGIN_ROOT}');
    manifest.mcpServers = JSON.parse(normalized);
  }
  const extensions = await readPluginExtensions(root, manifest);
  issues.push(...extensions.issues);
  const unsupported = ['lspServers', 'dependencies', 'apps', 'userConfig', 'channels', 'experimental', 'themes', 'monitors', 'workflows', 'outputStyles'].filter(key => manifest[key]);
  for (const directory of ['.lsp.json', 'monitors', 'themes', 'workflows', 'output-styles']) {
    if (!unsupported.includes(directory) && await exists(join(root, directory))) unsupported.push(directory);
  }
  if (unsupported.length) issues.push({ code: 'components', detail: unsupported.join(', ') });
  await mkdir(join(root, '.codex-plugin'), { recursive: true });
  await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2));
  return { manifest, format, issues, notes: extensions.notes };
}

function child(root: string, value: string) {
  const target = resolve(root, value), rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plugin component path escapes its root.');
  return target;
}
async function exists(file: string) { return Boolean(await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })); }
async function jsonIfPresent(file: string): Promise<Json | null> {
  try { return object(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
