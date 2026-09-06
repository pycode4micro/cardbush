import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  CardbushPluginCatalogEntry,
  CardbushPluginComponent,
} from '@cardbush/product-host' with { 'resolution-mode': 'import' };

export interface PluginRoot {
  path: string;
  source: 'bundled' | 'user';
}

export interface EnabledProductPluginSkillRoot {
  path: string;
  pluginId: string;
  pluginName: string;
  pluginSource: PluginRoot['source'];
}

interface MarketplaceEntry {
  name: string;
  path: string;
  installation: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT';
}

let pluginInstallQueue: Promise<void> = Promise.resolve();

export async function loadProductPluginCatalog(
  roots: PluginRoot[],
): Promise<CardbushPluginCatalogEntry[]> {
  await pluginInstallQueue;
  const plugins = new Map<string, CardbushPluginCatalogEntry>();
  for (const root of roots) {
    const rootPath = resolve(root.path);
    const entries = await marketplaceEntries(rootPath);
    for (const entry of entries) {
      const pluginRoot = resolve(rootPath, entry.path);
      if (!inside(rootPath, pluginRoot)) continue;
      const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
      const manifest = await readJson(manifestPath).catch(() => null);
      if (!manifest) continue;
      const plugin = await decodeManifest({
        manifest,
        manifestPath,
        pluginRoot,
        source: root.source,
        installation: root.source === 'user' ? 'INSTALLED_BY_DEFAULT' : entry.installation,
      });
      if (entry.name && entry.name !== plugin.id) {
        throw new Error(`Marketplace entry ${entry.name} does not match plugin manifest ${plugin.id}.`);
      }
      plugins.set(plugin.id, plugin);
    }
  }
  return [...plugins.values()];
}

/**
 * Resolves Skill roots from installed and enabled plugins against the current
 * catalog. Paths stored in the user configuration are deliberately ignored so
 * a development checkout move or packaged-app upgrade cannot leave stale or
 * user-edited executable paths behind.
 */
export async function loadEnabledProductPluginSkillRoots(
  roots: PluginRoot[],
  configPath: string,
): Promise<string[]> {
  return (await loadEnabledProductPluginSkillRootEntries(roots, configPath))
    .map((entry) => entry.path);
}

export async function loadEnabledProductPluginSkillRootEntries(
  roots: PluginRoot[],
  configPath: string,
): Promise<EnabledProductPluginSkillRoot[]> {
  const catalog = await loadEnabledProductPlugins(roots, configPath);
  const result = new Map<string, EnabledProductPluginSkillRoot>();
  for (const plugin of catalog) {
    for (const root of plugin.skillRoots ?? []) {
      const resolvedRoot = resolve(root);
      result.set(resolvedRoot, {
        path: resolvedRoot,
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginSource: plugin.source,
      });
    }
  }
  return [...result.values()];
}

