import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_RUNTIME_ERROR_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  SHUTDOWN_RUNTIME_COMMAND,
  REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcInboundMessage,
  extractRuntimeIpcProtocol,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingIdentitySchema,
  runtimeIpcOutboundMessageSchema,
  type ModelEvent,
  type ModelRequest,
  type RuntimeIpcOutboundMessage,
  type RuntimeProtocolError,
} from '@cardbush/bush-protocol';
import {
  FileRuntimeCheckpointStore,
  FileRuntimeEventPersistence,
  FileCoordinationPersistence,
  FileSessionEventPersistence,
  FileSubagentTaskPersistence,
  FileToolExecutionPersistence,
  InMemoryRuntimeEventLog,
  InMemoryRuntimeHost,
  CoordinationStore,
  SessionStore,
  registerSkillTools,
  SubagentTaskStore,
  ToolExecutionStore,
  ToolRegistry,
  type ModelProvider,
  type SubagentPermissionPolicy,
} from '@cardbush/bush-runtime';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import {
  decodeProductSubagentConfig,
  defaultProductSubagentConfig,
} from '@cardbush/product-host';
import {
  FileProviderCapabilityStore,
  InMemoryProviderCapabilityStore,
  OpenAIResponsesProvider,
  OpenAIResponsesProviderRegistry,
  openAIResponsesCapabilityScope,
  type ProviderCapabilityStore,
} from '@cardbush/bush-provider-openai';
import {
  loadEnabledProductPluginSkillRoots,
  type PluginRoot,
} from './productPlugins.js';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The Runtime Host must run as an Electron Utility Process.');
}

const operations = new Map<string, AbortController>();
const subscriptions = new Map<string, AbortController>();
let host: InMemoryRuntimeHost;
let providers: OpenAIResponsesProviderRegistry;
let mcp: McpClientManager;

async function handleMessage(input: unknown) {
  let message;
  try {
    message = decodeRuntimeIpcInboundMessage(input);
  } catch (error) {
    const received = extractRuntimeIpcProtocol(input);
    post({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'protocol_error',
      error: received !== BUSH_RUNTIME_IPC_PROTOCOL
        ? createProtocolVersionMismatchError(received)
        : runtimeError('protocol', 'invalid_ipc_message', errorMessage(error)),
    });
    return;
  }

  switch (message.type) {
    case 'command': {
      if (operations.has(message.operationId)) {
        postCommandError(
          message.operationId,
          runtimeError(
            'protocol',
            'duplicate_operation_id',
            `Operation ${message.operationId} already exists.`,
            message.operationId,
          ),
        );
        return;
      }
      const controller = new AbortController();
      operations.set(message.operationId, controller);
      try {
        const result = await executeRuntimeCommand(
          message.command,
          controller.signal,
        );
        post({
          protocol: BUSH_RUNTIME_IPC_PROTOCOL,
          type: 'command_response',
          operationId: message.operationId,
          ok: true,
          result,
        });
      } catch (error) {
        postCommandError(
          message.operationId,
          runtimeErrorFromUnknown(error, message.operationId, controller.signal.aborted),
        );
      } finally {
        operations.delete(message.operationId);
      }
      return;
    }
    case 'cancel_operation':
      operations.get(message.operationId)?.abort();
      return;
    case 'start_stream': {
      if (subscriptions.has(message.subscriptionId)) {
        postStreamError(
          message.subscriptionId,
          runtimeError(
            'protocol',
            'duplicate_subscription_id',
            `Subscription ${message.subscriptionId} already exists.`,
          ),
        );
        return;
      }
      const controller = new AbortController();
      subscriptions.set(message.subscriptionId, controller);
      void streamEvents(message.subscriptionId, message.request, controller);
      return;
    }
    case 'stop_stream':
      subscriptions.get(message.subscriptionId)?.abort();
      subscriptions.delete(message.subscriptionId);
      return;
  }
}

async function streamEvents(
  subscriptionId: string,
  request: {
    sessionId: string;
    turnId: string;
    cursor?: { afterSequence?: number; lastEventId?: string };
  },
  controller: AbortController,
) {
  try {
    for await (const event of host.openEventStream({
      ...request,
      signal: controller.signal,
    })) {
      post({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: 'stream_frame',
        subscriptionId,
        frame: { kind: 'event', event },
      });
    }
    post({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'stream_frame',
      subscriptionId,
      frame: { kind: 'end' },
    });
  } catch (error) {
    postStreamError(
      subscriptionId,
      runtimeError('runtime', 'runtime_stream_failed', errorMessage(error)),
    );
  } finally {
    subscriptions.delete(subscriptionId);
  }
}

