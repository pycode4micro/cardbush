import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, realpath, writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import JSZip from 'jszip';
import { extractPluginArchive, pluginArchiveLimits } from './pluginArchives';
export { extractPluginArchive } from './pluginArchives';
import { installProductPlugin, inspectProductPlugin } from './productPlugins';
import { resolvePluginManifest } from './pluginManifest';
import { safePackagePath as safeRelative, withinPackage as within } from './pluginPackagePaths';
import { gitSource, gitRef, npmSource, withGitSnapshot, gitCatalogFile, gitPluginArchive, acquireNpmPlugin, type NpmPluginSource, type AcquisitionCommand } from './pluginAcquisition';
import type { PluginMarketCatalog, PluginMarketEntry, PluginMarketPreview, PluginMarketSource } from './pluginMarketplaceTypes';
import { readPluginPresentation } from './pluginPresentation';
import { pluginChild } from './pluginExtensions';
import { PluginMarketDownloads, MarketplaceRateLimitError } from './pluginMarketDownloads';

type Json = Record<string, unknown>;
type StoredCatalog = { view: PluginMarketCatalog; entries: Json[]; revision: string };
type Prepared = { sourceId: string; root: string; stage: string; preview: PluginMarketPreview; expiresAt: number };
const reserved = new Set(['computer-use', 'chrome']);
const idPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const maxArchiveBytes = pluginArchiveLimits.compressedBytes;
const maxExpandedBytes = pluginArchiveLimits.expandedBytes;