async function loadEnabledProductPlugins(roots: PluginRoot[], configPath: string) {
  const catalog = await loadProductPluginCatalog(roots);
  let snapshot: Record<string, unknown> | null = null;
  try {
    snapshot = await readJson(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (snapshot && snapshot.serviceEnabled === false) return [];
  const stored = new Map<string, Record<string, unknown>>();
  if (snapshot && Array.isArray(snapshot.plugins)) {
    for (const candidate of snapshot.plugins) {
      const state = objectOrEmpty(candidate);
      const id = string(state.id);
      if (id) stored.set(id, state);
    }
  }
  return catalog.filter((plugin) => {
    const state = stored.get(plugin.id);
    const installed = state
      ? state.installed === true
      : plugin.installation === 'INSTALLED_BY_DEFAULT';
    const enabled = installed && (state ? state.enabled === true : installed);
    return enabled;
  });
}

/** External plugin MCP servers use their own namespace and explicit permission. */
export async function loadEnabledProductPluginMcpServers(roots: PluginRoot[], configPath: string) {
  const servers: Record<string, unknown>[] = [];
  for (const plugin of await loadEnabledProductPlugins(roots, configPath)) {
    // These two integrations have product-owned launchers in Runtime Host.
    if (plugin.id === 'computer-use' || plugin.id === 'chrome') continue;
    const root = dirname(dirname(plugin.manifestPath));
    const manifest = await readJson(plugin.manifestPath);
    const configured = manifest.mcpServers;
    if (!configured) continue;
    const config = typeof configured === 'string'
      ? await readJson(safePluginPath(root, configured)) : object(configured, 'Invalid plugin MCP configuration.');
    for (const [name, candidate] of Object.entries(objectOrEmpty(config.mcpServers ?? config))) {
      const server = object(candidate, 'Plugin MCP server must be an object.');
      const expand = (value: unknown) => string(value).replaceAll('${CARDBUSH_PLUGIN_ROOT}', root);
      const stringMap = (value: unknown) => Object.fromEntries(
        Object.entries(objectOrEmpty(value)).map(([key, item]) => [key, expand(item)]),
      );
      const kind = string(server.type ?? server.transport) || (server.url ? 'http' : 'stdio');
      if (!['stdio', 'http', 'streamable_http', 'sse'].includes(kind)) {
        throw new Error(`Unsupported MCP transport in plugin ${plugin.id}: ${kind}`);
      }
      servers.push({
        id: `plugin_${plugin.id.replaceAll('.', '_')}_${name}`,
        transport: kind === 'stdio' ? {
          kind, command: expand(server.command), args: stringArray(server.args).map(expand),
          cwd: server.cwd ? resolve(root, expand(server.cwd)) : root,
          env: stringMap(server.env),
        } : {
          kind: kind === 'http' ? 'streamable_http' : kind,
          url: expand(server.url), headers: stringMap(server.headers),
        },
        defaultToolPolicy: { permission: 'ask', parallelSafe: false, visibleToChild: true },
        toolPolicies: {},
      });
    }
  }
  if (new Set(servers.map((server) => server.id)).size !== servers.length) {
    throw new Error('Plugin MCP server IDs collide after namespacing.');
  }
  return servers;
}

export async function installProductPlugin(
  sourcePath: string,
  userPluginRoot: string,
): Promise<{ id: string; manifestPath: string }> {
  const result = pluginInstallQueue.then(() => installProductPluginTransaction(sourcePath, userPluginRoot));
  pluginInstallQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function installProductPluginTransaction(sourcePath: string, userPluginRoot: string) {
  const source = resolve(sourcePath);
  const manifestPath = join(source, '.codex-plugin', 'plugin.json');
  const manifest = await readJson(manifestPath);
  const id = requiredString(manifest.name, 'plugin.name');
  if (basename(source) !== id) {
    throw new Error(`Plugin folder ${basename(source)} must match manifest name ${id}.`);
  }
  await decodeManifest({
    manifest,
    manifestPath,
    pluginRoot: source,
    source: 'user',
    installation: 'INSTALLED_BY_DEFAULT',
  });
  const targetRoot = resolve(userPluginRoot);
  const target = resolve(targetRoot, id);
  if (!inside(targetRoot, target)) throw new Error('Plugin destination escapes the user plugin root.');
  if (inside(source, targetRoot)) throw new Error('Plugin destination must not be inside its source directory.');
  await mkdir(targetRoot, { recursive: true });
  if (inside(await realpath(source), await realpath(targetRoot))) {
    throw new Error('Plugin destination must not be inside its source directory.');
  }
  // Staging is outside the catalog so incomplete copies are never discovered.
  const work = await mkdtemp(join(dirname(targetRoot), '.cardbush-plugin-install-'));
  const temporary = join(work, 'staged', id);
  const backup = join(work, 'previous');
  let preserveBackup = false;
  try {
    await mkdir(dirname(temporary), { recursive: true });
    await cp(source, temporary, { recursive: true, errorOnExist: true });
    await decodeManifest({ manifest: await readJson(join(temporary, '.codex-plugin', 'plugin.json')),
      manifestPath: join(temporary, '.codex-plugin', 'plugin.json'), pluginRoot: temporary,
      source: 'user', installation: 'INSTALLED_BY_DEFAULT' });
    let movedExisting = false;
    try { await rename(target, backup); movedExisting = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await rename(temporary, target); }
    catch (error) {
      if (movedExisting) {
        try { await rename(backup, target); }
        catch (restoreError) {
          preserveBackup = true;
          throw new AggregateError([error, restoreError], `Plugin update failed; previous plugin retained at ${backup}`);
        }
      }
      throw error;
    }
    return { id, manifestPath: join(target, '.codex-plugin', 'plugin.json') };
  } finally {
    if (!preserveBackup) await rm(work, { recursive: true, force: true }).catch((error: unknown) => {
      // A running old plugin may still hold a Windows file handle. The committed
      // installation remains successful; retain cleanup diagnostics for this directory.
      console.warn('Plugin staging cleanup deferred:', work, error instanceof Error ? error.message : String(error));
    });
  }
}

async function marketplaceEntries(root: string): Promise<MarketplaceEntry[]> {
  const marketplace = await readJson(join(root, 'marketplace.json')).catch(() => null);
  if (marketplace && Array.isArray(marketplace.plugins)) {
    return marketplace.plugins.map((candidate) => {
      const item = object(candidate, 'Marketplace plugin entry must be an object.');
      const source = object(item.source, 'Marketplace source must be an object.');
      const policy = object(item.policy, 'Marketplace policy must be an object.');
      const installation = string(policy.installation);
      if (source.source !== 'local' || !['AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(installation)) {
        throw new Error('CardBush currently accepts local AVAILABLE or INSTALLED_BY_DEFAULT plugins.');
      }
      return {
        name: requiredString(item.name, 'plugin.name'),
        path: requiredString(source.path, 'plugin.source.path'),
        installation: installation as MarketplaceEntry['installation'],
      };
    });
  }
  const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
  return directories
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: `./${entry.name}`,
      installation: 'INSTALLED_BY_DEFAULT' as const,
    }));
}

async function decodeManifest(input: {
  manifest: Record<string, unknown>;
  manifestPath: string;
  pluginRoot: string;
  source: 'bundled' | 'user';
  installation: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT';
}): Promise<CardbushPluginCatalogEntry> {
  const { manifest, manifestPath, pluginRoot, source, installation } = input;
  const id = requiredString(manifest.name, 'plugin.name');
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(id)) {
    throw new Error(`Invalid CardBush plugin name: ${id}`);
  }
  const interfaceMetadata = object(manifest.interface, 'plugin.interface must be an object.');
  const author = object(manifest.author, 'plugin.author must be an object.');
  const logoPath = await assetPath(pluginRoot, interfaceMetadata.logo);
  const logoDarkPath = await assetPath(pluginRoot, interfaceMetadata.logoDark, true);
  const skillRoots = await skillRootsFromManifest(manifest, pluginRoot);
  return {
    id,
    name: requiredString(interfaceMetadata.displayName, 'plugin.interface.displayName'),
    description: requiredString(interfaceMetadata.shortDescription ?? manifest.description, 'plugin.interface.shortDescription'),
    longDescription: requiredString(interfaceMetadata.longDescription ?? manifest.description, 'plugin.interface.longDescription'),
    version: requiredString(manifest.version, 'plugin.version'),
    developerName: requiredString(interfaceMetadata.developerName ?? author.name, 'plugin.interface.developerName'),
    category: requiredString(interfaceMetadata.category, 'plugin.interface.category'),
    capabilities: stringArray(interfaceMetadata.capabilities).slice(0, 12),
    keywords: stringArray(manifest.keywords).slice(0, 24),
    defaultPrompts: stringArray(interfaceMetadata.defaultPrompt).slice(0, 3),
    brandColor: string(interfaceMetadata.brandColor) || '#5f8f79',
    logoPath,
    logoDarkPath,
    manifestPath,
    source,
    installation,
    skillRoots,
    components: await componentsFromManifest(manifest, pluginRoot, skillRoots),
  };
}

