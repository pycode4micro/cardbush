import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
  GET_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  decodeRuntimeEvent,
  runtimeProviderBindingResultSchema,
  sessionSnapshotSchema,
  toolCatalogEntrySchema,
  type RuntimeEvent,
  type RuntimeProviderBindingConfig,
  type RuntimeSessionTurnRequest,
  type ToolCatalogEntry,
} from '@cardbush/bush-protocol';
import {
  createProductAgentTurnRequest,
} from '@cardbush/bush-product-agent';
import type {
  BotPermissionRequest,
  ChatEnvelope,
  ChatReply,
  ConversationBackend,
} from '@cardbush/product-host';
import {
  ElectronRuntimeTransport,
  type ElectronRuntimeBridge,
} from '@cardbush/bush-runtime-electron';

export interface ProductRuntimeModelConfig {
  bindingId: string;
  provider: string;
  model: string;
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  maxOutputTokens?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface ProductRuntimeBotPolicy {
  projectDir?: string;
  permissionMode: string;
  disabledTools: string[];
  allowedSkills: string[];
  subagentEnabled: boolean;
}

export interface ProductRuntimeConversationBackendOptions {
  bridge: ElectronRuntimeBridge;
  modelConfig: () => ProductRuntimeModelConfig | undefined;
  policy: (envelope: ChatEnvelope) => ProductRuntimeBotPolicy | Promise<ProductRuntimeBotPolicy>;
  createId?: (prefix: string) => string;
  localDate?: () => string;
}

interface PendingPermission {
  sessionId: string;
  request: BotPermissionRequest;
}

export class ProductRuntimeConversationBackend implements ConversationBackend {
  readonly #transport: ElectronRuntimeTransport;
  readonly #modelConfig: ProductRuntimeConversationBackendOptions['modelConfig'];
  readonly #policy: ProductRuntimeConversationBackendOptions['policy'];
  readonly #createId: (prefix: string) => string;
  readonly #localDate: () => string;
  readonly #active = new Set<string>();
  readonly #pending = new Map<string, PendingPermission>();