/** OpenAI-format catalog acquisition is separate from the installed plugin catalog. */
export class PluginMarketplaceService {
  private readonly catalogs = new Map<string, StoredCatalog>();
  private readonly prepared = new Map<string, Prepared>();
  private readonly presentations = new Map<string, ReturnType<typeof readPluginPresentation>>();
  private readonly previewRequests = new Map<string, Promise<PluginMarketPreview>>();
  private readonly catalogRequests = new Map<string, Promise<PluginMarketCatalog>>();
  private readonly downloads: PluginMarketDownloads;
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    dataRoot: string;
    userPluginRoot: string;
    bundledPluginRoot: string;
    fetch: typeof fetch;
    runAcquisition?: AcquisitionCommand;
  }) { this.downloads = new PluginMarketDownloads(options.fetch); }

  async sources(): Promise<PluginMarketSource[]> {
    let saved: PluginMarketSource[] = [];
    try {
      const data = JSON.parse(await readFile(join(this.options.dataRoot, 'sources.json'), 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid marketplace source list.');
      saved = data;
    } catch (error) { if (!missing(error)) throw error; }
    return [{ id: 'builtin', kind: 'local', location: this.options.bundledPluginRoot, builtin: true }, ...saved];
  }

  addGitHub(input: string): Promise<PluginMarketSource> {
    const { repo, ref } = githubSource(input);
    return this.add({ id: hash(`github:${repo}@${ref}`), kind: 'github', location: repo, ref });
  }

  addSource(input: string): Promise<PluginMarketSource> {
    if (/^[\w-]+\/[\w.-]+(?:@.+)?$/.test(input.trim())) return this.addGitHub(input);
    const { url, ref } = gitSource(input);
    return this.add({ id: hash(`git:${url}@${ref}`), kind: 'git', location: url, ref });
  }

  addLocal(directory: string): Promise<PluginMarketSource> {
    const location = resolve(directory);
    return this.add({ id: hash(`local:${location.toLowerCase()}`), kind: 'local', location });
  }

  private add(source: PluginMarketSource): Promise<PluginMarketSource> {
    return this.serial(async () => {
      const sources = await this.sources();
      const existing = sources.find(item => item.id === source.id);
      if (existing) return existing;
      if (sources.length >= 24) throw new Error('At most 24 marketplace sources are supported.');
      await this.readCatalog(source);
      await this.saveSources([...sources, source]);
      return source;
    });
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (id === 'builtin') throw new Error('The bundled marketplace cannot be removed.');
      await this.saveSources((await this.sources()).filter(item => item.id !== id));
      this.catalogs.delete(id);
      for (const key of this.presentations.keys()) if (key.startsWith(`${id}:`)) this.presentations.delete(key);
      // Removing a source intentionally leaves already installed plugins in place.
      await this.removeCache(id);
    });
  }

  catalog(id: string, refresh = false): Promise<PluginMarketCatalog> {
    // An explicit refresh must not join a concurrent read that can return old memory data.
    const key = JSON.stringify([id, refresh]);
    const pending = this.catalogRequests.get(key);
    if (pending) return pending;
    const request = this.loadCatalog(id, refresh);
    this.catalogRequests.set(key, request);
    void request.then(() => this.catalogRequests.delete(key), () => this.catalogRequests.delete(key));
    return request;
  }

  private async loadCatalog(id: string, refresh: boolean): Promise<PluginMarketCatalog> {
    const source = await this.source(id);
    const memory = this.catalogs.get(id);
    if (memory && !refresh) return memory.view;
    try {
      const catalog = await this.readCatalog(source);
      for (const key of this.presentations.keys()) if (key.startsWith(`${id}:`) && (source.kind === 'local' || !key.startsWith(`${id}:${catalog.revision}:`))) this.presentations.delete(key);
      return catalog.view;
    }
    catch (error) {
      const stored: StoredCatalog | null = memory ?? await this.cached(id);
      if (!stored) throw error;
      const fallback = { ...stored, view: { ...stored.view, cached: true, error: errorText(error) } };
      this.catalogs.set(id, fallback);
      return fallback.view;
    }
  }

  preview(sourceId: string, name: string): Promise<PluginMarketPreview> {
    const key = JSON.stringify([sourceId, name]);
    const pending = this.previewRequests.get(key);
    if (pending) return pending;
    const request = this.serial(() => this.prepare(sourceId, name));
    this.previewRequests.set(key, request);
    void request.then(() => this.previewRequests.delete(key), () => this.previewRequests.delete(key));
    return request;
  }

  async presentation(sourceId: string, name: string) {
    const source = await this.source(sourceId);
    if (!this.catalogs.has(sourceId)) await this.catalog(sourceId);
    const catalog = this.catalogs.get(sourceId)!;
    const entry = catalog.entries.find(item => item.name === name);
    if (!entry) throw new Error('Plugin is not in this marketplace.');
    const key = `${sourceId}:${catalog.revision}:${name}`;
    let pending = this.presentations.get(key);
    if (!pending) {
      pending = (async () => {
        const origin = pluginSource(entry.source, source);
        if (origin.kind === 'local') {
          const root = await pluginChild(source.location, origin.path);
          return readPluginPresentation(async file => {
            const path = await pluginChild(root, file);
            if ((await lstat(path)).size > 512 * 1024) throw new Error('Plugin presentation is too large.');
            return readFile(path);
          });
        }
        if (origin.kind === 'github') {
          const revision = origin.sameRepository ? catalog.revision : await this.commit(origin.repo, origin.ref);
          return readPluginPresentation(async file => {
            const path = [origin.path, safeRelative(file)].filter(Boolean).join('/');
            if (file.endsWith('.json')) return Buffer.from(await this.catalogFile(origin.repo, revision, path));
            return this.bytes(rawUrl(origin.repo, revision, path), 512 * 1024, 15_000, true);
          });
        }
        if (origin.kind === 'git') return withGitSnapshot(origin.url, origin.sameRepository ? catalog.revision : origin.ref, this.options.dataRoot,
          (repository, revision, run) => readPluginPresentation(async file => {
            const path = [origin.path, safeRelative(file)].filter(Boolean).join('/');
            if (file.endsWith('.json')) return Buffer.from(await gitCatalogFile(repository, revision, path, run));
            const zip = await JSZip.loadAsync(await gitPluginArchive(repository, revision, path, run));
            const asset = Object.values(zip.files).find(item => !item.dir && item.name.endsWith(`/${path}`));
            if (!asset) throw new Error('Plugin logo is missing.');
            return asset.async('nodebuffer');
          }), this.options.runAcquisition);
        return { displayName: '', description: '', logo: '', logoDark: '' };
      })();
      this.presentations.set(key, pending);
      while (this.presentations.size > 128) this.presentations.delete(this.presentations.keys().next().value!);
      void pending.catch(() => this.presentations.delete(key));
    }
    return pending;
  }

  private async prepare(sourceId: string, name: string): Promise<PluginMarketPreview> {
    const source = await this.source(sourceId);
    if (source.builtin) throw new Error('Manage bundled plugins from their existing detail page.');
    await this.expirePreviews();
    if (!this.catalogs.has(sourceId)) await this.catalog(sourceId);
    const catalog = this.catalogs.get(sourceId)!;
    const entry = catalog.entries.find(item => item.name === name);
    const summary = catalog.view.entries.find(item => item.name === name);
    if (!entry || !summary?.available) throw new Error(summary?.unavailableReason ?? 'Plugin is not available in this marketplace.');
    const origin = pluginSource(entry.source, source);
    const stageBase = join(this.options.dataRoot, 'previews');
    await mkdir(stageBase, { recursive: true });
    const stage = await mkdtemp(join(stageBase, 'preview-'));
    const root = join(stage, name);
    let revision = catalog.revision;
    let sourceLabel = source.location;
    try {
      if (origin.kind === 'local') {
        const from = within(source.location, origin.path);
        const actualRelative = relative(await realpath(source.location), await realpath(from));
        if (!actualRelative || actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new Error('Plugin path escapes its marketplace through a link.');
        await portableTree(from);
        await cp(from, root, { recursive: true, errorOnExist: true });
        revision = 'local';
      } else if (origin.kind === 'github') {
        revision = origin.sameRepository ? catalog.revision : await this.commit(origin.repo, origin.ref);
        const archiveUrl = `https://codeload.github.com/${origin.repo.toLowerCase()}/zip/${revision}`;
        const archive = await this.bytes(archiveUrl, maxArchiveBytes, 60_000, true);
        try { await extractPluginArchive(archive, origin.path, root); }
        catch (error) { this.downloads.invalidate(archiveUrl); throw error; }
        sourceLabel = `https://github.com/${origin.repo}`;
      } else if (origin.kind === 'git') {
        await withGitSnapshot(origin.url, origin.sameRepository ? catalog.revision : origin.ref, this.options.dataRoot, async (repository, sha, run) => {
          revision = sha;
          await extractPluginArchive(await gitPluginArchive(repository, sha, origin.path, run), origin.path, root);
        }, this.options.runAcquisition);
        sourceLabel = origin.url;
      } else {
        const acquired = await acquireNpmPlugin(origin, stage, root, this.options.runAcquisition);
        revision = acquired.revision; sourceLabel = acquired.source;
      }
      // Retain the original marketplace declaration, never a rewritten plugin manifest.
      await writeFile(join(root, '.cardbush-marketplace.json'), JSON.stringify({ sourceId, name, revision, source: sourceLabel, entry }, null, 2));
      const { manifest, format, issues: importIssues, notes } = await resolvePluginManifest(root);
      if (manifest.name !== entry.name) throw new Error('Marketplace entry does not match the plugin manifest name.');
      const plugin = await inspectProductPlugin(root);
      const issues = [...importIssues, ...await compatibilityIssues(root, manifest)];
      if (!plugin.components.some(component => ['skill', 'mcp', 'app', 'agent', 'hook', 'command'].includes(component.kind))) issues.push({ code: 'empty', detail: '' });
      if (reserved.has(name)) issues.push({ code: 'reserved', detail: name });
      const receipt = await this.receipt(name);
      const installed = await lstat(join(this.options.userPluginRoot, name)).catch(error => { if (missing(error)) return null; throw error; });
      if (installed && (!receipt || receipt.sourceId !== sourceId)) issues.push({ code: 'collision', detail: name });
      const requirements = await mcpRequirements(root, manifest);
      const token = randomUUID();
      const view: PluginMarketPreview = { token, id: name, name: plugin.name, description: plugin.longDescription,
        version: plugin.version, developerName: plugin.developerName,
        source: sourceLabel,
        revision, format, components: plugin.components, requirements, issues, notes, updating: Boolean(installed), authentication: object(entry.policy).authentication === 'ON_INSTALL' ? 'ON_INSTALL' : 'ON_USE' };
      // The user installs this exact staged snapshot, even if a branch moves after preview.
      this.prepared.set(token, { sourceId, root, stage, preview: view, expiresAt: Date.now() + 30 * 60_000 });
      return view;
    } catch (error) { await this.cleanStage(stage); throw error; }
  }

  install(token: string): Promise<{ id: string; manifestPath: string }> {
    return this.serial(async () => {
      const prepared = this.prepared.get(token);
      if (!prepared || prepared.expiresAt < Date.now()) throw new Error('Preview expired. Open the plugin details again.');
      await this.source(prepared.sourceId);
      if (prepared.preview.issues.length) throw new Error('This plugin is not compatible with CardBush.');
      const target = join(this.options.userPluginRoot, prepared.preview.id);
      const installed = await lstat(target).catch(error => { if (missing(error)) return null; throw error; });
      const receipt = await this.receipt(prepared.preview.id);
      if (installed && receipt?.sourceId !== prepared.sourceId) throw new Error('An installed plugin from another source uses this name.');
      const result = await installProductPlugin(prepared.root, this.options.userPluginRoot);
      this.prepared.delete(token);
      await this.cleanStage(prepared.stage).catch(() => undefined);
      return result;
    });
  }

  private async readCatalog(source: PluginMarketSource): Promise<StoredCatalog> {
    if (source.kind === 'git') return withGitSnapshot(source.location, source.ref ?? 'HEAD', this.options.dataRoot,
      (repository, revision, run) => this.decodeCatalog(source, revision, file => gitCatalogFile(repository, revision, file, run)), this.options.runAcquisition);
    const revision = source.kind === 'github' ? await this.commit(source.location, source.ref ?? 'HEAD') : 'local';
    return this.decodeCatalog(source, revision, file => source.kind === 'github'
      ? this.catalogFile(source.location, revision, file) : readFile(join(source.location, file), 'utf8'));
  }

  private async decodeCatalog(source: PluginMarketSource, revision: string, read: (file: string) => Promise<string>): Promise<StoredCatalog> {
    let payload: Json | undefined;
    let format = 'openai';
    for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'marketplace.json']) {
      try {
        payload = object(JSON.parse(await read(file)));
        format = file.startsWith('.claude-plugin') ? 'claude' : 'openai';
        break;
      } catch (error) { if (!missing(error)) throw error; }
    }
    if (!payload || !Array.isArray(payload.plugins) || typeof payload.name !== 'string') {
      throw new Error('No .agents/plugins/marketplace.json or .claude-plugin/marketplace.json was found at this source.');
    }
    if (payload.plugins.length > 5000) throw new Error('Marketplace exceeds the 5000 entry limit.');
    const seen = new Set<string>();
    const entries: Json[] = [];
    const viewEntries: PluginMarketEntry[] = [];
    for (const candidate of payload.plugins) {
      const entry = object(candidate), name = string(entry.name);
      if (!idPattern.test(name) || seen.has(name.toLowerCase())) throw new Error('Marketplace contains an invalid or duplicate plugin name.');
      safeRelative(name);
      seen.add(name.toLowerCase());
      let reason = '';
      const policy = object(entry.policy);
      if (!['AVAILABLE', 'INSTALLED_BY_DEFAULT'].includes(string(policy.installation) || (format === 'claude' ? 'AVAILABLE' : ''))) reason = 'policy';
      try { pluginSource(entry.source, source); } catch { reason ||= 'source'; }
      entries.push(entry);
      viewEntries.push({ name, description: string(entry.description), category: string(entry.category),
        available: !reason, ...(reason ? { unavailableReason: reason } : {}) });
    }
    const stored: StoredCatalog = { revision, entries, view: { source, name: payload.name,
      displayName: string(object(payload.interface).displayName) || payload.name,
      entries: viewEntries, fetchedAt: new Date().toISOString() } };
    this.catalogs.set(source.id, stored);
    if (!source.builtin) {
      await mkdir(join(this.options.dataRoot, 'catalogs'), { recursive: true });
      await writeFile(join(this.options.dataRoot, 'catalogs', `${source.id}.json`), JSON.stringify(stored));
    }
    return stored;
  }

  private async commit(repo: string, ref: string): Promise<string> {
    if (/^[a-f0-9]{40}$/i.test(ref)) return ref.toLowerCase();
    const result = object(JSON.parse((await this.bytes(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, 2 * 1024 * 1024)).toString('utf8')));
    if (typeof result.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(result.sha)) throw new Error('GitHub did not return a valid commit.');
    return result.sha;
  }

  private async catalogFile(repo: string, revision: string, file: string): Promise<string> {
    try { return (await this.bytes(rawUrl(repo, revision, file), 2 * 1024 * 1024, 15_000, true)).toString('utf8'); }
    catch (error) {
      if (missing(error) || error instanceof MarketplaceRateLimitError) throw error;
      // Some networks block raw.githubusercontent.com while GitHub's API works.
      const payload = object(JSON.parse((await this.bytes(`https://api.github.com/repos/${repo}/contents/${file}?ref=${revision}`, 3 * 1024 * 1024, 15_000, true)).toString('utf8')));
      if (payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new Error('Invalid marketplace content returned by GitHub.');
      const bytes = Buffer.from(payload.content, 'base64');
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Marketplace catalog exceeds the size limit.');
      return bytes.toString('utf8');
    }
  }

  private bytes(url: string, limit: number, timeout = 15_000, immutable = false): Promise<Buffer> {
    return this.downloads.bytes(url, limit, timeout, immutable);
  }

  private async source(id: string) {
    const source = (await this.sources()).find(item => item.id === id);
    if (!source) throw new Error('Marketplace source was removed.');
    return source;
  }
  private async saveSources(sources: PluginMarketSource[]) {
    await mkdir(this.options.dataRoot, { recursive: true });
    const file = join(this.options.dataRoot, 'sources.json'), temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(sources.filter(item => !item.builtin), null, 2));
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  }
  private async cached(id: string): Promise<StoredCatalog | null> {
    if (!/^[a-f0-9]{24}$/.test(id)) return null;
    try { return JSON.parse(await readFile(join(this.options.dataRoot, 'catalogs', `${id}.json`), 'utf8')); }
    catch { return null; }
  }
  private async removeCache(id: string) {
    if (/^[a-f0-9]{24}$/.test(id)) await rm(join(this.options.dataRoot, 'catalogs', `${id}.json`), { force: true });
  }
  private async receipt(id: string): Promise<Json | null> {
    try { return object(JSON.parse(await readFile(join(this.options.userPluginRoot, id, '.cardbush-marketplace.json'), 'utf8'))); }
    catch { return null; }
  }
  private async expirePreviews() {
    for (const [token, prepared] of this.prepared) {
      if (prepared.expiresAt > Date.now() && this.prepared.size < 8) continue;
      this.prepared.delete(token); await this.cleanStage(prepared.stage);
    }
  }
  private async cleanStage(stage: string) {
    const base = resolve(this.options.dataRoot, 'previews');
    if (dirname(resolve(stage)) !== base || !basename(stage).startsWith('preview-')) throw new Error('Invalid preview cleanup path.');
    await rm(stage, { recursive: true, force: true, maxRetries: 2 });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation);
    this.mutation = result.catch(() => undefined); return result;
  }
}