function createEnvironmentProvider(
  capabilityStore: ProviderCapabilityStore,
): ModelProvider | undefined {
  const apiKey = process.env.CARDBUSH_RUNTIME_PROVIDER_API_KEY?.trim();
  if (!apiKey) return undefined;
  const baseURL = process.env.CARDBUSH_RUNTIME_PROVIDER_BASE_URL?.trim() || undefined;
  const config = {
    apiKey,
    baseURL,
    timeoutMs: positiveInteger(
      process.env.CARDBUSH_RUNTIME_PROVIDER_TIMEOUT_MS,
      undefined,
    ),
  };
  return new OpenAIResponsesProvider({
    ...config,
    capabilityStore,
    capabilityScope: openAIResponsesCapabilityScope(config),
  });
}

async function executeRuntimeCommand(
  command: { kind: string; payload: unknown },
  signal: AbortSignal,
) {
  if (command.kind === SHUTDOWN_RUNTIME_COMMAND) {
    for (const controller of operations.values()) {
      if (controller.signal !== signal) controller.abort();
    }
    await host.sendCommand(command, signal);
    const deadline = Date.now() + 5_000;
    while (host.hasActiveTurns() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await mcp.close();
    return { accepted: true, drained: !host.hasActiveTurns() };
  }
  if (command.kind === UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.upsert(runtimeProviderBindingConfigSchema.parse(command.payload));
  }
  if (command.kind === REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.remove(runtimeProviderBindingIdentitySchema.parse(command.payload));
  }
  if (command.kind === APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    return mcp.apply(withBundledAppsServer(command.payload));
  }
  if (command.kind === GET_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    return mcp.snapshot() ?? null;
  }
  return host.sendCommand(command, signal);
}

function withBundledAppsServer(input: unknown): unknown {
  const appsEntry = process.env.CARDBUSH_APPS_MCP_ENTRY?.trim();
  const chromeConnectorEntry = process.env.CARDBUSH_CHROME_CONNECTOR_MCP_ENTRY?.trim();
  const chromeRemoteDebuggingEntry = process.env.CARDBUSH_CHROME_REMOTE_DEBUGGING_MCP_ENTRY?.trim();
  if (!appsEntry && !chromeConnectorEntry && !chromeRemoteDebuggingEntry) return input;
  const snapshot = object(input, 'MCP snapshot must be an object.');
  const configured = Array.isArray(snapshot.servers) ? snapshot.servers : [];
  const reservedIds = new Set(['cardbush_apps', 'chrome_devtools']);
  const overridden = configured.find((candidate) =>
    candidate && typeof candidate === 'object' && reservedIds.has(String((candidate as { id?: unknown }).id ?? ''))
  );
  if (overridden && typeof overridden === 'object') {
    throw new Error(`${String((overridden as { id?: unknown }).id)} is a bundled MCP server id and cannot be overridden.`);
  }
  const appsConfigPath = process.env.CARDBUSH_APPS_CONFIG_PATH?.trim();
  const appsConfig = readBundledAppsConfig(appsConfigPath);
  const sourceRevision = Number(snapshot.revision);
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision <= 0) {
    throw new Error('MCP snapshot revision must be a positive integer.');
  }
  const revision = sourceRevision * 1_000_000 + appsConfig.revision;
  if (!appsConfig.serviceEnabled) return { ...snapshot, revision, servers: configured };
  const bundled = [];
  if (appsEntry) {
    bundled.push({
      id: 'cardbush_apps',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [appsEntry],
        env: runtimeChildEnvironment({
          ELECTRON_RUN_AS_NODE: '1',
          ...(appsConfigPath ? { CARDBUSH_APPS_CONFIG_PATH: appsConfigPath } : {}),
        }),
      },
      versionMode: 'auto',
      defaultToolPolicy: {
        permission: 'ask',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    });
  }
  const chromeEntry = appsConfig.chromeConnectionMode === 'remote_debugging'
    ? chromeRemoteDebuggingEntry
    : chromeConnectorEntry;
  if (chromeEntry && appsConfig.enabledPluginIds.has('chrome')) {
    const remoteDebugging = appsConfig.chromeConnectionMode === 'remote_debugging';
    bundled.push({
      id: 'chrome_devtools',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: remoteDebugging
          ? [
              chromeEntry,
              '--no-usage-statistics',
              '--no-performance-crux',
              // Advanced compatibility mode only. It never launches a
              // separate profile and only attaches to an opted-in Chrome.
              '--auto-connect',
            ]
          : [chromeEntry],
        env: runtimeChildEnvironment({
          ELECTRON_RUN_AS_NODE: '1',
          ...(remoteDebugging ? {
            CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
            CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          } : {
            CARDBUSH_CHROME_CONNECTOR_CONFIG:
              process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG?.trim() ?? '',
          }),
        }),
      },
      versionMode: 'auto',
      restartBackoffMs: 500,
      defaultToolPolicy: {
        // The connector extension enforces per-tab/per-site consent. Avoid a
        // duplicate CardBush permission prompt for every browser command.
        permission: remoteDebugging ? 'ask' : 'allow',
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    });
    console.error(JSON.stringify({
      type: 'runtime_chrome_connection',
      requestedMode: appsConfig.chromeConnectionMode,
      effectiveMode: appsConfig.chromeConnectionMode,
      reason: remoteDebugging ? 'advanced_remote_debugging' : 'extension_native_messaging',
    }));
  }
  return {
    ...snapshot,
    revision,
    servers: [...bundled, ...configured],
  };
}

