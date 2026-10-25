import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { networkProxySchema } from '@cardbush/bush-protocol';
import { ProductModelConfigStore, ProductMcpConfigStore, decodeProductSubagentConfig } from '@cardbush/product-host';
import { replaceFileWithRetry, writePrivateJson as writeJson } from './atomicJsonFile.mjs';
import { redactTroubleshootingText } from './pluginTroubleshooting.mjs';
import { ignoredSharedPackagePath, sharedDigestSchema, sharedFileFingerprint, sharedHash,
  sharedPackagePathSchema, sharedPackageReferenceSchema, sharedPackageLimits } from './agentSharedPackages.mjs';

const protocol = 'cardbush.shared_configuration.v2' as const;
const maximumBytes = 64 * 1024 * 1024;
const chunkBytes = 512 * 1024;
class SharedConfigurationError extends Error {}
const pluginSyncRemoved = '插件与技能同步已移除。请按 cardbush-docs 在目标 Agent 安装所需插件和依赖。Plugin and skill sync was removed; follow cardbush-docs to install on the target Agent.';
type ApplicationState = { snapshotId?: string; revision?: number; pendingRevision?: number;
  applicationState?: string; applicationPhase?: string; applicationError?: string; backgroundConnectionPending?: boolean };
// Config validators and plugin launch errors may echo arbitrary configured values.
function configurationValues(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(configurationValues);
}
const artifactPaths = ['config/models.json', 'config/subagents.json', 'config/network.json', 'config/sandbox.json', 'AGENTS.md'];
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
// Old interrupted plugin transactions still need to recover before Runtime starts.
const validTransactionPath = (path: string) => paths.includes(path) ||
  ['config/apps.json', 'config/mcp-servers.json', 'plugins', 'skills'].includes(path) || sharedPackagePathSchema.safeParse(path).success;
const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const object = z.record(z.string(), z.unknown());
const payloadSchema = z.object({ protocol: z.literal(protocol), sourceId: z.string().uuid(), sourcePlatform: z.string(),
  // Legacy fields keep settings-only v2 peers compatible; installation requests are rejected below.
  roots: z.array(z.object({ source: z.string(), target: z.enum(['plugins', 'skills', 'bundled/plugins', 'bundled/skills']) }).strict()),
  models: object, apps: object, mcp: object, subagents: object, instructions: z.string().max(1_000_000),
  network: networkProxySchema.optional(), sandbox: z.object({ version: z.literal(1), enabled: z.boolean() }).strict().optional(),
  syncPlugins: z.boolean(), packages: z.array(sharedPackageReferenceSchema).max(sharedPackageLimits.packages),
}).strict();
export type SharedConfiguration = z.infer<typeof payloadSchema>;
export type SharedConfigurationReceipt = { digest: string; warnings: string[] };
export type SharedConfigurationArchive = { digest: string; data: Buffer };

/** Host-only snapshot: credentials never pass through the renderer or task journal. */
export async function packSharedConfiguration(input: Pick<SharedConfiguration, 'models' | 'subagents' | 'instructions' | 'network' | 'sandbox'>, dataRoot: string): Promise<SharedConfigurationArchive> {
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
  // Retain the v2 wire shape for settings-only peers. Never read plugin roots or
  // export plugin settings, enabled state, standalone skills or local MCP entries.
  const snapshot = payloadSchema.parse({ protocol, sourceId, sourcePlatform: process.platform,
    models: input.models, subagents: input.subagents, instructions: input.instructions, network: input.network, sandbox: input.sandbox,
    roots: [], apps: {}, mcp: {}, syncPlugins: false, packages: [] });
  const data = gzipSync(JSON.stringify(snapshot));
  if (data.length > maximumBytes) throw new Error('Shared configuration archive exceeds 64 MiB.');
  return { digest: hash(data), data };
}

export async function sendSharedConfiguration(call: (input: Record<string, unknown>) => Promise<unknown>, archive: SharedConfigurationArchive): Promise<SharedConfigurationReceipt> {
  if ((archive as { packages?: unknown[] }).packages?.length) throw new Error(pluginSyncRemoved);
  const current = await call({ action: 'status' }) as SharedConfigurationReceipt | null;
  if (current?.digest === archive.digest) return current;
  await call({ action: 'begin', digest: archive.digest, size: archive.data.length, kind: 'configuration' });
  for (let offset = 0; offset < archive.data.length; offset += chunkBytes) {
    await call({ action: 'chunk', digest: archive.digest, offset, data: archive.data.subarray(offset, offset + chunkBytes).toString('base64') });
  }
  return await call({ action: 'apply', digest: archive.digest }) as SharedConfigurationReceipt;
}

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('packages'), digests: z.array(digestSchema).max(sharedPackageLimits.packages) }).strict(),
  z.object({ action: z.literal('begin'), digest: digestSchema, size: z.number().int().positive().max(maximumBytes), kind: z.enum(['configuration', 'package']).default('configuration') }).strict(),
  z.object({ action: z.literal('chunk'), digest: digestSchema, offset: z.number().int().nonnegative(), data: z.string().max(Math.ceil(chunkBytes / 3) * 4) }).strict(),
  z.object({ action: z.literal('apply'), digest: digestSchema }).strict(),
]);

