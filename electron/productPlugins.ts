import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { resolvePluginManifest, pluginRootForManifest, type ResolvedPluginManifest } from './pluginManifest';

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
      const resolved = await resolvePluginManifest(pluginRoot).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!resolved) continue;
      const plugin = await decodeManifest({
        resolved,
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
  }).map(plugin => ({ ...plugin, config: objectOrEmpty(stored.get(plugin.id)?.config) }));
}

export async function loadEnabledProductPluginExtensions(roots: PluginRoot[], configPath: string) {
  const extensions = await Promise.all((await loadEnabledProductPlugins(roots, configPath)).map(async plugin => {
    const root = pluginRootForManifest(plugin.manifestPath);
    const value = (await resolvePluginManifest(root)).extensions;
    if (value.issues.length) throw new Error(`Plugin ${plugin.id} has unsupported runtime components: ${value.issues.map(issue => issue.detail).join('; ')}`);
    const trusted = new Set(Array.isArray(plugin.config.trustedHookHashes) ? plugin.config.trustedHookHashes.filter(item => typeof item === 'string') : []);
    return { ...value, hooks: value.hooks.map(hook => ({ ...hook, trusted: Boolean(hook.definitionHash && trusted.has(hook.definitionHash)) })) };
  }));
  return { hooks: extensions.flatMap(value => value.hooks), agents: extensions.flatMap(value => value.agents), commands: extensions.flatMap(value => value.commands) };
}

/** External plugin MCP servers use their own namespace and explicit permission. */
export async function loadEnabledProductPluginMcpServers(roots: PluginRoot[], configPath: string, standalone: Array<Record<string, unknown>> = []) {
  const { resolvePluginMcpConnection } = await import('./pluginMcpConfiguration.mjs');
  const servers: Record<string, unknown>[] = [];
  for (const plugin of await loadEnabledProductPlugins(roots, configPath)) {
    if (plugin.id === 'computer-use' || plugin.id === 'chrome') continue;
    const root = pluginRootForManifest(plugin.manifestPath);
    const { manifest, registeredApps } = await resolvePluginManifest(root);
    const policies = objectOrEmpty(plugin.config.mcp_servers);
    const declarations = objectOrEmpty(manifest.mcpServers);
    for (const name of new Set([...Object.keys(declarations), ...Object.keys(registeredApps)])) {
      const settings = objectOrEmpty(policies[name]);
      const configured = resolvePluginMcpConnection(plugin.id, name, root, declarations, registeredApps, settings, standalone);
      if (configured) servers.push(configured);
    }
  }
  if (new Set(servers.map(server => server.id)).size !== servers.length) throw new Error('Plugin MCP server IDs collide after namespacing.');
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

/** Validate an acquired package before it is offered for installation. */
export async function inspectProductPlugin(source: string): Promise<CardbushPluginCatalogEntry> {
  return decodeManifest({ resolved: await resolvePluginManifest(source),
    source: 'user', installation: 'INSTALLED_BY_DEFAULT' });
}

async function installProductPluginTransaction(sourcePath: string, userPluginRoot: string) {
  const source = resolve(sourcePath);
  const resolved = await resolvePluginManifest(source);
  const { manifest, manifestPath } = resolved;
  const id = requiredString(manifest.name, 'plugin.name');
  if (basename(source) !== id) {
    throw new Error(`Plugin folder ${basename(source)} must match manifest name ${id}.`);
  }
  await decodeManifest({
    resolved,
    source: 'user',
    installation: 'INSTALLED_BY_DEFAULT',
  });
  validateRuntimeExtensions(resolved);
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
    const staged = await resolvePluginManifest(temporary);
    await decodeManifest({ resolved: staged,
      source: 'user', installation: 'INSTALLED_BY_DEFAULT' });
    validateRuntimeExtensions(staged);
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
    return { id, manifestPath: join(target, relative(source, manifestPath)) };
  } finally {
    if (!preserveBackup) await rm(work, { recursive: true, force: true }).catch((error: unknown) => {
      // A running old plugin may still hold a Windows file handle. The committed
      // installation remains successful; retain cleanup diagnostics for this directory.
      console.warn('Plugin staging cleanup deferred:', work, error instanceof Error ? error.message : String(error));
    });
  }
}

