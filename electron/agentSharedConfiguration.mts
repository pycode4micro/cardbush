import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { networkProxySchema } from '@cardbush/bush-protocol';
import { CardbushAppsConfigStore, ProductModelConfigStore, ProductMcpConfigStore, decodeProductSubagentConfig } from '@cardbush/product-host';
import { loadProductPluginCatalog } from './productPlugins.js';
import { materializePluginArchive } from './pluginArchiveTree.js';

const protocol = 'cardbush.shared_configuration.v1' as const;
const maximumBytes = 64 * 1024 * 1024;
const chunkBytes = 512 * 1024;
class SharedConfigurationError extends Error {}
const artifactPaths = pathsForFingerprint();
function pathsForFingerprint() { return ['config/models.json', 'config/apps.json', 'config/mcp-servers.json', 'config/subagents.json', 'config/network.json', 'config/sandbox.json', 'AGENTS.md', 'plugins', 'skills']; }
async function configurationFingerprint(root: string) {
  const digest = createHash('sha256');
  async function visit(path: string) {
    const full = join(root, path);
    if (!await exists(full)) { digest.update(path + ':missing'); return; }
    const info = await lstat(full);
    if (info.isSymbolicLink()) { digest.update(path + ':link'); return; }
    if (info.isDirectory()) { for (const entry of (await readdir(full)).sort()) await visit(path + '/' + entry); }
    else { digest.update(path); digest.update(await readFile(full)); }
  }
  for (const path of artifactPaths) await visit(path);
  return digest.digest('hex');
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const paths = [...artifactPaths, 'shared-configuration/current.json'];
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const object = z.record(z.string(), z.unknown());
const fileSchema = z.object({ path: z.string().min(1), data: z.string(), mode: z.number().int() }).strict();
const payloadSchema = z.object({ protocol: z.literal(protocol), sourceId: z.string().uuid(), sourcePlatform: z.string(),
  roots: z.array(z.object({ source: z.string(), target: z.enum(['plugins', 'skills', 'bundled/plugins', 'bundled/skills']) }).strict()),
  models: object, apps: object, mcp: object, subagents: object, instructions: z.string().max(1_000_000),
  network: networkProxySchema.optional(), sandbox: z.object({ version: z.literal(1), enabled: z.boolean() }).strict().optional(),
  files: z.array(fileSchema).max(2000),
}).strict();
export type SharedConfiguration = z.infer<typeof payloadSchema>;
export type SharedConfigurationReceipt = { digest: string; warnings: string[] };
export type SharedConfigurationArchive = { digest: string; data: Buffer };

/** Host-only snapshot: credentials never pass through the renderer or task journal. */
export async function packSharedConfiguration(input: Omit<SharedConfiguration, 'protocol' | 'sourceId' | 'sourcePlatform' | 'files'>, dataRoot: string): Promise<SharedConfigurationArchive> {
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
  const files: SharedConfiguration['files'] = [];
  let bytes = 0;
  async function walk(root: string, path: string, prefix: string) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.git', '.DS_Store', '__pycache__'].includes(entry.name)) continue;
      const full = join(path, entry.name), item = prefix + '/' + relative(root, full).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error('配置同步不支持链接文件，请将插件安装为独立文件包。Shared configuration requires self-contained plugin files.');
      if (entry.isDirectory()) await walk(root, full, prefix);
      else if (entry.isFile()) {
        const info = await lstat(full);
        if (info.size > 16 * 1024 * 1024 || bytes + info.size > maximumBytes || files.length >= 2000) throw new Error('插件或技能超过配置同步大小限制（单文件 16 MiB、总计 64 MiB / 2000 文件）。');
        const data = await readFile(full);
        if (data.length > 16 * 1024 * 1024 || bytes + data.length > maximumBytes) throw new Error('Shared configuration files changed beyond the size limit. Retry after installation completes.');
        bytes += data.length;
        files.push({ path: item, data: data.toString('base64'), mode: info.mode & 0o777 });
      }
    }
  }
  for (const mapping of input.roots.filter(item => item.target === 'plugins' || item.target === 'skills')) {
    if (await exists(mapping.source)) await walk(mapping.source, mapping.source, mapping.target);
  }
  const snapshot = payloadSchema.parse({ ...input, protocol, sourceId, sourcePlatform: process.platform, files });
  const data = gzipSync(JSON.stringify(snapshot));
  if (data.length > maximumBytes) throw new Error('Shared configuration archive exceeds 64 MiB.');
  return { digest: hash(data), data };
}