function readBundledAppsConfig(path: string | undefined): {
  serviceEnabled: boolean;
  revision: number;
  enabledPluginIds: Set<string>;
  chromeConnectionMode: 'connector' | 'remote_debugging';
} {
  if (!path) {
    return {
      serviceEnabled: true,
      revision: 1,
      enabledPluginIds: new Set(),
      chromeConnectionMode: 'connector',
    };
  }
  if (!isAbsolute(path)) throw new Error('CARDBUSH_APPS_CONFIG_PATH must be absolute.');
  try {
    const value = object(JSON.parse(readFileSync(path, 'utf8')), 'Apps config must be an object.');
    if (typeof value.serviceEnabled !== 'boolean') {
      throw new Error('Apps config serviceEnabled must be a boolean.');
    }
    const revision = Number(value.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0 || revision >= 1_000_000) {
      throw new Error('Apps config revision must be a positive integer below 1000000.');
    }
    const plugins = Array.isArray(value.plugins) ? value.plugins : [];
    const enabledPluginIds = new Set(plugins.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const plugin = candidate as Record<string, unknown>;
      const id = String(plugin.id ?? '').trim().replaceAll('_', '-');
      return id && plugin.installed === true && plugin.enabled === true ? [id] : [];
    }));
    const chromePlugin = plugins.find((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
      return String((candidate as Record<string, unknown>).id ?? '').replaceAll('_', '-') === 'chrome';
    }) as Record<string, unknown> | undefined;
    const chromeConfig = chromePlugin?.config && typeof chromePlugin.config === 'object' &&
      !Array.isArray(chromePlugin.config)
      ? chromePlugin.config as Record<string, unknown>
      : {};
    const chromeConnectionMode = chromeConfig.connectionMode === 'remote_debugging'
      ? 'remote_debugging' as const
      : 'connector' as const;
    return {
      serviceEnabled: value.serviceEnabled,
      revision,
      enabledPluginIds,
      chromeConnectionMode,
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        serviceEnabled: true,
        revision: 1,
        enabledPluginIds: new Set(),
        chromeConnectionMode: 'connector',
      };
    }
    throw error;
  }
}

