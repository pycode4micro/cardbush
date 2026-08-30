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
} from '@cardbush/bush-runtime';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderRegistry,
} from '@cardbush/bush-provider-openai';
import { isAbsolute, join } from 'node:path';
import { readFileSync } from 'node:fs';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The Runtime Host must run as an Electron Utility Process.');
}

const operations = new Map<string, AbortController>();
const subscriptions = new Map<string, AbortController>();
let host: InMemoryRuntimeHost;
let providers: OpenAICompatibleProviderRegistry;
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
        : runtimeError('invalid_ipc_message', errorMessage(error)),
    });
    return;
  }

  switch (message.type) {
    case 'command': {
      if (operations.has(message.operationId)) {
        postCommandError(
          message.operationId,
          runtimeError(
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
          runtimeError(
            controller.signal.aborted ? 'operation_cancelled' : 'runtime_command_failed',
            errorMessage(error),
            message.operationId,
          ),
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
      runtimeError('runtime_stream_failed', errorMessage(error)),
    );
  } finally {
    subscriptions.delete(subscriptionId);
  }
}

function createEnvironmentProvider(): ModelProvider | undefined {
  const apiKey = process.env.CARDBUSH_RUNTIME_PROVIDER_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new OpenAICompatibleProvider({
    apiKey,
    baseURL: process.env.CARDBUSH_RUNTIME_PROVIDER_BASE_URL?.trim() || undefined,
    timeoutMs: positiveInteger(
      process.env.CARDBUSH_RUNTIME_PROVIDER_TIMEOUT_MS,
      undefined,
    ),
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
  const chromeEntry = process.env.CARDBUSH_CHROME_MCP_ENTRY?.trim();
  if (!appsEntry && !chromeEntry) return input;
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
  if (chromeEntry && appsConfig.enabledPluginIds.has('chrome')) {
    bundled.push({
      id: 'chrome_devtools',
      transport: {
        kind: 'stdio',
        command: process.execPath,
        args: [
          chromeEntry,
          '--no-usage-statistics',
          '--no-performance-crux',
        ],
        env: runtimeChildEnvironment({
          ELECTRON_RUN_AS_NODE: '1',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
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
} {
  if (!path) return { serviceEnabled: true, revision: 1, enabledPluginIds: new Set() };
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
    return { serviceEnabled: value.serviceEnabled, revision, enabledPluginIds };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { serviceEnabled: true, revision: 1, enabledPluginIds: new Set() };
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

const runtimeStateRoot = process.env.CARDBUSH_RUNTIME_STATE_ROOT?.trim();
if (runtimeStateRoot && !isAbsolute(runtimeStateRoot)) {
  throw new Error('CARDBUSH_RUNTIME_STATE_ROOT must be an absolute path.');
}
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

providers = new OpenAICompatibleProviderRegistry({
  fallbackProvider: createEnvironmentProvider(),
});

const toolRegistry = new ToolRegistry();
const skillRoots = skillRootsFromEnvironment();
if (skillRoots.length > 0) registerSkillTools(toolRegistry, skillRoots);
host = new InMemoryRuntimeHost({
  provider: providers,
  toolRegistry,
  dataRoot: runtimeStateRoot,
  skillRoots,
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
  code: string,
  message: string,
  requestId?: string,
): RuntimeProtocolError {
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    code,
    message,
    retryable: false,
    details: {},
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