export function githubSource(input: string): { repo: string; ref: string } {
  let value = String(input).trim(), ref = 'HEAD';
  if (value.startsWith('https://')) {
    const url = new URL(value);
    if (url.hostname !== 'github.com' || url.username || url.password || url.search) throw new Error('Use a public GitHub repository URL.');
    ref = decodeURIComponent(url.hash.slice(1)) || ref;
    value = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  } else {
    const separator = value.indexOf('@');
    if (separator >= 0) { ref = value.slice(separator + 1); value = value.slice(0, separator); }
  }
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value) || !ref || /[\x00-\x20\\?#]/.test(ref)) throw new Error('Use owner/repo or a GitHub repository URL, optionally with a ref.');
  return { repo: value, ref };
}

function pluginSource(value: unknown, market: PluginMarketSource):
  { kind: 'local'; path: string } | { kind: 'github'; repo: string; ref: string; path: string; sameRepository: boolean }
  | { kind: 'git'; url: string; ref: string; path: string; sameRepository: boolean } | NpmPluginSource {
  const source = typeof value === 'string' ? { source: 'local', path: value } : object(value);
  if (source.source === 'local') {
    const path = safeRelative(string(source.path));
    return market.kind === 'local' ? { kind: 'local', path }
      : market.kind === 'git' ? { kind: 'git', url: market.location, ref: market.ref ?? 'HEAD', path, sameRepository: true }
      : { kind: 'github', repo: market.location, ref: market.ref ?? 'HEAD', path, sameRepository: true };
  }
  if (source.source === 'npm') return npmSource(source);
  if (!['url', 'git-subdir', 'github'].includes(string(source.source))) throw new Error('Unsupported marketplace source type.');
  const input = string(source.source === 'github' ? source.repo : source.url);
  const { url, ref } = gitSource(input);
  const selector = string(source.sha) || string(source.ref) || ref;
  gitRef(selector);
  if (source.sha && !/^[a-f0-9]{40,64}$/i.test(string(source.sha))) throw new Error('Invalid pinned commit.');
  // Keep archive acquisition for legacy public GitHub shorthand sources.
  if (source.source === 'github' || (market.kind === 'github' && url.startsWith('https://github.com/'))) {
    const { repo } = githubSource(url);
    return { kind: 'github', repo, ref: selector, path: source.source === 'git-subdir' ? safeRelative(string(source.path)) : '', sameRepository: false };
  }
  return { kind: 'git', url, ref: selector,
    path: source.source === 'git-subdir' ? safeRelative(string(source.path)) : '', sameRepository: false };
}
function rawUrl(repo: string, revision: string, file: string) {
  return `https://raw.githubusercontent.com/${repo}/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function string(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

async function portableTree(root: string) {
  let count = 0, size = 0;
  const walk = async (directory: string) => {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Plugin source cannot contain symbolic links.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      safeRelative(entry.name);
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Plugin source cannot contain symbolic links.');
      if (entry.isDirectory()) await walk(full);
      else {
        size += (await lstat(full)).size; count++;
        if (count > 2000 || size > maxExpandedBytes) throw new Error('Plugin source exceeds the size limit.');
      }
    }
  };
  await walk(root);
}

async function mcpConfig(root: string, manifest: Json): Promise<Json> {
  const configured = manifest.mcpServers;
  const config = typeof configured === 'string' ? object(JSON.parse(await readFile(within(root, configured), 'utf8'))) : object(configured);
  return object(config.mcpServers ?? config);
}
async function mcpRequirements(root: string, manifest: Json): Promise<string[]> {
  return [...new Set(Object.values(await mcpConfig(root, manifest)).map(value => string(object(value).command)).filter(Boolean))];
}
async function compatibilityIssues(root: string, manifest: Json): Promise<PluginMarketPreview['issues']> {
  const issues: PluginMarketPreview['issues'] = [];
  const config = await mcpConfig(root, manifest);
  const variables = [...JSON.stringify(config).matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]).filter(name => !['PLUGIN_ROOT', 'CARDBUSH_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT'].includes(name) && !/^[A-Za-z_][A-Za-z0-9_]*:-/.test(name) && !process.env[name]);
  if (variables.length) issues.push({ code: 'variables', detail: [...new Set(variables)].join(', ') });
  for (const [name, raw] of Object.entries(config)) {
    const server = object(raw), kind = string(server.type ?? server.transport) || (server.url ? 'http' : 'stdio');
    if (!['stdio', 'http', 'streamable_http', 'sse'].includes(kind)) issues.push({ code: 'transport', detail: `${name}: ${kind}` });
    if (kind === 'stdio' ? !string(server.command) : !/^https?:\/\//i.test(string(server.url))) issues.push({ code: 'configuration', detail: name });

  }
  return issues;
}
