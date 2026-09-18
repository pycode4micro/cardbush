import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { clearDiagnosticFiles, mergeCleanup, type CleanupResult } from './cacheMaintenance.js';

import {
  CardbushAppsConfigStore,
  ProductHost,
  ProductHostProtocolError,
  ProductModelConfigStore,
  ProductMcpConfigStore,
  ProductSubagentConfigStore,
  type RuntimeAssetCategory,
} from '@cardbush/product-host';
import type { ElectronRuntimeBridge } from '@cardbush/bush-runtime-electron';
import { ElectronRuntimeTransport } from '@cardbush/bush-runtime-electron';
import { loadProductPluginCatalog, removeProductPlugin, withProductPluginLifecycle } from './productPlugins.js';
import { PluginConnectionManager } from './pluginConnectionManagement.mjs';
import type { McpCredentialStore } from '@cardbush/bush-mcp-client';
import type { ClientCredentialsPrompt, ClientCredentialsAnswer } from './pluginConnectionManagement.mjs';
import {
  assertUserMcpServerId,
  assertReconnectableMcpServerId,
  mergeMcpServer,
  mcpServerPatchSchema,
  publicMcpServer,
  type McpServerPatch,
} from './productMcpManagement.mjs';
import {
  CLEAR_RUNTIME_SESSIONS_COMMAND,
  COLLECT_RUNTIME_CACHE_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  SHUTDOWN_RUNTIME_COMMAND,
  runtimeProviderBindingResultSchema,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  BUSH_MCP_SNAPSHOT_PROTOCOL,
  mcpSnapshotSchema,
  mcpOAuthFromConfig,
  mcpSnapshotResultSchema,
} from '@cardbush/bush-protocol';

export interface ElectronProductHostControllerOptions {
  dataRoot: string;
  runtimeStateRoot: string;
  bundledSkillRoot: string;
  userSkillRoot: string;
  bundledPluginRoot: string;
  userPluginRoot: string;
  legacyModelConfigPaths?: string[];
  runtimeBridge: ElectronRuntimeBridge;
  credentials?: McpCredentialStore;
  requestClientCredentials?: (input: ClientCredentialsPrompt, signal: AbortSignal) => Promise<ClientCredentialsAnswer>;
  logRoots?: string[];
  clearApplicationCaches?: () => Promise<CleanupResult>;
  clearCrashReports?: () => Promise<CleanupResult>;
}

export class ElectronProductHostController {
  readonly #models: ProductModelConfigStore;
  readonly #apps: CardbushAppsConfigStore;
  readonly #userPluginRoot: string;
  readonly #mcp: ProductMcpConfigStore;
  readonly #subagents: ProductSubagentConfigStore;
  readonly #runtime: ElectronRuntimeTransport;
  readonly #runtimeStateRoot: string;
  readonly #bundledSkillRoot: string;
  readonly #userSkillRoot: string;
  readonly #legacyModelConfigPaths: string[];
  readonly #dataRoot: string;
  readonly #host: ProductHost;
  readonly #pluginConnections: PluginConnectionManager;
  #legacyCredentialMigration?: Promise<void>;
  readonly #logRoots: string[];
  readonly #clearApplicationCaches?: ElectronProductHostControllerOptions['clearApplicationCaches'];
  readonly #clearCrashReports?: ElectronProductHostControllerOptions['clearCrashReports'];

