import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { networkProxySchema } from '@cardbush/bush-protocol';
import { CardbushAppsConfigStore, ProductModelConfigStore, ProductMcpConfigStore, decodeProductSubagentConfig } from '@cardbush/product-host';
import { loadProductPluginCatalog } from './productPlugins.js';
import { materializePluginArchive } from './pluginArchiveTree.js';
import { resolvePluginManifest, pluginRootForManifest } from './pluginManifest.js';
import { ignoredSharedPackagePath, packSharedPackage, sharedDigestSchema, sharedFileFingerprint, sharedHash, SharedPackageError,
  sharedPackageFingerprint, sharedPackageLimits, sharedPackagePathSchema, sharedPackageReferenceSchema, sharedPackageSchema,
  sharedPluginCompatibility, type SharedPackageReference } from './agentSharedPackages.mjs';

const protocol = 'cardbush.shared_configuration.v2' as const;
const maximumBytes = 64 * 1024 * 1024;
const chunkBytes = 512 * 1024;
class SharedConfigurationError extends Error {}
const artifactPaths = pathsForFingerprint();
function pathsForFingerprint() { return ['config/models.json', 'config/apps.json', 'config/mcp-servers.json', 'config/subagents.json', 'config/network.json', 'config/sandbox.json', 'AGENTS.md', 'plugins', 'skills']; }
async function configurationFingerprint(root: string, tracked = artifactPaths) {
  const digest = createHash('sha256');
  async function visit(path: string) {
    const full = join(root, path);
    if (!await exists(full)) { digest.update(path + ':missing'); return; }
    const info = await lstat(full);
    if (info.isSymbolicLink()) { digest.update(path + ':link'); return; }
    if (info.isDirectory()) { for (const entry of (await readdir(full)).sort()) if (!ignoredSharedPackagePath(path + '/' + entry)) await visit(path + '/' + entry); }
    else { digest.update(path); digest.update(await sharedFileFingerprint(full)); }
  }
  for (const path of [...tracked].sort()) await visit(path);
  return digest.digest('hex');
}
const hash = sharedHash;
const digestSchema = sharedDigestSchema;
const paths = [...artifactPaths, 'shared-configuration/current.json'];
const validTransactionPath = (path: string) => paths.includes(path) || sharedPackagePathSchema.safeParse(path).success;
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const object = z.record(z.string(), z.unknown());
const payloadSchema = z.object({ protocol: z.literal(protocol), sourceId: z.string().uuid(), sourcePlatform: z.string(),
  roots: z.array(z.object({ source: z.string(), target: z.enum(['plugins', 'skills', 'bundled/plugins', 'bundled/skills']) }).strict()),
  models: object, apps: object, mcp: object, subagents: object, instructions: z.string().max(1_000_000),
  network: networkProxySchema.optional(), sandbox: z.object({ version: z.literal(1), enabled: z.boolean() }).strict().optional(),
  syncPlugins: z.boolean(), packages: z.array(sharedPackageReferenceSchema).max(sharedPackageLimits.packages),
}).strict();
export type SharedConfiguration = z.infer<typeof payloadSchema>;
export type SharedConfigurationReceipt = { digest: string; warnings: string[] };
export type SharedConfigurationArchive = { digest: string; data: Buffer; packages?: Array<{ digest: string; root: string }> };
export type SharedConfigurationOptions = { syncPlugins?: boolean; excludedPluginIds?: string[]; syncSkills?: boolean };