  constructor(options: ProductRuntimeConversationBackendOptions) {
    this.#createId = options.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    this.#transport = new ElectronRuntimeTransport(options.bridge, {
      createId: () => this.#createId('operation'),
    });
    this.#modelConfig = options.modelConfig;
    this.#policy = options.policy;
    this.#localDate = options.localDate ?? (() => new Date().toLocaleDateString('en-CA'));
  }

  async respond(
    envelope: ChatEnvelope,
    options: {
      signal?: AbortSignal;
      onPermissionRequest?: (request: BotPermissionRequest) => void | Promise<void>;
    } = {},
  ): Promise<ChatReply> {
    const pending = this.#pending.get(envelope.sessionId);
    if (pending) return this.#answerPending(pending, envelope.text, options.signal);
    if (this.#active.has(envelope.sessionId)) {
      throw new ProductRuntimeConversationError(
        'session_turn_active',
        'This conversation already has an active Agent Turn.',
      );
    }
    const model = this.#modelConfig();
    if (!model?.apiKey.trim() || !model.model.trim()) {
      throw new ProductRuntimeConversationError(
        'model_not_configured',
        'CardBush has no usable default model configuration.',
      );
    }
    this.#active.add(envelope.sessionId);
    try {
      const providerBinding = await this.#configureProvider(model, options.signal);
      const policy = await this.#policy(envelope);
      const catalog = await this.#toolCatalog(options.signal);
      const disabled = new Set(policy.disabledTools);
      const request = createProductAgentTurnRequest({
        requestId: this.#createId('request'),
        sessionId: envelope.sessionId,
        turnId: this.#createId('turn'),
        messageId: envelope.messageId || this.#createId('message'),
        createdAt: new Date().toISOString(),
        localDate: this.#localDate(),
        userText: envelope.text,
        userMessageName: `${envelope.platform}_bot_user`,
        model: model.model,
        providerBinding,
        tools: catalog.filter((entry) =>
          !disabled.has(entry.definition.name) &&
          (policy.subagentEnabled || entry.manifest.operation !== 'agent.delegate'),
        ).map((entry) => entry.definition),
        projectDir: policy.projectDir,
        permissionMode: policy.permissionMode,
        allowedSkills: policy.allowedSkills,
        planEnabled: true,
        maxOutputTokens: model.maxOutputTokens,
        reasoningEffort: model.reasoningEffort,
        sessionMetadata: {
          title: `${envelope.platform}:${envelope.channelId}:${envelope.userId}`,
          source: 'cardbush_product_bot',
          platform: envelope.platform,
          channelId: envelope.channelId,
          userId: envelope.userId,
          ...(policy.projectDir ? { projectDir: policy.projectDir } : {}),
        },
      });
      return await this.#run(request, options);
    } finally {
      this.#active.delete(envelope.sessionId);
    }
  }

  async #run(
    request: RuntimeSessionTurnRequest,
    options: {
      signal?: AbortSignal;
      onPermissionRequest?: (request: BotPermissionRequest) => void | Promise<void>;
    },
  ): Promise<ChatReply> {
    let assistantContent = '';
    let terminal: Extract<RuntimeEvent, { kind: 'turn_terminal' }> | undefined;
    const consume = (async () => {
      for await (const candidate of this.#transport.openEventStream({
        sessionId: request.sessionId,
        turnId: request.turnId,
        signal: options.signal,
      })) {
        const event = decodeRuntimeEvent(candidate);
        if (event.kind === 'assistant_segment_completed') {
          assistantContent = event.payload.content;
        } else if (event.kind === 'permission_requested') {
          const permission: BotPermissionRequest = {
            permissionId: event.payload.permissionId,
            reason: event.payload.reason,
            actions: event.payload.actions,
            resources: event.payload.resources,
            requestedCapabilityIds: event.payload.requestedCapabilityIds,
          };
          this.#pending.set(event.sessionId, { sessionId: event.sessionId, request: permission });
          await options.onPermissionRequest?.(permission);
        } else if (
          event.kind === 'permission_answered' ||
          event.kind === 'permission_rejected' ||
          event.kind === 'permission_cancelled' ||
          event.kind === 'permission_expired'
        ) {
          this.#pending.delete(event.sessionId);
        } else if (event.kind === 'turn_terminal') {
          terminal = event;
        }
      }
    })();
    const command = this.#transport.sendCommand({
      kind: RUN_RUNTIME_SESSION_TURN_COMMAND,
      payload: request,
    }, options.signal);
    const [streamResult, commandResult] = await Promise.allSettled([consume, command]);
    if (streamResult.status === 'rejected') throw streamResult.reason;
    if (commandResult.status === 'rejected' && !terminal) throw commandResult.reason;
    terminal ??= decodeRuntimeEvent(commandResult.status === 'fulfilled' ? commandResult.value : {} as never) as Extract<RuntimeEvent, { kind: 'turn_terminal' }>;
    if (!terminal || terminal.kind !== 'turn_terminal') {
      throw new ProductRuntimeConversationError('turn_terminal_missing', 'Agent Turn returned no terminal fact.');
    }
    this.#pending.delete(request.sessionId);
    if (!assistantContent && terminal.payload.finalMessageId) {
      const session = sessionSnapshotSchema.nullable().parse(await this.#transport.sendCommand({
        kind: GET_RUNTIME_SESSION_COMMAND,
        payload: { sessionId: request.sessionId },
      }, options.signal));
      const message = session?.turns.flatMap((turn) => turn.messages).find(
        (item) => item.messageId === terminal?.payload.finalMessageId,
      );
      if (message?.message.role === 'assistant') assistantContent = message.message.content;
    }
    if (!assistantContent) {
      throw new ProductRuntimeConversationError(
        'assistant_response_missing',
        `Agent Turn ended with ${terminal.payload.status} but no assistant response.`,
      );
    }
    return {
      text: assistantContent,
      metadata: { turnId: request.turnId, terminal: terminal.payload },
    };
  }

  async #configureProvider(model: ProductRuntimeModelConfig, signal?: AbortSignal) {
    const config: RuntimeProviderBindingConfig = {
      protocol: 'bush.provider_binding_config.v1',
      bindingId: model.bindingId,
      adapter: 'openai_compatible',
      apiKey: model.apiKey,
      baseURL: model.baseURL,
      defaultHeaders: model.defaultHeaders ?? {},
    };
    const result = runtimeProviderBindingResultSchema.parse(await this.#transport.sendCommand({
      kind: UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
      payload: config,
    }, signal));
    if (result.status !== 'configured' || !result.binding) {
      throw new ProductRuntimeConversationError('provider_not_configured', 'Runtime rejected the provider binding.');
    }
    return result.binding;
  }

  async #toolCatalog(signal?: AbortSignal): Promise<ToolCatalogEntry[]> {
    return toolCatalogEntrySchema.array().parse(await this.#transport.sendCommand({
      kind: GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
      payload: {},
    }, signal));
  }

  async #answerPending(
    pending: PendingPermission,
    source: string,
    signal?: AbortSignal,
  ): Promise<ChatReply> {
    const normalized = source.trim().toLowerCase();
    const decision = permissionDecision(normalized);
    if (!decision) {
      return {
        text: '该会话正在等待权限选择。回复 1 仅本次允许，2 本会话允许，3 拒绝。',
        metadata: { interactionPending: true },
      };
    }
    const answerId = this.#createId('answer');
    await this.#transport.sendCommand({
      kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
      payload: {
        protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
        permissionId: pending.request.permissionId,
        answerId,
        decision,
        grantedCapabilityIds: decision === 'deny'
          ? []
          : pending.request.requestedCapabilityIds,
      },
    }, signal);
    this.#pending.delete(pending.sessionId);
    return {
      text: decision === 'deny' ? '已拒绝本次权限请求。' : '已提交权限授权，原任务将继续执行。',
      metadata: { permissionId: pending.request.permissionId, answerId, decision },
    };
  }
}

export class ProductRuntimeConversationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ProductRuntimeConversationError';
  }
}

function permissionDecision(value: string): 'allow_once' | 'allow_session' | 'deny' | undefined {
  if (value === '1' || value === 'allow_once') return 'allow_once';
  if (value === '2' || value === 'allow_session') return 'allow_session';
  if (value === '3' || value === 'deny') return 'deny';
  return undefined;
}
