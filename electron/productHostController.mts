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

import {
  CardbushAppsConfigStore,
  ProductHost,
  ProductHostProtocolError,
  ProductModelConfigStore,
  ProductMcpConfigStore,
  ProductSubagentConfigStore,
  type ProductModelConfigSnapshot,
  type RuntimeAssetCategory,
} from '@cardbush/product-host';
import type { ElectronRuntimeBridge } from '@cardbush/bush-runtime-electron';
import { ElectronRuntimeTransport } from '@cardbush/bush-runtime-electron';
import { loadProductPluginCatalog } from './productPlugins.js';
import {
  DELETE_RUNTIME_SESSION_COMMAND,
  LIST_RUNTIME_SESSIONS_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  SHUTDOWN_RUNTIME_COMMAND,
  runtimeProviderBindingResultSchema,
  runtimeSessionIdentitySchema,
  runtimeSessionListRequestSchema,
  sessionSnapshotSchema,
} from '@cardbush/bush-protocol';

interface ProductRuntimeModelConfig {
  bindingId: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  maxOutputTokens?: number;
}

export interface ElectronProductHostControllerOptions {
  dataRoot: string;
  runtimeStateRoot: string;
  bundledSkillRoot: string;
  userSkillRoot: string;
  bundledPluginRoot: string;
  userPluginRoot: string;
  legacyModelConfigPaths?: string[];
  runtimeBridge: ElectronRuntimeBridge;
}

export class ElectronProductHostController {
  readonly #models: ProductModelConfigStore;
  readonly #apps: CardbushAppsConfigStore;
  readonly #mcp: ProductMcpConfigStore;
  readonly #subagents: ProductSubagentConfigStore;
  readonly #runtime: ElectronRuntimeTransport;
  readonly #runtimeStateRoot: string;
  readonly #bundledSkillRoot: string;
  readonly #userSkillRoot: string;
  readonly #legacyModelConfigPaths: string[];
  readonly #dataRoot: string;
  readonly #host: ProductHost;
  #model?: ProductRuntimeModelConfig;
  #startup?: Promise<void>;
  #legacyCredentialMigration?: Promise<void>;

  constructor(options: ElectronProductHostControllerOptions) {
    const dataRoot = resolve(options.dataRoot);
    this.#dataRoot = dataRoot;
    this.#runtimeStateRoot = resolve(options.runtimeStateRoot);
    this.#bundledSkillRoot = resolve(options.bundledSkillRoot);
    this.#userSkillRoot = resolve(options.userSkillRoot);
    this.#legacyModelConfigPaths = [...new Set(
      (options.legacyModelConfigPaths ?? []).map((candidate) => resolve(candidate)),
    )];
    this.#runtime = new ElectronRuntimeTransport(options.runtimeBridge);
    this.#models = new ProductModelConfigStore(join(dataRoot, 'config', 'models.json'));
    this.#apps = new CardbushAppsConfigStore(join(dataRoot, 'config', 'apps.json'), {
      loadCatalog: () => loadProductPluginCatalog([
        { path: options.bundledPluginRoot, source: 'bundled' },
        { path: options.userPluginRoot, source: 'user' },
      ]),
    });
    this.#mcp = new ProductMcpConfigStore(join(dataRoot, 'config', 'mcp-servers.json'));
    this.#subagents = new ProductSubagentConfigStore(join(dataRoot, 'config', 'subagents.json'));
    this.#host = new ProductHost({
      get: async () => {
        const snapshot = await this.#models.read();
        await this.#activateModels(snapshot);
        return this.#models.publicPayload(snapshot);
      },
      update: async (config) => {
        const snapshot = await this.#models.write(config);
        await this.#activateModels(snapshot);
        return this.#models.publicPayload(snapshot);
      },
      resolve: (modelId) => this.#resolveModel(modelId),
    }, {
      clearConversations: () => this.#clearConversations(),
      clearLogsCache: () => this.#clearLogsCache(),
      runtimeAssetPlan: () => Promise.resolve(this.#runtimeAssetPlan()),
      resetRuntimeAssets: (categories) => this.#resetRuntimeAssets(categories),
      diagnostics: () => this.#diagnostics(),
    }, {
      get: async () => this.#apps.read(),
      update: async (config) => this.#apps.write(config),
    }, {
      get: async () => this.#mcp.read(),
      update: async (config) => this.#mcp.write(config),
    }, {
      get: async () => this.#subagents.read(),
    });
  }

  async execute(command: unknown): Promise<unknown> {
    await this.#ensureLegacyModelCredentials();
    return this.#host.execute(command);
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
    const sessions = sessionSnapshotSchema.array().parse(
      await this.#runtime.sendCommand({
        kind: LIST_RUNTIME_SESSIONS_COMMAND,
        payload: runtimeSessionListRequestSchema.parse({}),
      }),
    );
    let deleted = 0;
    for (const session of sessions) {
      const result = objectValue(await this.#runtime.sendCommand({
        kind: DELETE_RUNTIME_SESSION_COMMAND,
        payload: runtimeSessionIdentitySchema.parse({ sessionId: session.sessionId }),
      }), 'delete session result');
      if (result.deleted === true) deleted += 1;
    }
    return {
      target: 'conversation-history',
      cleared: deleted > 0,
      counts: {
        sessions: deleted,
        turns: sessions.reduce((total, session) => total + session.turns.length, 0),
        messages: sessions.reduce(
          (total, session) => total + session.turns.reduce(
            (subtotal, turn) => subtotal + turn.messages.length,
            0,
          ),
          0,
        ),
      },
    };
  }

  async #clearLogsCache(): Promise<Record<string, unknown>> {
    const logsRoot = join(this.#dataRoot, 'logs');
    const counts = await treeCounts(logsRoot);
    await rm(logsRoot, { recursive: true, force: true });
    await mkdir(logsRoot, { recursive: true });
    return {
      target: 'logs-cache',
      cleared: counts.files > 0,
      counts: {
        log_files: counts.files,
        log_directories: counts.directories,
        log_bytes: counts.bytes,
      },
    };
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
        agent_profiles: {
          authority: 'product_configuration',
          reset_mode: 'bundled_defaults',
          target_path: 'product-host/agent-profiles',
        },
        teams: {
          authority: 'product_configuration',
          reset_mode: 'bundled_defaults',
          target_path: 'product-host/teams',
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
      } else if (category === 'agent_profiles' || category === 'teams') {
        // These categories are applied atomically by the renderer configuration adapter
        // after this authoritative, confirmed maintenance command succeeds.
        changed = true;
        categoryResults[category] = {
          changed: true,
          reset_mode: 'bundled_defaults',
          renderer_apply_required: true,
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
    const logFiles = await recentFiles(join(this.#dataRoot, 'logs'), 50);
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

  async #activateModels(snapshot: ProductModelConfigSnapshot): Promise<void> {
    const selected = snapshot.models.find((item) => item.id === snapshot.defaultModelId)
      ?? snapshot.models[0];
    this.#model = selected ? {
      bindingId: selected.id,
      provider: selected.provider,
      model: selected.model,
      apiKey: selected.apiKey,
      baseURL: selected.baseURL,
      defaultHeaders: selected.defaultHeaders,
      maxOutputTokens: selected.maxOutputTokens,
    } : undefined;
  }

  async #resolveModel(modelId: string): Promise<Record<string, unknown>> {
    const snapshot = await this.#models.read();
    const selected = snapshot.models.find((item) => item.id === modelId)
      ?? snapshot.models.find((item) => item.id === snapshot.defaultModelId)
      ?? snapshot.models[0];
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
          adapter: 'openai_compatible',
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