/** Host-only snapshot: credentials never pass through the renderer or task journal. */
export async function packSharedConfiguration(input: Omit<SharedConfiguration, 'protocol' | 'sourceId' | 'sourcePlatform' | 'packages' | 'syncPlugins'>, dataRoot: string,
  options: SharedConfigurationOptions = { syncPlugins: true }): Promise<SharedConfigurationArchive> {
  const identityPath = join(dataRoot, 'shared-configuration-source.json');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  let sourceId: string;
  try { sourceId = z.string().uuid().parse(JSON.parse(await readFile(identityPath, 'utf8')).id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    sourceId = randomUUID();
    try { await writeFile(identityPath, JSON.stringify({ id: sourceId }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; sourceId = JSON.parse(await readFile(identityPath, 'utf8')).id; }
  }
  const syncPlugins = options.syncPlugins === true;
  const excluded = new Set(options.excludedPluginIds ?? []);
  const packages: SharedPackageReference[] = [];
  const archives: NonNullable<SharedConfigurationArchive['packages']> = [];
  for (const mapping of syncPlugins ? input.roots.filter(item => item.target === 'plugins' || item.target === 'skills' && options.syncSkills !== false) : []) {
    if (!await exists(mapping.source)) continue;
    for (const entry of (await readdir(mapping.source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignoredSharedPackagePath(entry.name) || entry.name.startsWith('.')) continue;
      const root = join(mapping.source, entry.name), path = mapping.target + '/' + entry.name;
      const reference: SharedPackageReference = { path, ...(mapping.target === 'plugins' ? { pluginId: entry.name } : {}) };
      if (reference.pluginId && excluded.has(reference.pluginId)) continue;
      try {
        sharedPackagePathSchema.parse(path);
        if (entry.isSymbolicLink()) throw new SharedPackageError('插件根目录是链接 / package root is a link');
        if (!entry.isDirectory()) continue;
        if (reference.pluginId) {
          const resolved = await resolvePluginManifest(root);
          reference.pluginId = String(resolved.manifest.name);
          if (excluded.has(reference.pluginId)) continue;
        }
        const archive = await packSharedPackage(root);
        reference.digest = archive.digest;
        archives.push({ digest: archive.digest, root });
      } catch (error) {
        reference.issue = error instanceof SharedPackageError ? error.message : '无法读取插件清单或文件 / cannot read package manifest or files';
      }
      packages.push(reference);
    }
  }
  const apps = syncPlugins ? { ...input.apps, plugins: ((input.apps.plugins as Array<{ id: string }> | undefined) ?? []).filter(plugin => !excluded.has(plugin.id)) } : {};
  // Opting out must also keep plugin credentials and standalone MCP configuration off the wire.
  const snapshot = payloadSchema.parse({ ...input, apps, mcp: syncPlugins ? input.mcp : {}, protocol, sourceId, sourcePlatform: process.platform, syncPlugins, packages });
  const data = gzipSync(JSON.stringify(snapshot));
  if (data.length > maximumBytes) throw new Error('Shared configuration archive exceeds 64 MiB.');
  return { digest: hash(data), data, packages: archives };
}

export async function sendSharedConfiguration(call: (input: Record<string, unknown>) => Promise<unknown>, archive: SharedConfigurationArchive): Promise<SharedConfigurationReceipt> {
  const current = await call({ action: 'status' }) as SharedConfigurationReceipt | null;
  if (current?.digest === archive.digest) return current;
  const candidates = archive.packages ?? [];
  const missing = candidates.length ? await call({ action: 'packages', digests: [...new Set(candidates.map(item => item.digest))] }) as { missing: string[] } : { missing: [] };
  const transfer = async (item: { digest: string; data: Buffer }, kind: 'configuration' | 'package') => {
    await call({ action: 'begin', digest: item.digest, size: item.data.length, kind });
    for (let offset = 0; offset < item.data.length; offset += chunkBytes) {
      await call({ action: 'chunk', digest: item.digest, offset, data: item.data.subarray(offset, offset + chunkBytes).toString('base64') });
    }
    return call({ action: 'apply', digest: item.digest });
  };
  for (const digest of missing.missing) {
    const source = candidates.find(item => item.digest === digest);
    if (!source) throw new Error('Agent requested an unknown plugin package.');
    const packed = await packSharedPackage(source.root);
    if (packed.digest !== digest) throw new Error('插件已更新，请重新同步 / plugin changed; synchronize again.');
    await transfer(packed, 'package');
  }
  return await transfer(archive, 'configuration') as SharedConfigurationReceipt;
}

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('packages'), digests: z.array(digestSchema).max(sharedPackageLimits.packages) }).strict(),
  z.object({ action: z.literal('begin'), digest: digestSchema, size: z.number().int().positive().max(maximumBytes), kind: z.enum(['configuration', 'package']).default('configuration') }).strict(),
  z.object({ action: z.literal('chunk'), digest: digestSchema, offset: z.number().int().nonnegative(), data: z.string().max(Math.ceil(chunkBytes / 3) * 4) }).strict(),
  z.object({ action: z.literal('apply'), digest: digestSchema }).strict(),
]);