export async function sendSharedConfiguration(call: (input: Record<string, unknown>) => Promise<unknown>, archive: SharedConfigurationArchive): Promise<SharedConfigurationReceipt> {
  const current = await call({ action: 'status' }) as SharedConfigurationReceipt | null;
  if (current?.digest === archive.digest) return current;
  await call({ action: 'begin', digest: archive.digest, size: archive.data.length });
  for (let offset = 0; offset < archive.data.length; offset += chunkBytes) {
    await call({ action: 'chunk', digest: archive.digest, offset, data: archive.data.subarray(offset, offset + chunkBytes).toString('base64') });
  }
  return await call({ action: 'apply', digest: archive.digest }) as SharedConfigurationReceipt;
}

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('begin'), digest: digestSchema, size: z.number().int().positive().max(maximumBytes) }).strict(),
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
async function rollback(root: string, transaction: Transaction) {
  const { backup } = transactionPaths(root, transaction.id);
  const mcpPath = join(root, 'config', 'mcp-servers.json');
  const attemptedRevision = await readFile(mcpPath, 'utf8').then(text => Number(JSON.parse(text).revision) || 0, () => 0);
  for (const entry of [...transaction.entries].reverse()) {
    if (!paths.includes(entry.path)) throw new Error('Invalid shared configuration recovery path.');
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
    if (await exists(receiptPath)) await writeJson(receiptPath, { ...JSON.parse(await readFile(receiptPath, 'utf8')), appliedFingerprint: await configurationFingerprint(root) });
  }
  await rm(join(root, 'shared-configuration', 'transaction.json'), { force: true });
}
/** Restore an interrupted replacement before creating Runtime or reading settings. */
export async function recoverSharedConfiguration(root: string) {
  const journal = join(root, 'shared-configuration', 'transaction.json');
  if (await exists(journal)) await rollback(root, JSON.parse(await readFile(journal, 'utf8')));
}

