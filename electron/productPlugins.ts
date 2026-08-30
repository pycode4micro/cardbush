import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type {
  CardbushPluginCatalogEntry,
  CardbushPluginComponent,
} from '@cardbush/product-host' with { 'resolution-mode': 'import' };

interface PluginRoot {
  path: string;
  source: 'bundled' | 'user';
}

interface MarketplaceEntry {
  name: string;
  path: string;
  installation: 'AVAILABLE' | 'INSTALLED_BY_DEFAULT';
}

export async function loadProductPluginCatalog(
  roots: PluginRoot[],
): Promise<CardbushPluginCatalogEntry[]> {
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

export async function installProductPlugin(
  sourcePath: string,
  userPluginRoot: string,
): Promise<{ id: string; manifestPath: string }> {
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
  const temporary = `${target}.tmp-${randomUUID()}`;
  await mkdir(targetRoot, { recursive: true });
  await cp(source, temporary, { recursive: true, errorOnExist: true });
  await rm(target, { recursive: true, force: true });
  await rename(temporary, target);
  return { id, manifestPath: join(target, '.codex-plugin', 'plugin.json') };
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
    components: await componentsFromManifest(manifest, pluginRoot),
  };
}

async function componentsFromManifest(
  manifest: Record<string, unknown>,
  pluginRoot: string,
): Promise<CardbushPluginComponent[]> {
  const result: CardbushPluginComponent[] = [];
  const skillsPath = string(manifest.skills);
  if (skillsPath) {
    const root = safePluginPath(pluginRoot, skillsPath);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory())) {
      result.push({ kind: 'skill', id: entry.name, name: entry.name, description: 'Plugin Skill' });
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
