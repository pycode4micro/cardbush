import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_RUNTIME_ERROR_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
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
import {
  registerProductHostTools,
  type ProductHostToolResponse,
} from './runtimeProductTools.mjs';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The Runtime Host must run as an Electron Utility Process.');
}

const operations = new Map<string, AbortController>();
const subscriptions = new Map<string, AbortController>();
const hostToolRequests = new Map<string, {
  resolve: (value: ProductHostToolResponse) => void;
  reject: (error: Error) => void;
}>();
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
    case 'host_tool_response': {
      const pending = hostToolRequests.get(message.requestId);
      if (!pending) return;
      hostToolRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result as ProductHostToolResponse);
      else pending.reject(new Error(message.error?.message ?? 'Product Host tool failed'));
      return;
    }
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
  if (command.kind === UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.upsert(runtimeProviderBindingConfigSchema.parse(command.payload));
  }
  if (command.kind === REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND) {
    return providers.remove(runtimeProviderBindingIdentitySchema.parse(command.payload));
  }
  if (command.kind === APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    return mcp.apply(command.payload);
  }
  if (command.kind === GET_RUNTIME_MCP_SNAPSHOT_COMMAND) {
    return mcp.snapshot() ?? null;
  }
  return host.sendCommand(command, signal);
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
registerProductHostTools(toolRegistry, invokeProductHostTool);
const skillRoots = skillRootsFromEnvironment();
if (skillRoots.length > 0) registerSkillTools(toolRegistry, skillRoots);
host = new InMemoryRuntimeHost({
  provider: providers,
  toolRegistry,
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
  requireOutcomeDeclaration: true,
  additionalSupportedCommands: [
    UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
    REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
    APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
    GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  ],
  additionalFeatures: [
    "product_mcp_snapshot",
    "mcp_protocol_2",
    "product_host_tools",
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

function invokeProductHostTool(request: {
  toolName: string;
  input: unknown;
  context: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    capabilityIds: string[];
  };
  signal?: AbortSignal;
}): Promise<ProductHostToolResponse> {
  if (request.signal?.aborted) return Promise.reject(request.signal.reason);
  const requestId = `host_tool_${crypto.randomUUID()}`;
  return new Promise((resolve, reject) => {
    const abort = () => {
      hostToolRequests.delete(requestId);
      reject(request.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    hostToolRequests.set(requestId, {
      resolve: (value) => {
        request.signal?.removeEventListener('abort', abort);
        resolve(value);
      },
      reject: (error) => {
        request.signal?.removeEventListener('abort', abort);
        reject(error);
      },
    });
    post({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: 'host_tool_request',
      requestId,
      toolName: request.toolName,
      input: request.input,
      context: request.context,
    });
  });
}

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