export class AgentSharedConfiguration {
  #upload?: { digest: string; size: number; data: Buffer[]; received: number; updated: number };
  constructor(readonly root: string, readonly bundledRoot: string, readonly assertIdle: () => void, readonly refresh: () => Promise<unknown>) {}
  async call(input: unknown): Promise<SharedConfigurationReceipt | null | { accepted: true }> {
    const request = requestSchema.parse(input);
    const receiptPath = join(this.root, 'shared-configuration', 'current.json');
    const current = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')) : null;
    if (request.action === 'status') return current && !current.recoveryRequired && current.appliedFingerprint === await configurationFingerprint(this.root) ? { digest: current.digest, warnings: current.warnings } : null;
    if (request.action === 'begin') {
      this.assertIdle();
      this.#upload = { digest: request.digest, size: request.size, data: [], received: 0, updated: Date.now() };
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
    let payload: SharedConfiguration;
    try { payload = payloadSchema.parse(JSON.parse(gunzipSync(data, { maxOutputLength: 96 * 1024 * 1024 }).toString('utf8'))); }
    catch { throw new Error('Invalid shared configuration archive.'); }
    if (current?.sourceId && current.sourceId !== payload.sourceId) throw new Error('此 Agent 已由另一套配置管理，请使用独立的 Agent 数据目录。This Agent belongs to another configuration source.');
    return this.apply(payload, request.digest);
  }
  private async apply(payload: SharedConfiguration, digest: string): Promise<SharedConfigurationReceipt> {
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
      if (payload.files.length) await materializePluginArchive(payload.files.map(file => {
        if (!/^(plugins|skills)\//.test(file.path)) throw new Error('Configuration file must belong to plugins or skills.');
        const data = Buffer.from(file.data, 'base64');
        if (data.toString('base64') !== file.data) throw new Error('Invalid configuration file encoding.');
        return { kind: 'file' as const, path: file.path, data, mode: file.mode };
      }), stage);
      for (const name of ['plugins', 'skills']) await mkdir(join(stage, name), { recursive: true });
      phase = '插件清单 / plugin catalog';
      const catalog = await loadProductPluginCatalog([{ path: join(this.bundledRoot, 'plugins'), source: 'bundled' }, { path: join(stage, 'plugins'), source: 'user' }]);
      phase = '模型配置 / model configuration';
      const models = new ProductModelConfigStore(join(stage, 'config', 'models.json'));
      await models.write(payload.models);
      phase = '插件配置 / plugin configuration';
      const apps = structuredClone(payload.apps) as { plugins?: Array<Record<string, unknown>> } & Record<string, unknown>;
      apps.plugins = (apps.plugins ?? []).map(plugin => {
        const name = String(plugin.id);
        if (plugin.installed && !catalog.some(item => item.id === name) && !['chrome', 'computer-use'].includes(name)) throw new SharedConfigurationError('云端缺少内置插件 ' + name + '，请更新 Agent 服务。Missing bundled plugin; update the Agent service.');
        const result = { ...plugin, config: translate(plugin.config) };
        if (['chrome', 'computer-use'].includes(name)) return { ...result, enabled: false };
        const entry = catalog.find(item => item.id === name);
        const local = entry?.manifestPath ? relative(join(stage, 'plugins'), dirname(dirname(entry.manifestPath))).split(sep).join('/') : '';
        if (payload.sourcePlatform !== process.platform && local && payload.files.some(file => file.path.startsWith('plugins/' + local + '/') && /\.(exe|dll|node|dylib|so)$/i.test(file.path))) {
          warnings.push('插件 ' + name + ' 包含其他平台的二进制文件，云端暂未启用。Plugin requires a package for the Agent platform.');
          return { ...result, enabled: false };
        }
        return result;
      });
      const nextApps = await new CardbushAppsConfigStore(join(stage, 'config', 'apps.json'), { loadCatalog: async () => catalog }).write(apps);
      const oldAppsRevision = await readFile(join(this.root, 'config', 'apps.json'), 'utf8').then(text => Number(JSON.parse(text).revision) || 0, () => 0);
      await writeJson(join(stage, 'config', 'apps.json'), { ...nextApps, revision: oldAppsRevision + 1 });
      phase = 'MCP 配置 / MCP configuration';
      const mcp = translate(payload.mcp) as { servers?: Array<Record<string, unknown>> };
      const servers = (mcp.servers ?? []).map(server => {
        if (payload.sourcePlatform !== process.platform && server.transport === 'stdio' && /[A-Za-z]:[\\/]|\\\\|\.exe(?:"|$)/.test(JSON.stringify([server.command, server.args, server.cwd]))) {
          warnings.push('MCP ' + String(server.id) + ' 使用本机平台路径，云端暂未启用。MCP requires a portable command.'); return { ...server, enabled: false };
        }
        return server;
      });
      const remoteMcp = await new ProductMcpConfigStore(join(this.root, 'config', 'mcp-servers.json')).read();
      const nextMcp = await new ProductMcpConfigStore(join(stage, 'config', 'mcp-servers.json')).write({ servers });
      await writeJson(join(stage, 'config', 'mcp-servers.json'), { ...nextMcp, revision: remoteMcp.revision + 1 });
      phase = '子代理配置 / child agent configuration';
      await writeJson(join(stage, 'config', 'subagents.json'), decodeProductSubagentConfig(payload.subagents));
      if (payload.network) await writeJson(join(stage, 'config', 'network.json'), payload.network);
      if (payload.sandbox) await writeJson(join(stage, 'config', 'sandbox.json'), payload.sandbox);
      await writeFile(join(stage, 'AGENTS.md'), payload.instructions, { mode: 0o600 });
      const receipt = { digest, warnings, sourceId: payload.sourceId };
      await writeJson(join(stage, 'shared-configuration', 'current.json'), receipt);
      phase = '配置文件替换 / configuration replacement';
      transaction = { id, entries: [] };
      for (const path of paths) {
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
      await writeJson(join(this.root, 'shared-configuration', 'current.json'), { ...receipt, appliedFingerprint: await configurationFingerprint(this.root) });
      await rm(join(this.root, 'shared-configuration', 'transaction.json'), { force: true });
      await pruneBackups(this.root).catch(() => undefined);
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