async function componentsFromManifest(
  manifest: Record<string, unknown>,
  pluginRoot: string,
  skillRoots: string[],
): Promise<CardbushPluginComponent[]> {
  const result: CardbushPluginComponent[] = [];
  for (const root of skillRoots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const skillPath = join(root, entry.name, 'SKILL.md');
      const content = await readFile(skillPath, 'utf8').catch(() => '');
      if (!content) continue;
      const metadata = frontmatter(content);
      const id = string(metadata.name) || entry.name;
      result.push({
        kind: 'skill',
        id,
        name: displayName(id),
        description: string(metadata.description) || 'Plugin Skill',
      });
    }
  }
  const mcp = manifest.mcpServers;
  const mcpConfig: Record<string, unknown> = typeof mcp === 'string'
    ? await readJson(safePluginPath(pluginRoot, mcp)).catch(() => ({} as Record<string, unknown>))
    : objectOrEmpty(mcp);
  const mcpServers = objectOrEmpty(mcpConfig.mcpServers ?? mcpConfig);
  for (const id of Object.keys(mcpServers)) {
    result.push({ kind: 'mcp', id, name: displayName(id), description: 'MCP service' });
  }
  const appsPath = string(manifest.apps);
  if (appsPath) {
    const appsConfig: Record<string, unknown> = await readJson(safePluginPath(pluginRoot, appsPath))
      .catch(() => ({} as Record<string, unknown>));
    const apps = Array.isArray(appsConfig.apps)
      ? appsConfig.apps
      : Object.entries(objectOrEmpty(appsConfig.apps ?? appsConfig)).map(([id, value]) => ({ id, ...objectOrEmpty(value) }));
    for (const candidate of apps) {
      const app = object(candidate, 'Plugin app must be an object.');
      const id = requiredString(app.id ?? app.name, 'app.id');
      result.push({
        kind: 'app',
        id,
        name: string(app.displayName ?? app.name) || displayName(id),
        description: string(app.description) || 'CardBush app integration',
      });
    }
  }
  return result;
}

