import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, lstat, realpath, writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import JSZip from 'jszip';
import type { Readable } from 'node:stream';
import { installProductPlugin, inspectProductPlugin } from './productPlugins';
import { importPluginManifest } from './pluginManifestImport';
import type { PluginMarketCatalog, PluginMarketEntry, PluginMarketPreview, PluginMarketSource } from './pluginMarketplaceTypes';

type Json = Record<string, unknown>;
type StoredCatalog = { view: PluginMarketCatalog; entries: Json[]; revision: string };
type Prepared = { sourceId: string; root: string; stage: string; preview: PluginMarketPreview; expiresAt: number };
const reserved = new Set(['computer-use', 'chrome']);
const idPattern = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const maxArchiveBytes = 32 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const maxFileBytes = 16 * 1024 * 1024;

/** OpenAI-format catalog acquisition is separate from the installed plugin catalog. */
export class PluginMarketplaceService {
  private readonly catalogs = new Map<string, StoredCatalog>();
  private readonly prepared = new Map<string, Prepared>();
  private mutation: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: {
    dataRoot: string;
    userPluginRoot: string;
    bundledPluginRoot: string;
    fetch: typeof fetch;
  }) {}

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
      // Removing a source intentionally leaves already installed plugins in place.
      await this.removeCache(id);
    });
  }

  async catalog(id: string, refresh = false): Promise<PluginMarketCatalog> {
    const source = await this.source(id);
    const memory = this.catalogs.get(id);
    if (memory && !refresh) return memory.view;
    try { return (await this.readCatalog(source)).view; }
    catch (error) {
      const stored: StoredCatalog | null = memory ?? await this.cached(id);
      if (!stored) throw error;
      const fallback = { ...stored, view: { ...stored.view, cached: true, error: errorText(error) } };
      this.catalogs.set(id, fallback);
      return fallback.view;
    }
  }

  preview(sourceId: string, name: string): Promise<PluginMarketPreview> {
    return this.serial(() => this.prepare(sourceId, name));
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
    try {
      if (origin.kind === 'local') {
        const from = within(source.location, origin.path);
        const actualRelative = relative(await realpath(source.location), await realpath(from));
        if (!actualRelative || actualRelative.startsWith('..') || isAbsolute(actualRelative)) throw new Error('Plugin path escapes its marketplace through a link.');
        await portableTree(from);
        await cp(from, root, { recursive: true, errorOnExist: true });
        revision = 'local';
      } else {
        revision = origin.sameRepository ? catalog.revision : await this.commit(origin.repo, origin.ref);
        const archive = await this.bytes(`https://codeload.github.com/${origin.repo}/zip/${revision}`, maxArchiveBytes, 60_000);
        await extractPluginArchive(archive, origin.path, root);
      }
      const { manifest, format, issues: importIssues, notes } = await importPluginManifest(root, entry);
      const plugin = await inspectProductPlugin(root);
      const issues = [...importIssues, ...await compatibilityIssues(root, manifest)];
      if (!plugin.components.some(component => ['skill', 'mcp', 'agent', 'hook', 'command'].includes(component.kind))) issues.push({ code: 'empty', detail: '' });
      if (reserved.has(name)) issues.push({ code: 'reserved', detail: name });
      const receipt = await this.receipt(name);
      const installed = await lstat(join(this.options.userPluginRoot, name)).catch(error => { if (missing(error)) return null; throw error; });
      if (installed && (!receipt || receipt.sourceId !== sourceId)) issues.push({ code: 'collision', detail: name });
      const requirements = await mcpRequirements(root, manifest);
      const token = randomUUID();
      const view: PluginMarketPreview = { token, id: name, name: plugin.name, description: plugin.longDescription,
        version: plugin.version, developerName: plugin.developerName,
        source: origin.kind === 'github' ? `https://github.com/${origin.repo}` : source.location,
        revision, format, components: plugin.components, requirements, issues, notes, updating: Boolean(installed) };
      // The user installs this exact staged snapshot, even if a branch moves after preview.
      await writeFile(join(root, '.cardbush-marketplace.json'), JSON.stringify({ sourceId, name, revision, source: view.source }, null, 2));
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
    const revision = source.kind === 'github' ? await this.commit(source.location, source.ref ?? 'HEAD') : 'local';
    let payload: Json | undefined;
    let format = 'openai';
    for (const file of ['.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json', 'marketplace.json']) {
      try {
        payload = object(JSON.parse(source.kind === 'github'
          ? await this.catalogFile(source.location, revision, file)
          : await readFile(join(source.location, file), 'utf8')));
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
    try { return (await this.bytes(rawUrl(repo, revision, file), 2 * 1024 * 1024)).toString('utf8'); }
    catch (error) {
      if (missing(error)) throw error;
      // Some networks block raw.githubusercontent.com while GitHub's API works.
      const payload = object(JSON.parse((await this.bytes(`https://api.github.com/repos/${repo}/contents/${file}?ref=${revision}`, 3 * 1024 * 1024)).toString('utf8')));
      if (payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new Error('Invalid marketplace content returned by GitHub.');
      const bytes = Buffer.from(payload.content, 'base64');
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Marketplace catalog exceeds the size limit.');
      return bytes.toString('utf8');
    }
  }

  private async bytes(url: string, limit: number, timeout = 15_000): Promise<Buffer> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.download(url, limit, timeout); }
      catch (error) {
        if (attempt === 0 && /ERR_CONNECTION_RESET|ECONNRESET|ERR_NETWORK_CHANGED|HTTP 50[234]/.test(errorText(error))) continue;
        if (missing(error)) throw error;
        throw new Error(`${new URL(url).hostname}: ${errorText(error)}`);
      }
    }
  }

  private async download(url: string, limit: number, timeout: number): Promise<Buffer> {
    const response = await this.options.fetch(url, { signal: AbortSignal.timeout(timeout),
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CardBush-Plugin-Marketplace' } });
    if (response.status === 404) throw Object.assign(new Error('Source not found or not publicly accessible.'), { code: 'ENOENT' });
    if (!response.ok) throw new Error(`Marketplace download failed (HTTP ${response.status}).`);
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      throw new Error('Marketplace download exceeds the size limit.');
    }
    if (!response.body) throw new Error('Empty marketplace response.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > limit) throw new Error('Marketplace download exceeds the size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(chunks);
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
  { kind: 'local'; path: string } | { kind: 'github'; repo: string; ref: string; path: string; sameRepository: boolean } {
  const source = typeof value === 'string' ? { source: 'local', path: value } : object(value);
  if (source.source === 'local') {
    const path = safeRelative(string(source.path));
    return market.kind === 'local' ? { kind: 'local', path }
      : { kind: 'github', repo: market.location, ref: market.ref ?? 'HEAD', path, sameRepository: true };
  }
  if (!['url', 'git-subdir', 'github'].includes(string(source.source))) throw new Error('Unsupported marketplace source type.');
  const { repo, ref } = githubSource(string(source.source === 'github' ? source.repo : source.url));
  const selector = string(source.sha) || string(source.ref) || ref;
  if (source.sha && !/^[a-f0-9]{40}$/i.test(string(source.sha))) throw new Error('Invalid pinned commit.');
  return { kind: 'github', repo, ref: selector,
    path: source.source === 'git-subdir' ? safeRelative(string(source.path)) : '', sameRepository: false };
}

function safeRelative(value: string): string {
  const path = value.replace(/^\.\//, '').replace(/\/$/, '');
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) throw new Error('Plugin path must stay inside the marketplace root.');
  return path;
}
function within(root: string, value: string) {
  const target = resolve(root, safeRelative(value)), rel = relative(resolve(root), target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Plugin path escapes its source root.');
  return target;
}
function rawUrl(repo: string, revision: string, file: string) {
  return `https://raw.githubusercontent.com/${repo}/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }
function string(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function missing(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export async function extractPluginArchive(archive: Buffer, pluginPath: string, destination: string) {
  const zip = await JSZip.loadAsync(archive);
  const entries = Object.values(zip.files);
  const roots = new Set(entries.map(file => file.name.split('/')[0]));
  if (roots.size !== 1) throw new Error('Expected a GitHub repository archive.');
  const prefix = `${[...roots][0]}/${pluginPath ? safeRelative(pluginPath) + '/' : ''}`;
  const selected = entries.filter(file => !file.dir && (file.unsafeOriginalName ?? file.name).startsWith(prefix));
  if (!selected.length || selected.length > 2000) throw new Error('Plugin folder is missing or exceeds the 2000 file limit.');
  let total = 0; const written = new Set<string>();
  for (const file of selected) {
    const original = file.unsafeOriginalName ?? file.name;
    const name = safeRelative(original.slice(prefix.length));
    if (original !== file.name || written.has(name.toLowerCase())) throw new Error('Archive contains conflicting or unsafe paths.');
    written.add(name.toLowerCase());
    const mode = Number(file.unixPermissions ?? 0);
    if ((mode & 0o170000) === 0o120000) throw new Error('Plugin archives cannot contain symbolic links.');
    const data = await new Promise<Buffer>((fulfill, reject) => {
      const chunks: Buffer[] = []; let size = 0;
      const stream = file.nodeStream('nodebuffer') as Readable;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxFileBytes || total + size > maxExpandedBytes) { stream.destroy(); reject(new Error('Expanded plugin exceeds the size limit.')); return; }
        chunks.push(chunk);
      }).on('error', reject).on('end', () => fulfill(Buffer.concat(chunks)));
    });
    total += data.length;
    const target = within(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data, { flag: 'wx', mode: mode & 0o111 ? 0o755 : 0o644 });
  }
}

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
  const variables = [...JSON.stringify(config).matchAll(/\$\{([^}]+)\}/g)].map(match => match[1]).filter(name => name !== 'CARDBUSH_PLUGIN_ROOT' && name !== 'CODEX_PLUGIN_ROOT' && !/^[A-Za-z_][A-Za-z0-9_]*:-/.test(name) && !process.env[name]);
  if (variables.length) issues.push({ code: 'variables', detail: [...new Set(variables)].join(', ') });
  for (const [name, raw] of Object.entries(config)) {
    const server = object(raw), kind = string(server.type ?? server.transport) || (server.url ? 'http' : 'stdio');
    if (!['stdio', 'http', 'streamable_http', 'sse'].includes(kind)) issues.push({ code: 'transport', detail: `${name}: ${kind}` });
    if (kind === 'stdio' ? !string(server.command) : !/^https?:\/\//i.test(string(server.url))) issues.push({ code: 'configuration', detail: name });
    if (server.oauth || server.auth || server.headersHelper) issues.push({ code: 'authentication', detail: name });
  }
  return issues;
}