type Transaction = { id: string; entries: Array<{ path: string; existed: boolean }> };
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
}
function transactionPaths(root: string, id: string) {
  z.string().uuid().parse(id);
  return { stage: join(root, 'shared-configuration', 'staging', id), backup: join(root, 'shared-configuration', 'backups', id) };
}
async function pruneBackups(root: string) {
  const directory = join(root, 'shared-configuration', 'backups');
  const backups = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
    const { backup } = transactionPaths(root, entry.name);
    backups.push({ path: backup, created: (await lstat(backup)).birthtimeMs });
  }
  backups.sort((a, b) => a.created - b.created);
  // Keep the original Agent configuration and the two most recent replacements.
  for (const entry of backups.slice(1, -2)) await rm(entry.path, { recursive: true, force: true });
}
async function prunePackageCache(root: string) {
  const keep = new Set<string>();
  const retain = async (path: string) => {
    if (!await exists(path)) return;
    const receipt = JSON.parse(await readFile(path, 'utf8'));
    for (const entry of Object.values(receipt.packages ?? {}) as Array<{ digest?: unknown }>) {
      if (digestSchema.safeParse(entry.digest).success) keep.add(String(entry.digest));
    }
  };
  await retain(join(root, 'shared-configuration', 'current.json'));
  const backups = join(root, 'shared-configuration', 'backups');
  for (const name of await readdir(backups)) {
    if (z.string().uuid().safeParse(name).success) await retain(join(backups, name, 'shared-configuration', 'current.json'));
  }
  const cache = join(root, 'shared-configuration', 'packages');
  if (!await exists(cache)) return;
  for (const name of await readdir(cache)) {
    if (/^[a-f0-9]{64}\.gz$/.test(name) && !keep.has(name.slice(0, -3))) await rm(join(cache, name), { force: true });
  }
}
async function rollback(root: string, transaction: Transaction) {
  const { backup } = transactionPaths(root, transaction.id);
  const mcpPath = join(root, 'config', 'mcp-servers.json');
  const attemptedRevision = await readFile(mcpPath, 'utf8').then(text => Number(JSON.parse(text).revision) || 0, () => 0);
  for (const entry of [...transaction.entries].reverse()) {
    if (!validTransactionPath(entry.path)) throw new Error('Invalid shared configuration recovery path.');
    const target = join(root, entry.path), previous = join(backup, entry.path);
    if (await exists(previous)) {
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await rename(previous, target);
    } else if (!entry.existed) await rm(target, { recursive: true, force: true });
  }
  if (transaction.entries.some(entry => entry.path === 'config/mcp-servers.json')) {
    const prior = await new ProductMcpConfigStore(mcpPath).read();
    await writeJson(mcpPath, { ...prior, revision: Math.max(attemptedRevision, prior.revision) + 1 });
    const receiptPath = join(root, 'shared-configuration', 'current.json');
    if (await exists(receiptPath)) {
      const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      await writeJson(receiptPath, { ...receipt, appliedFingerprint: await configurationFingerprint(root, receipt.trackedPaths) });
    }
  }
  await rm(join(root, 'shared-configuration', 'transaction.json'), { force: true });
}
/** Restore an interrupted replacement before creating Runtime or reading settings. */
export async function recoverSharedConfiguration(root: string) {
  const journal = join(root, 'shared-configuration', 'transaction.json');
  if (await exists(journal)) await rollback(root, JSON.parse(await readFile(journal, 'utf8')));
}