  constructor(options: ElectronProductHostControllerOptions) {
    const dataRoot = resolve(options.dataRoot);
    this.#dataRoot = dataRoot;
    this.#logRoots = [...new Set([...(options.logRoots ?? []), join(dataRoot, 'logs')].map(root => resolve(root)))];
    this.#clearApplicationCaches = options.clearApplicationCaches;
    this.#clearCrashReports = options.clearCrashReports;
    this.#userPluginRoot = resolve(options.userPluginRoot);
    this.#runtimeStateRoot = resolve(options.runtimeStateRoot);
    this.#bundledSkillRoot = resolve(options.bundledSkillRoot);
    this.#userSkillRoot = resolve(options.userSkillRoot);
    this.#legacyModelConfigPaths = [...new Set(
      (options.legacyModelConfigPaths ?? []).map((candidate) => resolve(candidate)),
    )];
    this.#runtime = new ElectronRuntimeTransport(options.runtimeBridge);
    this.#models = new ProductModelConfigStore(join(dataRoot, 'config', 'models.json'));
    this.#apps = new CardbushAppsConfigStore(join(dataRoot, 'config', 'apps.json'), {
      loadCatalog: excludedIds => loadProductPluginCatalog([
        { path: options.bundledPluginRoot, source: 'bundled' },
        { path: options.userPluginRoot, source: 'user' },
      ], excludedIds),
    });
    this.#mcp = new ProductMcpConfigStore(join(dataRoot, 'config', 'mcp-servers.json'));
    this.#subagents = new ProductSubagentConfigStore(join(dataRoot, 'config', 'subagents.json'));
    this.#pluginConnections = new PluginConnectionManager({
      apps: this.#apps, mcp: this.#mcp, credentials: options.credentials,
      requestCredentials: options.requestClientCredentials,
      refresh: () => this.refreshMcp(),
      runtime: async () => {
        const state = objectValue(await this.listMcpServers(), 'MCP management state');
        return { runtime: state.runtime, ...(typeof state.runtimeError === 'string' ? { runtimeError: state.runtimeError } : {}) };
      },
    });
    this.#host = new ProductHost({
      get: async () => {
        const snapshot = await this.#models.read();
        return this.#models.publicPayload(snapshot);
      },
      update: async (config) => {
        const snapshot = await this.#models.write(config);
        return this.#models.publicPayload(snapshot);
      },
      resolve: (modelId) => this.#resolveModel(modelId),
    }, {
      clearConversations: () => this.#clearConversations(),
      clearLogsCache: () => this.#clearLogsCache(),
      clearCache: () => this.#clearCache(),
      runtimeAssetPlan: () => Promise.resolve(this.#runtimeAssetPlan()),
      resetRuntimeAssets: (categories) => this.#resetRuntimeAssets(categories),
      diagnostics: () => this.#diagnostics(),
    }, {
      get: async () => this.#apps.read(),
      update: async (config) => this.#apps.write(config),
    }, {
      get: async () => this.#mcp.read(),
      update: async (config) => {
        if (!Array.isArray(config.servers)) throw new Error('servers must be an array.');
        return this.#mcp.write({
          expectedRevision: config.expectedRevision,
          servers: config.servers.map((server) => mergeMcpServer(undefined, server)),
        });
      },
    }, {
      get: async () => this.#subagents.read(),
    });
  }

  async execute(command: unknown): Promise<unknown> {
    await this.#ensureLegacyModelCredentials();
    return this.#host.execute(command);
  }
  async resolveAutomationModel(modelId: string) {
    await this.#ensureLegacyModelCredentials();
    const config = await this.#models.read();
    if (!config.models.some(model => model.id === modelId)) throw new Error('The automation model was removed. Send a message in the target conversation with an available model.');
    return this.#resolveModel(modelId);
  }

  async subagentModels() {
    const config = await this.#models.read();
    return config.models.map(({ id, model, maxContextTokens, maxOutputTokens }) => ({ id, model, maxContextTokens, maxOutputTokens }));
  }

  async resolveSubagentModel(modelId: string) {
    await this.#ensureLegacyModelCredentials();
    return this.#resolveModel(modelId, 'The selected clean Agent model is not configured. Refresh list_subagent_options and select an available model.');
  }

  async refreshMcp(uninstallPluginId?: string): Promise<unknown> {
    const config = await this.#mcp.read();
    const snapshot = mcpSnapshotSchema.parse({
      protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
      snapshotId: 'cardbush-product-mcp',
      revision: config.revision,
      servers: config.servers.filter((server) => server.enabled === true).map((server) => ({
        id: server.id,
        transport: server.transport === 'stdio' ? {
          kind: 'stdio', command: server.command, args: server.args ?? [],
          ...(server.cwd ? { cwd: server.cwd } : {}), env: server.env ?? {},
        } : {
          kind: server.transport === 'http' ? 'streamable_http' : server.transport,
          url: server.url, headers: server.headers ?? {},
          oauth: mcpOAuthFromConfig(server.oauth),
          auth: server.auth === 'none' ? 'none' : 'oauth',
        },
        defaultToolPolicy: { permission: 'ask', parallelSafe: false, visibleToChild: true },
        toolPolicies: {},
      })),
    });
    return this.#runtime.sendCommand(uninstallPluginId
      ? { kind: 'runtime.prepare_plugin_uninstall', payload: { ...snapshot, uninstallPluginId } }
      : { kind: APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND, payload: snapshot });
  }

  async uninstallPlugin(pluginId: string) {
    return withProductPluginLifecycle(() => this.#apps.uninstall(pluginId, async (plugin, commit, otherPlugins) => {
      const state = mcpSnapshotResultSchema.parse(await this.refreshMcp(plugin.id));
      if (state.applicationState !== 'applied' || state.applicationError) {
        throw new Error(state.applicationError || '插件仍在使用中，请在当前任务结束后重试卸载。');
      }
      await this.#pluginConnections.clearPluginCredentials(plugin, otherPlugins);
      return removeProductPlugin(plugin, this.#userPluginRoot, [
        { root: join(dirname(this.#userPluginRoot), 'plugin-data'), name: plugin.id },
        { root: join(this.#runtimeStateRoot, 'plugin-data'), name: createHash('sha256').update(plugin.id).digest('hex').slice(0, 24) },
      ], commit);
    }));
  }

  async listMcpServers(): Promise<unknown> {
    const config = await this.#mcp.read();
    const configuration = { revision: config.revision, servers: config.servers.map(publicMcpServer) };
    try {
      const snapshot = await this.#runtime.sendCommand({ kind: GET_RUNTIME_MCP_SNAPSHOT_COMMAND, payload: {} });
      return { configuration, runtime: snapshot == null ? null : mcpSnapshotResultSchema.parse(snapshot) };
    } catch (error) {
      return { configuration, runtime: null, runtimeError: error instanceof Error ? error.message : String(error) };
    }
  }

  async configureMcpServer(input: McpServerPatch, signal?: AbortSignal): Promise<unknown> {
    const patch = mcpServerPatchSchema.parse(input);
    assertUserMcpServerId(patch.id);
    const config = await this.#mcp.updateServer(patch.id, (current) => {
      signal?.throwIfAborted();
      return mergeMcpServer(current, patch);
    });
    return this.#applyMcpConfiguration(config.revision);
  }

  listPluginConnections(pluginId?: string) { return this.#pluginConnections.list(pluginId); }
  pluginTroubleshootingContext(pluginId: string, componentId: string) { return this.#pluginConnections.troubleshootingContext(pluginId, componentId); }
  configurePluginConnection(input: unknown, signal?: AbortSignal) { return this.#pluginConnections.configure(input, signal); }
  savePluginConnections(input: unknown) { return this.#pluginConnections.save(input); }
  requestPluginCredentials(input: unknown, signal: AbortSignal) { return this.#pluginConnections.requestCredentials(input, signal); }

  async removeMcpServer(id: string, signal?: AbortSignal): Promise<unknown> {
    assertUserMcpServerId(id);
    const config = await this.#mcp.updateServer(id, () => {
      signal?.throwIfAborted();
      return undefined;
    });
    return this.#applyMcpConfiguration(config.revision);
  }

  async #applyMcpConfiguration(configurationRevision: number): Promise<unknown> {
    let applicationError: string | undefined;
    try {
      await this.refreshMcp();
    } catch (error) {
      applicationError = error instanceof Error ? error.message : String(error);
    }
    return {
      saved: true,
      configurationRevision,
      ...objectValue(await this.listMcpServers(), 'MCP management state'),
      ...(applicationError ? { applicationError } : {}),
    };
  }

  async shutdown(): Promise<void> {
    await Promise.race([
      this.#runtime.sendCommand({ kind: SHUTDOWN_RUNTIME_COMMAND, payload: {} }),
      new Promise((resolve) => setTimeout(resolve, 6_000)),
    ]).catch(() => undefined);
  }

  async #ensureLegacyModelCredentials(): Promise<void> {
    this.#legacyCredentialMigration ??= this.#migrateLegacyModelCredentials();
    await this.#legacyCredentialMigration;
  }

  async #migrateLegacyModelCredentials(): Promise<void> {
    for (const legacyPath of this.#legacyModelConfigPaths) {
      try {
        const payload = JSON.parse(await readFile(legacyPath, 'utf8')) as unknown;
        const imported = await this.#models.migrateMissingCredentials(payload);
        if (imported > 0) {
          console.info(
            `[product-host] imported ${imported} missing model credential(s) from legacy storage`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        console.warn(
          '[product-host] legacy model credential migration skipped:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async #clearConversations(): Promise<Record<string, unknown>> {
    return objectValue(await this.#runtime.sendCommand({ kind: CLEAR_RUNTIME_SESSIONS_COMMAND, payload: {} }), 'clear sessions result');
  }

  async #clearLogsCache(): Promise<Record<string, unknown>> {
    const results: CleanupResult[] = [];
    for (const root of this.#logRoots) {
      try { results.push(await clearDiagnosticFiles(root)); }
      catch (error) { results.push({ counts: {}, errors: [error instanceof Error ? error.message : String(error)] }); }
    }
    if (this.#clearCrashReports) results.push(await this.#clearCrashReports());
    const result = mergeCleanup(...results);
    return { target: 'logs-cache', cleared: result.counts.files! > 0, ...result };
  }

  async reconnectMcpServer(id: string, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    assertReconnectableMcpServerId(id);
    // Load any newly installed package/configuration before targeting the service.
    await this.refreshMcp();
    signal?.throwIfAborted();
    const snapshot = await this.#runtime.sendCommand({ kind: 'runtime.mcp_reconnect', payload: { serverId: id } }, signal);
    return { serverId: id, runtime: mcpSnapshotResultSchema.parse(snapshot) };
  }

  async #clearCache(): Promise<Record<string, unknown>> {
    // The runtime performs the busy check before any host cache is changed.
    const runtime = await this.#runtime.sendCommand({ kind: COLLECT_RUNTIME_CACHE_COMMAND, payload: {} }) as CleanupResult;
    let application: CleanupResult = { counts: {}, errors: [] };
    try { application = await this.#clearApplicationCaches?.() ?? application; }
    catch (error) { application.errors.push(error instanceof Error ? error.message : String(error)); }
    const result = mergeCleanup(runtime, application);
    return { target: 'application-cache', cleared: Object.values(result.counts).some(count => count > 0), ...result };
  }

  #runtimeAssetPlan(): Record<string, unknown> {
    return {
      protocol: 'cardbush.runtime_asset_reset.v1',
      target: 'runtime-assets',
      categories: {
        prompts: { authority: 'typescript_runtime', reset_mode: 'compiled_defaults' },
        skills: {
          authority: 'product_host',
          source_path: this.#bundledSkillRoot,
          target_path: this.#userSkillRoot,
        },
      },
      requires_confirmation: true,
      requires_idle_runtime: true,
      destructive: true,
      removes_runtime_customizations: true,
      restart_required_after_change: false,
    };
  }

  async #resetRuntimeAssets(
    categories: RuntimeAssetCategory[],
  ): Promise<Record<string, unknown>> {
    const selected = [...new Set(categories)];
    let changed = false;
    const categoryResults: Record<string, unknown> = {};
    for (const category of selected) {
      if (category === 'skills') {
        const seed = await treeCounts(this.#bundledSkillRoot);
        if (seed.files === 0) {
          throw new ProductHostProtocolError(
            'runtime_asset_seed_unavailable',
            'The bundled Skill seed is unavailable; existing Product Skills were not changed.',
          );
        }
        const before = await treeCounts(this.#userSkillRoot);
        await replaceDirectoryFromSeed(this.#bundledSkillRoot, this.#userSkillRoot);
        const after = await treeCounts(this.#userSkillRoot);
        const skillChanged = before.files !== after.files ||
          before.bytes !== after.bytes || before.directories !== after.directories;
        changed ||= skillChanged;
        categoryResults.skills = {
          changed: skillChanged,
          files: after.files,
          bytes: after.bytes,
        };
      } else {
        // Prompt defaults are compiled into the Agent package.
        categoryResults[category] = { changed: false, reset_mode: 'compiled_or_product_policy' };
      }
    }
    return {
      protocol: 'cardbush.runtime_asset_reset.v1',
      target: 'runtime-assets',
      selected_categories: selected,
      changed,
      restart_required: false,
      categories: categoryResults,
    };
  }

  async #diagnostics(): Promise<Record<string, unknown>> {
    const [runtime, product] = await Promise.all([
      treeCounts(this.#runtimeStateRoot),
      treeCounts(this.#dataRoot),
    ]);
    const logFiles = (await Promise.all(this.#logRoots.map(root => recentFiles(root, 50)))).flat();
    return {
      protocol: 'cardbush.product_diagnostics.v1',
      chain: [{
        source: 'electron_runtime',
        root: this.#runtimeStateRoot,
        files: runtime.files,
        bytes: runtime.bytes,
      }],
      toolFailures: logFiles.map((file) => ({ source: 'product_host', file })),
      storage: {
        runtime,
        product,
      },
    };
  }

  async #resolveModel(modelId: string, missingModelMessage?: string): Promise<Record<string, unknown>> {
    const snapshot = await this.#models.read();
    const exact = snapshot.models.find((item) => item.id === modelId);
    if (!exact && missingModelMessage) throw new ProductHostProtocolError('product_model_not_configured', missingModelMessage);
    const selected = exact ?? snapshot.models.find((item) => item.id === snapshot.defaultModelId) ?? snapshot.models[0];
    if (!selected) {
      throw new ProductHostProtocolError(
        'product_model_not_configured',
        'No Product model is configured.',
      );
    }
    if (!selected.apiKey) {
      throw new ProductHostProtocolError(
        'product_model_credential_missing',
        `Model ${selected.id} has no provider credential.`,
      );
    }
    const configured = runtimeProviderBindingResultSchema.parse(
      await this.#runtime.sendCommand({
        kind: UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
        payload: {
          protocol: 'bush.provider_binding_config.v1',
          bindingId: selected.id,
          adapter: 'openai_responses',
          apiKey: selected.apiKey,
          baseURL: selected.baseURL,
          defaultHeaders: selected.defaultHeaders ?? {},
        },
      }),
    );
    if (configured.status !== 'configured' || !configured.binding) {
      throw new ProductHostProtocolError(
        'product_model_binding_failed',
        `Runtime rejected model ${selected.id}.`,
      );
    }
    return {
      protocol: 'cardbush.product_model_resolution.v1',
      modelId: selected.id,
      provider: selected.provider,
      model: selected.model,
      binding: configured.binding,
      maxContextTokens: selected.maxContextTokens,
      maxOutputTokens: selected.maxOutputTokens,
    };
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductHostProtocolError('invalid_product_host_tool', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}


interface TreeCounts {
  files: number;
  directories: number;
  bytes: number;
}

async function treeCounts(root: string): Promise<TreeCounts> {
  const counts: TreeCounts = { files: 0, directories: 0, bytes: 0 };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return counts;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      counts.directories += 1;
      const child = await treeCounts(path);
      counts.files += child.files;
      counts.directories += child.directories;
      counts.bytes += child.bytes;
    } else if (entry.isFile()) {
      counts.files += 1;
      counts.bytes += (await stat(path)).size;
    }
  }
  return counts;
}

async function replaceDirectoryFromSeed(source: string, target: string): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${target.split(/[\\/]/).at(-1)}.${process.pid}.tmp`);
  const backup = join(parent, `.${target.split(/[\\/]/).at(-1)}.${process.pid}.bak`);
  await rm(temporary, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    if ((await stat(source)).isDirectory()) {
      await cp(source, temporary, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let movedExisting = false;
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (movedExisting) await rename(backup, target).catch(() => undefined);
    throw error;
  }
  if (movedExisting) await rm(backup, { recursive: true, force: true });
}

async function recentFiles(root: string, limit: number): Promise<string[]> {
  const files: Array<{ path: string; time: number }> = [];
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path);
      else if (entry.isFile()) files.push({ path, time: (await stat(path)).mtimeMs });
    }
  }
  await visit(root);
  return files.sort((left, right) => right.time - left.time).slice(0, limit).map((item) => item.path);
}