async function skillRootsFromManifest(
  manifest: Record<string, unknown>,
  pluginRoot: string,
): Promise<string[]> {
  const configured = string(manifest.skills);
  if (!configured) return [];
  const candidate = safePluginPath(pluginRoot, configured);
  if (!(await stat(candidate).catch(() => null))?.isDirectory()) {
    throw new Error(`Plugin Skill directory is missing: ${configured}`);
  }
  const resolvedRoot = await realpath(pluginRoot);
  const resolvedCandidate = await realpath(candidate);
  if (!inside(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Plugin Skill directory escapes its root: ${configured}`);
  }
  return [resolvedCandidate];
}

function frontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end < 0) return {};
  const result: Record<string, unknown> = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    const value = match[2].trim();
    result[match[1]] = ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  }
  return result;
}

async function assetPath(root: string, value: unknown, optional = false): Promise<string> {
  const candidate = string(value);
  if (!candidate) {
    if (optional) return '';
    throw new Error('plugin.interface.logo is required.');
  }
  const path = safePluginPath(root, candidate);
  if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`Plugin asset is missing: ${candidate}`);
  return path;
}

function safePluginPath(root: string, value: string): string {
  if (isAbsolute(value)) throw new Error('Plugin component paths must be relative.');
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error(`Plugin path escapes its root: ${value}`);
  return path;
}

function inside(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return object(JSON.parse(await readFile(path, 'utf8')), `Invalid JSON object: ${path}`);
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredString(value: unknown, field: string): string {
  const result = string(value);
  if (!result) throw new Error(`${field} is required.`);
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(string).filter(Boolean) : [];
}

function displayName(value: string): string {
  return value.split(/[-_.]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`).join(' ');
}
