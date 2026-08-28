import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_RUNTIME_ERROR_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcInboundMessage,
  extractRuntimeIpcProtocol,
  runtimeIpcOutboundMessageSchema,
  type ModelEvent,
  type ModelRequest,
  type RuntimeIpcOutboundMessage,
  type RuntimeProtocolError,
} from '@cardbush/bush-protocol';
import {
  FileRuntimeCheckpointStore,
  FileRuntimeEventPersistence,
  InMemoryRuntimeEventLog,
  InMemoryRuntimeHost,
  type ModelProvider,
} from '@cardbush/bush-runtime';
import { OpenAICompatibleProvider } from '@cardbush/bush-provider-openai';
import { isAbsolute, join } from 'node:path';

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error('The Runtime Host must run as an Electron Utility Process.');
}

const operations = new Map<string, AbortController>();
const subscriptions = new Map<string, AbortController>();
let host: InMemoryRuntimeHost;

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
        const result = await host.sendCommand(message.command, controller.signal);
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

function createProvider(): ModelProvider {
  const apiKey = process.env.CARDBUSH_RUNTIME_PROVIDER_API_KEY?.trim();
  if (!apiKey) return new UnconfiguredProvider();
  return new OpenAICompatibleProvider({
    apiKey,
    baseURL: process.env.CARDBUSH_RUNTIME_PROVIDER_BASE_URL?.trim() || undefined,
    timeoutMs: positiveInteger(
      process.env.CARDBUSH_RUNTIME_PROVIDER_TIMEOUT_MS,
      undefined,
    ),
  });
}

class UnconfiguredProvider implements ModelProvider {
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    yield {
      protocol: BUSH_MODEL_EVENT_PROTOCOL,
      requestId: request.requestId,
      sequence: 0,
      createdAt: new Date().toISOString(),
      kind: 'response_failed',
      code: 'runtime_provider_not_configured',
      message: 'The Electron Runtime Host has no configured model provider.',
      retryable: false,
    };
  }
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

host = new InMemoryRuntimeHost({
  provider: createProvider(),
  eventLog,
  checkpointStore,
  durableRecovery: Boolean(runtimeStateRoot),
  hostId: `electron-utility-${process.pid}`,
  runtimeVersion: '0.1.0',
  maxAttempts: positiveInteger(
    process.env.CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS,
    1,
  ),
  onRecoveryError: (error) => {
    process.stderr.write(
      `${JSON.stringify({ code: 'runtime_checkpoint_cleanup_failed', message: error.message })}\n`,
    );
  },
});

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