export class AgentSharedConfiguration {
  #upload?: { digest: string; size: number; kind: 'configuration' | 'package'; data: Buffer[]; received: number; updated: number };
  constructor(readonly root: string, readonly bundledRoot: string, readonly assertIdle: () => void, readonly refresh: () => Promise<unknown>,
    readonly host: { platform: string; capabilities: Record<string, unknown> } = { platform: process.platform, capabilities: {} }) {}
  private hostFingerprint() { return hash(JSON.stringify([this.host.platform, Object.entries(this.host.capabilities).sort(([a], [b]) => a.localeCompare(b))])); }
  private packagePath(digest: string) { return join(this.root, 'shared-configuration', 'packages', digestSchema.parse(digest) + '.gz'); }
  async call(input: unknown): Promise<SharedConfigurationReceipt | null | { accepted: true } | { missing: string[] }> {
    const request = requestSchema.parse(input);
    const receiptPath = join(this.root, 'shared-configuration', 'current.json');
    const current = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')) : null;
    if (request.action === 'status') return current && !current.recoveryRequired && current.hostFingerprint === this.hostFingerprint() && current.appliedFingerprint === await configurationFingerprint(this.root, current.trackedPaths) ? { digest: current.digest, warnings: current.warnings } : null;
    if (request.action === 'packages') {
      const missing = [];
      for (const digest of request.digests) {
        const path = this.packagePath(digest);
        if (!await exists(path) || await sharedFileFingerprint(path) !== digest) missing.push(digest);
      }
      return { missing };
    }
    if (request.action === 'begin') {
      this.assertIdle();
      this.#upload = { digest: request.digest, size: request.size, kind: request.kind, data: [], received: 0, updated: Date.now() };
      return { accepted: true };
    }
    const upload = this.#upload;
    if (!upload || upload.digest !== request.digest || Date.now() - upload.updated > 120_000) throw new Error('Configuration upload expired. Retry the operation.');
    if (request.action === 'chunk') {
      const chunk = Buffer.from(request.data, 'base64');
      if (chunk.toString('base64') !== request.data || !chunk.length || request.offset !== upload.received || upload.received + chunk.length > upload.size) throw new Error('Invalid configuration upload chunk.');
      upload.data.push(chunk); upload.received += chunk.length; upload.updated = Date.now();
      return { accepted: true };
    }
    this.assertIdle();
    const data = Buffer.concat(upload.data);
    this.#upload = undefined;
    if (data.length !== upload.size || hash(data) !== request.digest) throw new Error('Configuration upload is incomplete or corrupt.');
    if (upload.kind === 'package') {
      try { sharedPackageSchema.parse(JSON.parse(gunzipSync(data, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8'))); }
      catch { throw new Error('Invalid shared plugin package.'); }
      const path = this.packagePath(upload.digest), temporary = path + '.' + randomUUID() + '.tmp';
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await rm(temporary, { force: true }); }
      return { accepted: true };
    }
    let payload: SharedConfiguration;
    try { payload = payloadSchema.parse(JSON.parse(gunzipSync(data, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8'))); }
    catch { throw new Error('Invalid shared configuration archive.'); }
    if (current?.sourceId && current.sourceId !== payload.sourceId) throw new Error('此 Agent 已由另一套配置管理，请使用独立的 Agent 数据目录。This Agent belongs to another configuration source.');
    return this.apply(payload, request.digest, current);
  }
  private async apply(payload: SharedConfiguration, digest: string, current: { packages?: Record<string, { digest: string; fingerprint: string; platform?: string }> } | null): Promise<SharedConfigurationReceipt> {
    const id = randomUUID(), { stage, backup } = transactionPaths(this.root, id);
    const warnings: string[] = [];
    const target = (key: string) => key.startsWith('bundled/') ? join(this.bundledRoot, key.slice(8)) : join(this.root, key);
    const translate = (value: unknown): unknown => {
      if (typeof value === 'string') {
        for (const mapping of [...payload.roots].sort((a, b) => b.source.length - a.source.length)) {
          const normalized = value.replaceAll('\\', '/'), prefix = mapping.source.replaceAll('\\', '/').replace(/\/$/, '');
          if ((payload.sourcePlatform === 'win32' ? normalized.toLowerCase() : normalized).startsWith((payload.sourcePlatform === 'win32' ? prefix.toLowerCase() : prefix) + '/')) return target(mapping.target) + normalized.slice(prefix.length).split('/').join(sep);
          if (normalized === prefix) return target(mapping.target);
        }
        return value;
      }
      if (Array.isArray(value)) return value.map(translate);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, translate(item)]));
      return value;
    };
    let transaction: Transaction | undefined;
    let phase = '插件与技能文件 / plugin and skill files';
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      const changed: string[] = [], failed = new Set<string>();
      const packages = { ...current?.packages };
      if (new Set(payload.packages.map(item => item.path.toLowerCase())).size !== payload.packages.length) throw new Error('Duplicate plugin package path.');
      for (const item of payload.syncPlugins ? payload.packages : []) {
        if (item.issue) {
          warnings.push(`${item.pluginId ?? item.path}: ${item.issue}；保留云端原状态 / previous Agent state retained`);
          if (item.pluginId) failed.add(item.pluginId);
          continue;
        }
        const previous = packages[item.path];
        if (previous?.platform === this.host.platform && previous.digest === item.digest && previous.fingerprint === await sharedPackageFingerprint(join(this.root, item.path))) continue;
        const compressed = await readFile(this.packagePath(item.digest!));
        if (hash(compressed) !== item.digest) throw new Error('Plugin package cache is corrupt.');
        const packed = sharedPackageSchema.parse(JSON.parse(gunzipSync(compressed, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8')));
        const directory = join(stage, item.path);
        await materializePluginArchive(packed.files.map(file => {
          if (ignoredSharedPackagePath(file.path)) throw new Error('Generated dependencies are not accepted in shared packages.');
          const data = Buffer.from(file.data, 'base64');
          if (data.toString('base64') !== file.data) throw new Error('Invalid configuration file encoding.');
          return { kind: 'file' as const, path: file.path, data, mode: file.mode };
        }), directory);
        if (item.pluginId) {
          try {
            if ((await resolvePluginManifest(directory)).manifest.name !== item.pluginId) throw new Error('Plugin ID mismatch');
          } catch {
            failed.add(item.pluginId);
            warnings.push(`${item.pluginId}: 插件清单不可用，保留云端原状态 / invalid manifest; previous Agent state retained`);
            await rm(directory, { recursive: true, force: true });
            continue;
          }
        }
        changed.push(item.path);
        packages[item.path] = { digest: item.digest!, fingerprint: await sharedPackageFingerprint(directory), platform: this.host.platform };
      }
      phase = '插件清单 / plugin catalog';
      const catalog = await loadProductPluginCatalog([{ path: join(this.bundledRoot, 'plugins'), source: 'bundled' },
        { path: join(this.root, 'plugins'), source: 'user' }, { path: join(stage, 'plugins'), source: 'user' }]);
      phase = '模型配置 / model configuration';
      const models = new ProductModelConfigStore(join(stage, 'config', 'models.json'));
      await models.write(payload.models);
      phase = '插件配置 / plugin configuration';
      // Seed with remote state so unchecked/failed plugins retain both their files and settings.
      if (await exists(join(this.root, 'config', 'apps.json'))) {
        await mkdir(join(stage, 'config'), { recursive: true });
        await writeFile(join(stage, 'config', 'apps.json'), await readFile(join(this.root, 'config', 'apps.json')), { mode: 0o600 });
      }
      const apps = structuredClone(payload.apps) as { plugins?: Array<Record<string, unknown>> } & Record<string, unknown>;
      apps.plugins = (apps.plugins ?? []).flatMap(plugin => {
        const name = String(plugin.id);
        if (failed.has(name)) return [];
        if (!catalog.some(item => item.id === name)) {
          if (plugin.installed) warnings.push(`${name}: 云端缺少此插件；请更新 Agent 内置插件包 / plugin unavailable on Agent`);
          return [];
        }
        const result = { ...plugin, config: translate(plugin.config) };
        return [result];
      });
      for (const plugin of apps.plugins) {
        if (!plugin.enabled) continue;
        const entry = catalog.find(item => item.id === plugin.id)!;
        const resolved = await resolvePluginManifest(pluginRootForManifest(entry.manifestPath), this.host.platform);
        const reason = sharedPluginCompatibility(resolved.manifest, plugin.config, this.host.platform, this.host.capabilities);
        if (reason) { plugin.enabled = false; warnings.push(`${plugin.id}: ${reason}；配置已同步，暂未启用 / settings synchronized; not enabled`); }
      }
      if (payload.syncPlugins) {
        const nextApps = await new CardbushAppsConfigStore(join(stage, 'config', 'apps.json'), { loadCatalog: async () => catalog }).write(apps);
        const oldAppsRevision = await readFile(join(this.root, 'config', 'apps.json'), 'utf8').then(text => Number(JSON.parse(text).revision) || 0, () => 0);
        await writeJson(join(stage, 'config', 'apps.json'), { ...nextApps, revision: oldAppsRevision + 1 });
      }
      phase = 'MCP 配置 / MCP configuration';
      const mcp = translate(payload.mcp) as { servers?: Array<Record<string, unknown>> };
      const servers = (mcp.servers ?? []).map(server => {
        if (this.host.platform !== 'win32' && server.transport === 'stdio' && /[A-Za-z]:[\\/]|\\\\|\.exe(?:"|$)/.test(JSON.stringify([server.command, server.args, server.cwd]))) {
          warnings.push('MCP ' + String(server.id) + ' 使用本机平台路径，云端暂未启用。MCP requires a portable command.'); return { ...server, enabled: false };
        }
        return server;
      });
      if (payload.syncPlugins) {
        const remoteMcp = await new ProductMcpConfigStore(join(this.root, 'config', 'mcp-servers.json')).read();
        const nextMcp = await new ProductMcpConfigStore(join(stage, 'config', 'mcp-servers.json')).write({ servers });
        await writeJson(join(stage, 'config', 'mcp-servers.json'), { ...nextMcp, revision: remoteMcp.revision + 1 });
      }
      phase = '子代理配置 / child agent configuration';
      await writeJson(join(stage, 'config', 'subagents.json'), decodeProductSubagentConfig(payload.subagents));
      if (payload.network) await writeJson(join(stage, 'config', 'network.json'), payload.network);
      if (payload.sandbox) await writeJson(join(stage, 'config', 'sandbox.json'), payload.sandbox);
      await writeFile(join(stage, 'AGENTS.md'), payload.instructions, { mode: 0o600 });
      const replacing = [...paths.filter(path => !['plugins', 'skills'].includes(path) &&
        (payload.syncPlugins || !['config/apps.json', 'config/mcp-servers.json'].includes(path))), ...changed];
      const trackedPaths = replacing.filter(path => path !== 'shared-configuration/current.json').concat(payload.packages.filter(item => item.digest && !changed.includes(item.path) && !failed.has(item.pluginId ?? '')).map(item => item.path));
      const receipt = { digest, warnings, sourceId: payload.sourceId, packages, trackedPaths, platform: this.host.platform, hostFingerprint: this.hostFingerprint() };
      await writeJson(join(stage, 'shared-configuration', 'current.json'), receipt);
      phase = '配置文件替换 / configuration replacement';
      transaction = { id, entries: [] };
      for (const path of replacing) {
        if (path === 'config/network.json' && !payload.network || path === 'config/sandbox.json' && !payload.sandbox) continue;
        const parent = dirname(join(this.root, path)); await mkdir(parent, { recursive: true });
        const actual = await realpath(parent), root = await realpath(this.root);
        if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Configuration target escapes the Agent directory.');
        transaction.entries.push({ path, existed: await exists(join(this.root, path)) });
      }
      await writeJson(join(this.root, 'shared-configuration', 'transaction.json'), transaction);
      for (const entry of transaction.entries) {
        const destination = join(this.root, entry.path), previous = join(backup, entry.path);
        await mkdir(dirname(previous), { recursive: true, mode: 0o700 });
        if (entry.existed) await rename(destination, previous);
        await rename(join(stage, entry.path), destination);
      }
      phase = '插件启用 / plugin activation';
      const refreshed = await this.refresh() as { applicationState?: string; applicationError?: string };
      if (refreshed?.applicationError || (refreshed?.applicationState && refreshed.applicationState !== 'applied')) throw new SharedConfigurationError('云端未能应用插件配置；已保留上一套配置。The Agent could not apply plugin configuration.');
      await writeJson(join(this.root, 'shared-configuration', 'current.json'), { ...receipt, appliedFingerprint: await configurationFingerprint(this.root, trackedPaths) });
      await rm(join(this.root, 'shared-configuration', 'transaction.json'), { force: true });
      await pruneBackups(this.root).catch(() => undefined);
      await prunePackageCache(this.root).catch(() => undefined);
      return { digest, warnings };
    } catch (error) {
      if (transaction && await exists(join(this.root, 'shared-configuration', 'transaction.json'))) {
        await rollback(this.root, transaction);
        const restored = await this.refresh().catch(() => null) as { applicationState?: string; applicationError?: string } | null;
        if (!restored || restored.applicationError || restored.applicationState && restored.applicationState !== 'applied') {
          const receiptPath = join(this.root, 'shared-configuration', 'current.json');
          if (await exists(receiptPath)) await writeJson(receiptPath, { ...JSON.parse(await readFile(receiptPath, 'utf8')), recoveryRequired: true });
        }
      }
      // Store validators can include supplied values. Do not return credentials in diagnostics.
      throw new Error(error instanceof SharedConfigurationError ? error.message : '配置同步失败（' + phase + '），未提交新配置。Shared configuration was not committed.', { cause: error });
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