type Transaction = { id: string; entries: Array<{ path: string; existed: boolean }> };
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
    if (!validTransactionPath(entry.path)) throw new Error('Invalid shared configuration recovery path.');
    const target = join(root, entry.path), previous = join(backup, entry.path);
    if (await exists(previous)) {
      await rm(target, { recursive: true, force: true });
      await mkdir(dirname(target), { recursive: true });
      await replaceFileWithRetry(previous, target);
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
  #upload?: { digest: string; size: number; data: Buffer[]; received: number; updated: number };
  constructor(readonly root: string, readonly bundledRoot: string, readonly assertIdle: () => void, readonly refresh: () => Promise<unknown>,
    readonly host: { platform: string; capabilities: Record<string, unknown>; capabilityIssue?: (name: string) => string | undefined } = { platform: process.platform, capabilities: {} },
    readonly application: { read: () => Promise<unknown>; timeoutMs?: number; pollMs?: number } | undefined = undefined) {}
  private async refreshAndWait(secrets: string[]): Promise<void> {
    const clean = (value: string) => redactTroubleshootingText(redactTroubleshootingText(value, secrets));
    const failure = (detail: string) => new SharedConfigurationError(`配置应用未完成：${clean(detail)} / Agent configuration was not applied.`);
    let state: ApplicationState;
    try { state = await this.refresh() as ApplicationState; }
    catch (error) { throw failure(error instanceof Error ? error.message : String(error)); }
    const expectedRevision = state?.pendingRevision ?? state?.revision;
    const expectedId = state?.snapshotId;
    const deadline = Date.now() + (this.application?.timeoutMs ?? 30_000);
    while (true) {
      if (!state || !['pending', 'applied', 'failed'].includes(state.applicationState ?? '')) throw failure('Runtime did not return an application state.');
      if (state.applicationError || state.applicationState === 'failed') throw failure(state.applicationError || 'Runtime rejected the configuration.');
      if (expectedId !== state.snapshotId || expectedRevision !== (state.pendingRevision ?? state.revision)) throw failure('Configuration changed while awaiting application.');
      if (state.applicationState === 'applied') return;
      // Optional MCP connections can initialize independently after a validated
      // configuration is accepted. A slow or unavailable optional plugin must
      // not roll back model settings or hold the service mutation queue.
      if (state.backgroundConnectionPending === true) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure(`Timed out waiting for configuration (${state.applicationPhase ?? 'pending'}).`);
      if (!this.application) throw failure('Runtime application status is unavailable.');
      await new Promise(resolve => setTimeout(resolve, Math.min(remaining, this.application!.pollMs ?? 100)));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        state = await Promise.race([
          this.application.read(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Timed out reading configuration status.')), Math.max(1, deadline - Date.now())); }),
        ]) as ApplicationState;
      } catch (error) { throw failure(error instanceof Error ? error.message : String(error)); }
      finally { clearTimeout(timer); }
    }
  }
  private hostFingerprint() {
    const capabilities = Object.entries(this.host.capabilities).sort(([a], [b]) => a.localeCompare(b));
    const issues = capabilities.filter(([, value]) => value !== true).map(([name]) => [name, this.host.capabilityIssue?.(name) ?? null]);
    return hash(JSON.stringify(['settings-only-v1', this.host.platform, capabilities, issues]));
  }
  async call(input: unknown): Promise<SharedConfigurationReceipt | null | { accepted: true }> {
    const request = requestSchema.parse(input);
    // Fail closed for older clients: connecting must never install or enable a package.
    if (request.action === 'packages' || request.action === 'begin' && request.kind === 'package') throw new Error(pluginSyncRemoved);
    const receiptPath = join(this.root, 'shared-configuration', 'current.json');
    const current = await exists(receiptPath) ? JSON.parse(await readFile(receiptPath, 'utf8')) : null;
    if (request.action === 'status') return current && !current.recoveryRequired && current.hostFingerprint === this.hostFingerprint() && current.appliedFingerprint === await configurationFingerprint(this.root, current.trackedPaths) ? { digest: current.digest, warnings: current.warnings } : null;
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
    if (payload.syncPlugins || payload.packages.length || Object.keys(payload.apps).length) throw new Error(pluginSyncRemoved);
    if (current?.sourceId && current.sourceId !== payload.sourceId) throw new Error('此 Agent 已由另一套配置管理，请使用独立的 Agent 数据目录。This Agent belongs to another configuration source.');
    return this.apply(payload, request.digest);
  }
  private async apply(payload: SharedConfiguration, digest: string): Promise<SharedConfigurationReceipt> {
    const id = randomUUID(), { stage, backup } = transactionPaths(this.root, id);
    const warnings: string[] = [];
    const secrets = configurationValues([payload.models, payload.apps, payload.mcp, payload.network]);
    // Rollback diagnostics may mention credentials from the previous configuration too.
    for (const file of ['models.json', 'apps.json', 'mcp-servers.json', 'network.json']) {
      try { secrets.push(...configurationValues(JSON.parse(await readFile(join(this.root, 'config', file), 'utf8')))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let transaction: Transaction | undefined;
    let phase = '模型配置 / model configuration';
    let replacementPath: string | undefined, preserveStage = false;
    try {
      await mkdir(stage, { recursive: true, mode: 0o700 });
      phase = '模型配置 / model configuration';
      const models = new ProductModelConfigStore(join(stage, 'config', 'models.json'));
      await models.write(payload.models);
      phase = '子代理配置 / child agent configuration';
      await writeJson(join(stage, 'config', 'subagents.json'), decodeProductSubagentConfig(payload.subagents));
      if (payload.network) await writeJson(join(stage, 'config', 'network.json'), payload.network);
      if (payload.sandbox) await writeJson(join(stage, 'config', 'sandbox.json'), payload.sandbox);
      await writeFile(join(stage, 'AGENTS.md'), payload.instructions, { mode: 0o600 });
      const replacing = paths.filter(path => !(path === 'config/network.json' && !payload.network || path === 'config/sandbox.json' && !payload.sandbox));
      const trackedPaths = replacing.filter(path => path !== 'shared-configuration/current.json');
      const receipt = { digest, warnings, sourceId: payload.sourceId, trackedPaths, platform: this.host.platform, hostFingerprint: this.hostFingerprint() };
      await writeJson(join(stage, 'shared-configuration', 'current.json'), receipt);
      phase = '配置文件替换 / configuration replacement';
      transaction = { id, entries: [] };
      for (const path of replacing) {
        const parent = dirname(join(this.root, path)); await mkdir(parent, { recursive: true });
        const actual = await realpath(parent), root = await realpath(this.root);
        if (actual !== root && !actual.startsWith(root + sep)) throw new Error('Configuration target escapes the Agent directory.');
        transaction.entries.push({ path, existed: await exists(join(this.root, path)) });
      }
      await writeJson(join(this.root, 'shared-configuration', 'transaction.json'), transaction);
      for (const entry of transaction.entries) {
        replacementPath = entry.path;
        const destination = join(this.root, entry.path), previous = join(backup, entry.path);
        await mkdir(dirname(previous), { recursive: true, mode: 0o700 });
        if (entry.existed && !await exists(previous)) await replaceFileWithRetry(destination, previous);
        await replaceFileWithRetry(join(stage, entry.path), destination);
      }
      phase = '配置应用 / configuration application';
      replacementPath = undefined;
      await this.refreshAndWait(secrets);
      await writeJson(join(this.root, 'shared-configuration', 'current.json'), { ...receipt, appliedFingerprint: await configurationFingerprint(this.root, trackedPaths) });
      await rm(join(this.root, 'shared-configuration', 'transaction.json'), { force: true });
      await pruneBackups(this.root).catch(() => undefined);
      return { digest, warnings };
    } catch (error) {
      const failedPhase = phase, failedPath = replacementPath;
      if (transaction && await exists(join(this.root, 'shared-configuration', 'transaction.json'))) {
        try {
          await rollback(this.root, transaction);
        } catch (recoveryError) {
          preserveStage = true;
          throw new Error('配置同步回滚未完成，已保留恢复记录和原配置备份 / Configuration recovery is pending; journal and backups retained.',
            { cause: new AggregateError([error, recoveryError]) });
        }
        const restored = await this.refreshAndWait(secrets).then(() => true, () => false);
        if (!restored) {
          const receiptPath = join(this.root, 'shared-configuration', 'current.json');
          if (await exists(receiptPath)) await writeJson(receiptPath, { ...JSON.parse(await readFile(receiptPath, 'utf8')), recoveryRequired: true });
        }
      }
      // Store validators can include supplied values. Do not return credentials in diagnostics.
      const code = (error as NodeJS.ErrnoException)?.code;
      // This is a validated managed relative path, not an arbitrary filesystem
      // exception message (which may contain command arguments or credentials).
      const fileDetail = failedPath ? '；' + failedPath : '';
      const codeDetail = typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? '；' + code : '';
      throw new Error(error instanceof SharedConfigurationError ? error.message + ' 新配置未提交；原配置文件已保留。'
        : '配置同步失败（' + failedPhase + fileDetail + codeDetail + '），未提交新配置。Shared configuration was not committed.', { cause: error });
    } finally { if (!preserveStage) await rm(stage, { recursive: true, force: true }); }
  }
}
