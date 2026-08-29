import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  BotConfigStore,
  BotSupervisor,
  ProductHost,
  ProductHostProtocolError,
  ProductModelConfigStore,
  LinkedConversationBackend,
  SessionLinkStore,
  WeixinAccountManager,
  WeixinAccountStore,
  WeixinApiClient,
  createDiscordAdapterFactory,
  createFeishuAdapterFactory,
  createTelegramAdapterFactory,
  createWeixinAdapterFactory,
  type ProductModelConfigSnapshot,
} from '@cardbush/product-host';
import type { ElectronRuntimeBridge } from '@cardbush/bush-runtime-electron';
import { ElectronRuntimeTransport } from '@cardbush/bush-runtime-electron';
import {
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  runtimeProviderBindingResultSchema,
} from '@cardbush/bush-protocol';

import {
  ProductRuntimeConversationBackend,
  type ProductRuntimeModelConfig,
} from './productRuntimeConversationBackend.mjs';

export interface ElectronProductHostControllerOptions {
  dataRoot: string;
  runtimeBridge: ElectronRuntimeBridge;
  fetch?: typeof globalThis.fetch;
}

export class ElectronProductHostController {
  readonly #config: BotConfigStore;
  readonly #models: ProductModelConfigStore;
  readonly #runtime: ElectronRuntimeTransport;
  readonly #bots: BotSupervisor;
  readonly #host: ProductHost;
  #model?: ProductRuntimeModelConfig;
  #startup?: Promise<void>;

  constructor(options: ElectronProductHostControllerOptions) {
    const dataRoot = resolve(options.dataRoot);
    const fetcher = options.fetch ?? globalThis.fetch;
    this.#runtime = new ElectronRuntimeTransport(options.runtimeBridge);
    this.#config = new BotConfigStore(join(dataRoot, 'config', 'bots.json'));
    this.#models = new ProductModelConfigStore(join(dataRoot, 'config', 'models.json'));
    const accountStore = new WeixinAccountStore(join(dataRoot, 'weixin'));
    const links = new SessionLinkStore(join(dataRoot, 'config', 'session-links.json'));
    const runtimeBackend = new ProductRuntimeConversationBackend({
      bridge: options.runtimeBridge,
      modelConfig: () => this.#model,
      policy: async (envelope) => {
        const config = await this.#config.read(platformFromEnvelope(envelope.platform));
        return {
          projectDir: optionalString(config.project_dir),
          permissionMode: optionalString(config.permission_mode) ?? 'task_free',
          disabledTools: strings(config.disabled_tools),
          allowedSkills: strings(config.allowed_skills),
          subagentEnabled: config.subagent_enabled !== false,
        };
      },
    });
    const backend = new LinkedConversationBackend(runtimeBackend, links);
    this.#bots = new BotSupervisor({
      configStore: this.#config,
      dataDir: join(dataRoot, 'bots'),
      adapterFactories: {
        discord: createDiscordAdapterFactory({ backend, fetch: fetcher }),
        feishu: createFeishuAdapterFactory({ backend }),
        telegram: createTelegramAdapterFactory({ backend, fetch: fetcher }),
        weixin: createWeixinAdapterFactory({
          backend,
          store: accountStore,
          createClient: (config) => new WeixinApiClient(config, fetcher),
        }),
      },
    });
    const weixin = new WeixinAccountManager({
      store: accountStore,
      config: () => this.#config.read('weixin'),
      createClient: (config) => new WeixinApiClient(config, fetcher),
    });
    this.#host = new ProductHost(this.#config, this.#bots, weixin, {
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
      issue: async (input) => ({
        ...(await links.issue(input)),
        platform: input.platform ?? '',
      }),
    });
  }

  execute(command: unknown): Promise<unknown> {
    return this.#host.execute(command);
  }

  async executeTool(request: { toolName: string; input: unknown }): Promise<unknown> {
    if (request.toolName !== 'transport_deliver') {
      throw new ProductHostProtocolError(
        'unknown_product_host_tool',
        `Unknown Product Host tool: ${request.toolName}`,
      );
    }
    const input = objectValue(request.input, 'transport_deliver input');
    const sessionId = requiredString(input.sessionId, 'sessionId');
    const platform = platformFromEnvelope(sessionId.split(':', 1)[0] ?? '');
    const requestedChannel = optionalString(input.channel);
    if (requestedChannel && requestedChannel !== platform) {
      throw new ProductHostProtocolError(
        'transport_channel_mismatch',
        `Requested channel ${requestedChannel} does not match Session ${platform}`,
      );
    }
    if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 6) {
      throw new ProductHostProtocolError(
        'invalid_transport_delivery',
        'paths must contain between 1 and 6 files',
      );
    }
    const paths: string[] = [];
    for (const value of input.paths) {
      const path = await realpath(requiredString(value, 'path'));
      if (!(await stat(path)).isFile()) {
        throw new ProductHostProtocolError('invalid_transport_delivery', `Not a file: ${path}`);
      }
      paths.push(path);
    }
    const delivered = await this.#bots.deliver(platform, {
      sessionId,
      paths: [...new Set(paths)],
      text: optionalString(input.text),
    });
    return {
      success: true,
      output: {
        protocol: 'cardbush.transport_delivery.v1',
        state: 'delivered',
        send_confirmed: true,
        ...delivered,
      },
      paths: delivered.delivered,
    };
  }

  async shutdown(): Promise<void> {
    await this.#bots.shutdown();
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
    if (this.#model && !this.#startup) {
      this.#startup = this.#bots.startup();
      await this.#startup;
    }
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

function platformFromEnvelope(value: string): 'weixin' | 'feishu' | 'telegram' | 'discord' {
  if (value === 'weixin' || value === 'feishu' || value === 'telegram' || value === 'discord') {
    return value;
  }
  throw new ProductHostProtocolError('unsupported_bot_platform', `Unsupported Bot platform: ${value}`);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductHostProtocolError('invalid_product_host_tool', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (!result) {
    throw new ProductHostProtocolError('invalid_product_model_config', `${field} is required`);
  }
  return result;
}

function optionalString(value: unknown): string | undefined {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || undefined;
}