function runtimeChildEnvironment(extra: Record<string, string>): Record<string, string> {
  const inheritedKeys = [
    'APPDATA',
    'HOME',
    'LOCALAPPDATA',
    'PATH',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SystemRoot',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ];
  const inherited = Object.fromEntries(inheritedKeys.flatMap((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value ? [[key, value]] : [];
  }));
  return { ...inherited, ...extra };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function readSubagentPermissionPolicy(path: string | undefined): SubagentPermissionPolicy {
  const fallback = defaultProductSubagentConfig();
  if (!path) return {
    permissionRouting: fallback.permissionRouting,
    childPermissionMode: fallback.childPermissionMode,
    model: { mode: 'inherit' },
    disabledTools: fallback.disabledTools,
  };
  if (!isAbsolute(path)) throw new Error('CARDBUSH_SUBAGENT_CONFIG_PATH must be absolute.');
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(fallback, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      return {
        permissionRouting: fallback.permissionRouting,
        childPermissionMode: fallback.childPermissionMode,
        model: { mode: 'inherit' },
        disabledTools: fallback.disabledTools,
      };
    }
    throw error;
  }
  const config = decodeProductSubagentConfig(payload);
  if (JSON.stringify(payload) !== JSON.stringify(config)) {
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  if (config.permissionRouting === 'parent' && config.childPermissionMode !== 'task_free') {
    process.stderr.write(`${JSON.stringify({
      code: 'subagent_elevated_permission_mode',
      message: `Subagent childPermissionMode is ${config.childPermissionMode}; child Agents may operate beyond project-scoped task_free boundaries.`,
    })}\n`);
  }
  return {
    permissionRouting: config.permissionRouting,
    childPermissionMode: config.childPermissionMode,
    model: { mode: 'inherit' },
    disabledTools: config.disabledTools,
  };
}

const runtimeStateRoot = process.env.CARDBUSH_RUNTIME_STATE_ROOT?.trim();
if (runtimeStateRoot && !isAbsolute(runtimeStateRoot)) {
  throw new Error('CARDBUSH_RUNTIME_STATE_ROOT must be an absolute path.');
}
const subagentPermissionPolicy = readSubagentPermissionPolicy(
  process.env.CARDBUSH_SUBAGENT_CONFIG_PATH?.trim(),
);
const eventLog = runtimeStateRoot
  ? new InMemoryRuntimeEventLog({
      persistence: new FileRuntimeEventPersistence({
        root: join(runtimeStateRoot, 'events'),
        onRecoveryIssue: (issue) => {
          process.stderr.write(`${JSON.stringify(issue)}\n`);
        },
      }),
    })
  : undefined;
const checkpointStore = runtimeStateRoot
  ? new FileRuntimeCheckpointStore(join(runtimeStateRoot, 'checkpoints'))
  : undefined;
const sessionPersistence = runtimeStateRoot
  ? new FileSessionEventPersistence({
      root: join(runtimeStateRoot, 'sessions'),
      onRecoveryIssue: (issue) => {
        process.stderr.write(`${JSON.stringify(issue)}\n`);
      },
    })
  : undefined;
const toolExecutionPersistence = runtimeStateRoot
  ? new FileToolExecutionPersistence({
      root: join(runtimeStateRoot, 'tool-executions'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;
const coordinationPersistence = runtimeStateRoot
  ? new FileCoordinationPersistence({
      root: join(runtimeStateRoot, 'coordination'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;
const subagentPersistence = runtimeStateRoot
  ? new FileSubagentTaskPersistence({
      root: join(runtimeStateRoot, 'subagents'),
      onTruncatedTail: (issue) => {
        process.stderr.write(`${JSON.stringify({ code: 'truncated_tail_removed', ...issue })}\n`);
      },
    })
  : undefined;

const providerCapabilityStore = runtimeStateRoot
  ? new FileProviderCapabilityStore(join(runtimeStateRoot, 'provider-capabilities.json'))
  : new InMemoryProviderCapabilityStore();
providers = new OpenAIResponsesProviderRegistry({
  fallbackProvider: createEnvironmentProvider(providerCapabilityStore),
  capabilityStore: providerCapabilityStore,
});

const toolRegistry = new ToolRegistry();
const skillRoots = skillRootsFromEnvironment();
const pluginRoots = pluginRootsFromEnvironment();
if (skillRoots.length > 0 || pluginRoots.length > 0) {
  registerSkillTools(toolRegistry, async () => {
    try {
      const activePluginRoots = await loadEnabledProductPluginSkillRoots(
        pluginRoots,
        process.env.CARDBUSH_APPS_CONFIG_PATH?.trim() ?? '',
      );
      return [
        ...skillRoots.slice(0, 1),
        ...activePluginRoots,
        ...skillRoots.slice(1),
      ];
    } catch (error) {
      process.stderr.write(`${JSON.stringify({
        code: 'runtime_plugin_skill_discovery_failed',
        message: error instanceof Error ? error.message : String(error),
      })}\n`);
      return skillRoots;
    }
  });
}

host = new InMemoryRuntimeHost({
  provider: providers,
  toolRegistry,
  dataRoot: runtimeStateRoot,
  eventLog,
  checkpointStore,
  sessionStore: new SessionStore({ persistence: sessionPersistence }),
  toolExecutionStore: new ToolExecutionStore({
    persistence: toolExecutionPersistence,
  }),
  coordinationStore: new CoordinationStore({
    persistence: coordinationPersistence,
  }),
  subagentTaskStore: new SubagentTaskStore({
    persistence: subagentPersistence,
  }),
  durableRecovery: Boolean(runtimeStateRoot),
  durableSessions: Boolean(runtimeStateRoot),
  durableCoordination: Boolean(runtimeStateRoot),
  durableSubagentTasks: Boolean(runtimeStateRoot),
  subagentPermissionPolicy,
  settleOrphanedTurns: Boolean(runtimeStateRoot),
  additionalSupportedCommands: [
    UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
    REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
    APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
    GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  ],
  additionalFeatures: [
    "product_mcp_snapshot",
    "mcp_protocol_2",
    "bundled_cardbush_apps_mcp",
    "native_image_inputs",
  ],
  hostId: `electron-utility-${process.pid}`,
  runtimeVersion: '0.1.0',
  maxAttempts: positiveInteger(
    process.env.CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS,
    5,
  ),
  onRecoveryError: (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: 'runtime_checkpoint_cleanup_failed', message: error.message })}\n`,
    );
  },
});
mcp = new McpClientManager({
  registry: toolRegistry,
  canApply: () => !host.hasActiveTurns(),
  onServiceStateChange: (state) => {
    process.stderr.write(`${JSON.stringify({
      code: 'runtime_mcp_service_state',
      ...state,
    })}\n`);
  },
  onServerStderr: (entry) => {
    process.stderr.write(`${JSON.stringify({
      code: 'runtime_mcp_stderr',
      ...entry,
    })}\n`);
  },
});

function skillRootsFromEnvironment(): string[] {
  const raw = process.env.CARDBUSH_RUNTIME_SKILL_ROOTS?.trim();
  if (!raw) return [];
  let roots: unknown;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('CARDBUSH_RUNTIME_SKILL_ROOTS must be a JSON array.');
  }
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== 'string' || !isAbsolute(root))) {
    throw new Error('Every Runtime Skill root must be an absolute path.');
  }
  return roots;
}

function pluginRootsFromEnvironment(): PluginRoot[] {
  const raw = process.env.CARDBUSH_RUNTIME_PLUGIN_ROOTS?.trim();
  if (!raw) return [];
  let roots: unknown;
  try {
    roots = JSON.parse(raw);
  } catch {
    throw new Error('CARDBUSH_RUNTIME_PLUGIN_ROOTS must be a JSON array.');
  }
  if (!Array.isArray(roots)) {
    throw new Error('CARDBUSH_RUNTIME_PLUGIN_ROOTS must be a JSON array.');
  }
  return roots.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('Every Runtime plugin root must be an object.');
    }
    const root = candidate as Record<string, unknown>;
    if (typeof root.path !== 'string' || !isAbsolute(root.path) ||
        (root.source !== 'bundled' && root.source !== 'user')) {
      throw new Error('Every Runtime plugin root must have an absolute path and valid source.');
    }
    return { path: root.path, source: root.source };
  });
}

parentPort.on('message', (messageEvent) => {
  void handleMessage(messageEvent.data);
});

post({
  protocol: BUSH_RUNTIME_IPC_PROTOCOL,
  type: 'ready',
  capabilities: host.capabilities(),
});

function post(message: RuntimeIpcOutboundMessage) {
  parentPort.postMessage(runtimeIpcOutboundMessageSchema.parse(message));
}

function postCommandError(operationId: string, error: RuntimeProtocolError) {
  post({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'command_response',
    operationId,
    ok: false,
    error,
  });
}

function postStreamError(subscriptionId: string, error: RuntimeProtocolError) {
  post({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'stream_frame',
    subscriptionId,
    frame: { kind: 'error', error },
  });
}

function runtimeError(
  kind: RuntimeProtocolError['kind'],
  code: string,
  message: string,
  requestId?: string,
): RuntimeProtocolError {
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    kind,
    code,
    message,
    retryable: false,
    details: {},
    requestId,
  };
}

function runtimeErrorFromUnknown(
  error: unknown,
  requestId?: string,
  cancelled = false,
): RuntimeProtocolError {
  if (cancelled) {
    return runtimeError('cancelled', 'operation_cancelled', errorMessage(error), requestId);
  }
  const value = error && typeof error === 'object'
    ? error as Record<string, unknown>
    : {};
  const code = typeof value.code === 'string' && value.code.trim()
    ? value.code.trim()
    : 'runtime_command_failed';
  const details = value.details && typeof value.details === 'object' && !Array.isArray(value.details)
    ? value.details as Record<string, unknown>
    : {};
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    kind: value.kind === 'protocol' || value.kind === 'transport' ||
      value.kind === 'runtime' || value.kind === 'cancelled'
      ? value.kind
      : 'runtime',
    code,
    message: errorMessage(error),
    retryable: value.retryable === true,
    details,
    requestId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(
  input: string | undefined,
  fallback: number,
): number;
function positiveInteger(
  input: string | undefined,
  fallback: undefined,
): number | undefined;
function positiveInteger(
  input: string | undefined,
  fallback: number | undefined,
): number | undefined {
  const value = Number(input);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