function validateRuntimeExtensions({ manifest, extensions: { issues } }: ResolvedPluginManifest) {
  if (issues.length) throw new Error(`Plugin ${manifest.name} has unsupported runtime components: ${issues.map(issue => issue.detail).join('; ')}`);
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
  resolved: ResolvedPluginManifest;
  source: 'bundled' | 'user';
  installation: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT';
}): Promise<CardbushPluginCatalogEntry> {
  const { source, installation, resolved } = input;
  const { manifest, manifestPath, root: pluginRoot, skillRoots } = resolved;
  const id = requiredString(manifest.name, 'plugin.name');
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(id)) {
    throw new Error(`Invalid CardBush plugin name: ${id}`);
  }
  const interfaceMetadata = objectOrEmpty(manifest.interface);
  const author = objectOrEmpty(manifest.author);
  const logoPath = await assetPath(pluginRoot, interfaceMetadata.logo, true);
  const logoDarkPath = await assetPath(pluginRoot, interfaceMetadata.logoDark, true);
  return {
    id,
    name: string(interfaceMetadata.displayName) || displayName(id),
    description: string(interfaceMetadata.shortDescription ?? manifest.description) || id,
    longDescription: string(interfaceMetadata.longDescription ?? manifest.description) || id,
    version: requiredString(manifest.version, 'plugin.version'),
    developerName: string(interfaceMetadata.developerName ?? author.name) || 'Unknown',
    category: string(interfaceMetadata.category) || 'Other',
    capabilities: stringArray(interfaceMetadata.capabilities).slice(0, 12),
    keywords: stringArray(manifest.keywords).slice(0, 24),
    defaultPrompts: stringArray(interfaceMetadata.defaultPrompt).slice(0, 3),
    brandColor: string(interfaceMetadata.brandColor) || '#5f8f79',
    logoPath,
    logoDarkPath,
    manifestPath,
    source,
    installation,
    authentication: resolved.authentication,
    skillRoots,
    components: await componentsFromManifest(resolved),
  };
}

async function componentsFromManifest(
  { manifest, skillRoots, extensions, registeredApps }: ResolvedPluginManifest,
): Promise<CardbushPluginComponent[]> {
  const result: CardbushPluginComponent[] = [];
  for (const command of extensions.commands) result.push({ kind: 'command', id: command.id, name: `/${command.id}`, description: command.description });
  for (const agent of extensions.agents) result.push({ kind: 'agent', id: agent.id, name: agent.name, description: agent.description });
  for (const hook of extensions.hooks) result.push({ kind: 'hook', id: hook.id, name: hook.event,
    description: hook.type === 'mcp_tool' ? `${hook.server}/${hook.tool}` : hook.type === 'prompt' || hook.type === 'agent' ? `${hook.type}: parsed but skipped` : hook.command,
    hook: { definitionHash: hook.definitionHash!, definition: hook.definition!, executable: hook.type !== 'prompt' && hook.type !== 'agent' } });
  for (const root of skillRoots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const directories = entries.some(item => item.isFile() && item.name === 'SKILL.md') ? [root]
      : entries.filter(item => item.isDirectory()).map(item => join(root, item.name));
    for (const directory of directories) {
      const skillPath = join(directory, 'SKILL.md');
      const content = await readFile(skillPath, 'utf8').catch(() => '');
      if (!content) continue;
      const metadata = frontmatter(content);
      const id = string(metadata.name) || basename(directory);
      result.push({
        kind: 'skill',
        id,
        name: displayName(id),
        description: string(metadata.description) || 'Plugin Skill',
      });
    }
  }
  const mcpServers = objectOrEmpty(manifest.mcpServers);
  for (const id of new Set([...Object.keys(mcpServers), ...Object.keys(registeredApps)])) {
    const bundled = Object.hasOwn(mcpServers, id), app = registeredApps[id];
    const server = objectOrEmpty(mcpServers[id]);
    result.push({ kind: bundled ? 'mcp' : 'app', id, name: displayName(id), description: bundled ? 'MCP service' : 'Registered MCP connection', mcp: {
      ...(bundled ? { transport: string(server.type) || (server.url ? 'http' : 'stdio'), ...(server.url ? { url: string(server.url) } : {}) } : {}),
      ...(app ? { registeredAppId: app.id, required: app.required } : {}),
    } });
  }
  return result;
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
