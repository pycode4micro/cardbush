import type {
  RuntimeEvent,
  RuntimeSessionTurnRequest,
  ToolExecutionRecord,
} from '@cardbush/bush-protocol';

import type {
  AssistantStreamChunk,
  ChatToolArtifact,
  ChatToolExecution,
  PendingInteraction,
  TaskPlanStreamUpdate,
  ThinkingStreamEvent,
  TurnTerminalSnapshot,
} from '../types';
import {
  createDesktopRuntimeSession,
  registerActiveRuntimeTurn,
  registerRuntimePermission,
  removeRuntimePermission,
  removeRuntimePermissionsForTurn,
} from '../runtime-client';
import type { ChatStreamRequest } from './api';

const ROOT_SYSTEM_PROMPT = `You are CardBush, a local general-purpose Agent. Work from the user's semantic request and the facts returned by the Tools actually exposed to this Turn.

For delivery or review work, use update_task_plan when a visible plan materially helps. Delegate only substantial independent workstreams; keep coupled or sequential work in the current Agent. Inspect before changing existing resources, execute the requested work, and verify it in proportion to risk. If a Tool asks for permission, wait for the user's exact answer rather than attempting an alternate route.

Default to a concise final response stating the outcome, verification and remaining risk. For every local deliverable, include its absolute path. Do not repeat logs or the user's request unless needed to explain a failure.`;

const CHILD_SYSTEM_PROMPT = `You are an independently executing child Agent. The parent has supplied the relevant pre-dispatch context and one bounded assignment. Complete that assignment directly with the Tools exposed to you, verify your own result, and report a concise terminal result. Do not delegate further. Include absolute paths for local deliverables.`;
const GOAL_CONTINUATION_PROMPT = `检查当前目标是否已经完成。若尚未完成，继续推进目标；若已经完成或确实无法继续，通过 update_goal 提交准确状态。`;
const WORKSPACE_TOOLS = new Set([
  'read_file',
  'search_file_content',
  'write_file',
  'edit_file',
  'terminal_exec',
]);

export async function streamRuntimeChat(request: ChatStreamRequest): Promise<void> {
  if (!window.cardbushDesktop?.runtime) {
    throw new Error('Electron Runtime bridge is unavailable.');
  }
  if (!request.model.trim()) throw new Error('Runtime model is required.');
  const runtime = createDesktopRuntimeSession();
  const controller = new AbortController();
  const detachAbort = forwardAbort(request.signal, controller);
  const turnId = `turn_${crypto.randomUUID()}`;
  const requestId = `request_${crypto.randomUUID()}`;
  const userMessageId = `message_${crypto.randomUUID()}`;
  const pendingToolLoads = new Set<Promise<void>>();
  let terminal: Extract<RuntimeEvent, { kind: 'turn_terminal' }> | undefined;
  let lastAssistantMessageId = '';
  try {
    const configured = request.modelConfig?.apiKey.trim()
    ? await runtime.configureProvider({
        protocol: 'bush.provider_binding_config.v1',
        bindingId: request.modelConfig.id || request.model,
        adapter: 'openai_compatible',
        apiKey: request.modelConfig.apiKey,
        baseURL: request.modelConfig.baseUrl.trim() || undefined,
        defaultHeaders: {},
      }, controller.signal)
    : undefined;
    const providerBinding = configured?.status === 'configured'
    ? configured.binding
    : undefined;
    const catalog = await runtime.client.getToolCatalog(controller.signal);
    const disabled = new Set(request.disabledTools ?? []);
    const hasWorkspace = Boolean(request.projectDir?.trim());
    const tools = catalog.filter((tool) =>
      !disabled.has(tool.name) &&
      (hasWorkspace || !WORKSPACE_TOOLS.has(tool.name)) &&
      (request.referencePlanMode !== 'off' || tool.name !== 'update_task_plan') &&
      (request.teamModeEnabled === true || tool.name !== 'team_delegate'),
    );
    const contextMessage = runtimeContext(request);
    const runtimeRequest: RuntimeSessionTurnRequest = {
    protocol: 'bush.session_turn_request.v1',
    requestId,
    sessionId: request.sessionId,
    turnId,
    model: request.modelConfig?.modelName.trim() || request.model,
    providerBinding,
    prefixMessages: [
      { role: 'system', content: ROOT_SYSTEM_PROMPT },
      ...(contextMessage
        ? [{ role: 'user' as const, name: 'runtime_context', content: contextMessage }]
        : []),
    ],
    inputMessages: [{
      messageId: userMessageId,
      createdAt: new Date().toISOString(),
      message: { role: 'user', content: request.userInput },
    }],
    sessionMetadata: {
      title: initialTitle(request.userInput),
      ...(request.projectDir?.trim() ? { projectDir: request.projectDir.trim() } : {}),
    },
    tools,
    toolChoice: 'auto',
    maxOutputTokens: positiveInteger(request.modelConfig?.maxCompletionTokens),
    reasoningEffort: reasoningEffort(request.reasoningLevel),
      metadata: {
      source: 'cardbush_electron_runtime',
      ...(request.projectDir?.trim()
        ? {
            workspaceDir: request.projectDir.trim(),
            projectDir: request.projectDir.trim(),
          }
        : {}),
      permissionMode: request.permissionMode ?? 'task_free',
      teamId: request.teamId,
      allowedSkills: request.allowedSkills ?? [],
      subagentChildPrefixMessages: [{ role: 'system', content: CHILD_SYSTEM_PROMPT }],
      },
    };
    let currentRequest = runtimeRequest;
    while (true) {
      terminal = undefined;
      lastAssistantMessageId = '';
      const unregisterTurn = registerActiveRuntimeTurn(
        currentRequest.turnId,
        request.sessionId,
        () => controller.abort(),
      );
      try {
        const stream = consumeRuntimeEvents(
          runtime,
          currentRequest,
          request,
          pendingToolLoads,
          (event) => {
            terminal = event;
            lastAssistantMessageId = event.payload.finalMessageId ?? lastAssistantMessageId;
          },
          (messageId) => { lastAssistantMessageId = messageId; },
          controller.signal,
        );
        const command = runtime.client.runSessionTurn(currentRequest, controller.signal);
        const [streamResult, commandResult] = await Promise.allSettled([stream, command]);
        await Promise.allSettled([...pendingToolLoads]);
        if (streamResult.status === 'rejected') throw streamResult.reason;
        if (commandResult.status === 'rejected' && !terminal) throw commandResult.reason;
        terminal ??= commandResult.status === 'fulfilled' ? commandResult.value : undefined;
        if (!terminal) throw new Error('Runtime Turn ended without a terminal fact.');
      } finally {
        removeRuntimePermissionsForTurn(currentRequest.turnId);
        unregisterTurn();
      }

      const goal = await runtime.client.getGoal(request.sessionId, controller.signal);
      if (goal?.status !== 'active' || terminal.payload.status !== 'completed') break;
      currentRequest = {
        ...runtimeRequest,
        requestId: `request_${crypto.randomUUID()}`,
        turnId: `turn_${crypto.randomUUID()}`,
        inputMessages: [{
          messageId: `message_${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          message: {
            role: 'user',
            name: 'goal_continuation',
            content: GOAL_CONTINUATION_PROMPT,
          },
        }],
        sessionMetadata: {},
      };
    }

    const snapshot = await runtime.client.getSession(request.sessionId, controller.signal);
    const committed = snapshot?.turns.find((turn) => turn.turnId === terminal?.turnId);
    const finalMessage = committed?.messages.find(
      (message) => message.messageId === terminal?.payload.finalMessageId,
    );
    const finalText = finalMessage?.message.role === 'assistant'
      ? finalMessage.message.content
      : '';
    if (finalText) {
      request.onFinalAssistantText?.(
        finalText,
        streamChunk(terminal, lastAssistantMessageId || finalMessage?.messageId || ''),
      );
    }
    request.onContextWindowUsage?.({
      sessionId: request.sessionId,
      turnId,
      model: runtimeRequest.model,
      usedTokens: committed?.usage.inputTokens,
      maxTokens: request.modelConfig?.maxContextTokens,
      remainingTokens:
        request.modelConfig?.maxContextTokens && committed?.usage.inputTokens != null
          ? Math.max(0, request.modelConfig.maxContextTokens - committed.usage.inputTokens)
          : undefined,
      usageRatio:
        request.modelConfig?.maxContextTokens && committed?.usage.inputTokens != null
          ? committed.usage.inputTokens / request.modelConfig.maxContextTokens
          : undefined,
      measuredAt: committed?.completedAt ?? new Date().toISOString(),
      source: 'electron_runtime',
      raw: { usage: committed?.usage ?? {} },
    });
    request.onDone?.(terminalSnapshot(terminal));
  } finally {
    detachAbort();
    runtime.dispose();
  }
}

async function consumeRuntimeEvents(
  runtime: ReturnType<typeof createDesktopRuntimeSession>,
  runtimeRequest: RuntimeSessionTurnRequest,
  request: ChatStreamRequest,
  pendingToolLoads: Set<Promise<void>>,
  onTerminal: (event: Extract<RuntimeEvent, { kind: 'turn_terminal' }>) => void,
  onAssistantMessage: (messageId: string) => void,
  signal: AbortSignal,
) {
  for await (const event of runtime.client.events({
    sessionId: runtimeRequest.sessionId,
    turnId: runtimeRequest.turnId,
    signal,
  })) {
    switch (event.kind) {
      case 'turn_accepted':
        request.onStart?.({
          sessionId: event.sessionId,
          turnId: event.turnId,
          createdAt: event.createdAt,
        });
        break;
      case 'reasoning_segment_started':
        request.onThinking?.(thinking(event, 'start', ''));
        break;
      case 'reasoning_segment_delta':
        request.onThinking?.(thinking(event, 'delta', event.payload.delta));
        break;
      case 'reasoning_segment_completed':
        request.onThinking?.(thinking(event, 'end', ''));
        break;
      case 'assistant_segment_delta':
        onAssistantMessage(event.payload.messageId);
        request.onDelta?.(event.payload.delta, streamChunk(event, event.payload.messageId));
        break;
      case 'tool_queued':
      case 'tool_running':
        request.onToolExecution?.(toolLifecycle(event));
        break;
      case 'tool_completed':
      case 'tool_failed': {
        const loading = runtime.client
          .getToolExecution({
            sessionId: event.sessionId,
            turnId: event.turnId,
            toolCallId: event.payload.toolCallId,
          })
          .then(async (record) => {
            request.onToolExecution?.(
              record ? toolRecord(record, event) : toolLifecycle(event),
            );
            if (record?.toolCall.name === 'update_task_plan') {
              const plan = await runtime.client.getPlan(event.sessionId);
              if (plan) request.onTaskPlanUpdate?.(planUpdate(plan.plan, event));
            }
            if (record && (record.toolCall.name === 'subagent' || record.toolCall.name === 'team_delegate')) {
              request.onSubagentDispatch?.(subagentDispatch(record, event));
            }
          })
          .finally(() => pendingToolLoads.delete(loading));
        pendingToolLoads.add(loading);
        break;
      }
      case 'tool_cancelled':
        request.onToolExecution?.(toolLifecycle(event));
        break;
      case 'permission_requested': {
        const interaction = permissionInteraction(runtime, event);
        request.onInteractiveRequest?.(interaction);
        break;
      }
      case 'permission_answered':
      case 'permission_rejected':
      case 'permission_cancelled':
      case 'permission_expired':
        removeRuntimePermission(event.payload.permissionId);
        break;
      case 'provider_retry':
        request.onConnectionState?.({
          state: 'retrying',
          source: 'provider',
          sessionId: event.sessionId,
          turnId: event.turnId,
          attempt: event.payload.attempt,
          nextRetryMs: event.payload.nextRetryMs,
          reason: event.payload.code,
          message: event.payload.message,
          createdAt: event.createdAt,
        });
        break;
      case 'stream_resumed':
        request.onConnectionState?.({
          state: 'recovered',
          source: 'network',
          sessionId: event.sessionId,
          turnId: event.turnId,
          createdAt: event.createdAt,
        });
        break;
      case 'turn_terminal':
        onTerminal(event);
        break;
    }
  }
}

function permissionInteraction(
  runtime: ReturnType<typeof createDesktopRuntimeSession>,
  event: Extract<RuntimeEvent, { kind: 'permission_requested' }>,
): PendingInteraction {
  return registerRuntimePermission({
    permissionId: event.payload.permissionId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    toolCallId: event.payload.toolCallId,
    reason: event.payload.reason,
    actions: event.payload.actions,
    resources: event.payload.resources,
    requestedCapabilityIds: event.payload.requestedCapabilityIds,
    answer: (answer) => runtime.answerPermission(answer),
  });
}

function streamChunk(
  event: Pick<RuntimeEvent, 'turnId' | 'createdAt' | 'sequence' | 'requestId' | 'eventId'>,
  messageId: string,
): AssistantStreamChunk {
  return {
    messageId,
    turnId: event.turnId,
    createdAt: event.createdAt,
    sequence: event.sequence,
    requestId: event.requestId,
    eventId: event.eventId,
  };
}

function thinking(
  event: Extract<RuntimeEvent, {
    kind: 'reasoning_segment_started' | 'reasoning_segment_delta' | 'reasoning_segment_completed';
  }>,
  phase: ThinkingStreamEvent['phase'],
  delta: string,
): ThinkingStreamEvent {
  return {
    id: event.payload.segmentId,
    channel: 'reasoning',
    turnId: event.turnId,
    generationId: event.payload.segmentId,
    phase,
    delta,
    content: event.kind === 'reasoning_segment_completed' ? event.payload.content : '',
    preview: delta,
    createdAt: event.createdAt,
  };
}

function toolLifecycle(
  event: Extract<RuntimeEvent, {
    kind: 'tool_queued' | 'tool_running' | 'tool_completed' | 'tool_failed' | 'tool_cancelled';
  }>,
): ChatToolExecution {
  return {
    id: event.payload.toolCallId,
    name: event.payload.toolName,
    state: event.kind.replace('tool_', ''),
    summary: event.payload.display?.summary || event.payload.display?.title || event.payload.toolName,
    output: '',
    success: event.kind === 'tool_completed',
    durationMs: 0,
    createdAt: event.createdAt,
    contentOffset: 0,
    sequence: event.sequence,
    turnId: event.turnId,
    assistantMessageId: event.payload.assistantMessageId,
    metadata: {
      receiptIds: 'receiptIds' in event.payload ? event.payload.receiptIds : [],
      workspaceChangeIds: 'workspaceChangeIds' in event.payload
        ? event.payload.workspaceChangeIds
        : [],
    },
  };
}

function toolRecord(
  record: ToolExecutionRecord,
  event: Extract<RuntimeEvent, { kind: 'tool_completed' | 'tool_failed' }>,
): ChatToolExecution {
  return {
    ...toolLifecycle(event),
    state: record.outcome,
    output: JSON.stringify(record.result.output, null, 2),
    success: record.result.success,
    artifacts: record.result.artifacts.map(artifact),
    metadata: {
      actionManifest: record.actionManifest,
      facts: record.result.facts,
      workspaceChanges: record.result.workspace_changes,
      error: record.result.error,
    },
  };
}

function artifact(value: ToolExecutionRecord['result']['artifacts'][number]): ChatToolArtifact {
  const path = value.path ?? value.uri ?? '';
  const media = value.media_type ?? '';
  const type: ChatToolArtifact['type'] = media.startsWith('image/')
    ? 'image'
    : media.startsWith('video/')
      ? 'video'
      : media.startsWith('audio/')
        ? 'audio'
        : 'document';
  return {
    id: value.artifact_id,
    name: path.split(/[\\/]/).at(-1) || value.artifact_id,
    type,
    path,
    mimeType: value.media_type,
    display: value.display === 'inline' ? 'inline' : 'attachment',
    readOnly: value.metadata.readOnly !== false,
  };
}

function planUpdate(
  plan: {
    plan_id: string;
    session_id: string;
    nodes: Array<{ id?: string; step: string; status: 'pending' | 'in_progress' | 'completed' }>;
    explanation: string;
    active: boolean;
  },
  event: Extract<RuntimeEvent, { kind: 'tool_completed' | 'tool_failed' }>,
): TaskPlanStreamUpdate {
  return {
    turnId: event.turnId,
    messageId: event.payload.assistantMessageId,
    plan: {
      protocol: 'bush.task_plan.v1',
      planId: plan.plan_id,
      sessionId: plan.session_id,
      nodes: plan.nodes,
      explanation: plan.explanation,
      active: plan.active,
    },
  };
}

function subagentDispatch(
  record: ToolExecutionRecord,
  event: Extract<RuntimeEvent, { kind: 'tool_completed' | 'tool_failed' }>,
) {
  const output = object(record.result.output);
  return {
    protocol: 'bush.subagent_task.v1',
    phase: record.result.success ? 'dispatched' as const : 'failed' as const,
    status: String(output.status ?? (record.result.success ? 'completed' : 'failed')),
    terminal: true,
    accepted: record.result.success,
    taskId: optionalString(output.taskId),
    toolCallId: record.toolCall.id,
    parentSessionId: event.sessionId,
    parentTurnId: event.turnId,
    childSessionId: optionalString(output.childSessionId),
    childTurnId: optionalString(output.childTurnId),
    origin: record.toolCall.name === 'team_delegate' ? 'team' : 'subagent',
    teamId: optionalString(output.teamId),
    errorCode: record.result.error?.code,
    raw: output,
  };
}

function terminalSnapshot(
  event: Extract<RuntimeEvent, { kind: 'turn_terminal' }>,
): TurnTerminalSnapshot {
  return {
    turnId: event.turnId,
    status: event.payload.status,
    stopped: event.payload.status === 'stopped',
    stopReason: event.payload.reason,
    stopScenario: event.payload.reason,
    stopDetails: event.payload.details,
    completedAt: event.createdAt,
    terminalEventSequence: event.sequence,
    raw: event,
  };
}

function runtimeContext(request: ChatStreamRequest): string {
  const context = [
    request.projectDir?.trim() ? `Workspace: ${request.projectDir.trim()}` : '',
    `Local date: ${new Date().toLocaleDateString('en-CA')}`,
    request.projectUserPrompt?.trim()
      ? `Project instructions:\n${request.projectUserPrompt.trim()}`
      : '',
    request.files?.length ? `Attached files:\n${request.files.join('\n')}` : '',
    request.images?.length
      ? `Attached images:\n${request.images.map((image) => image.path).join('\n')}`
      : '',
  ].filter(Boolean).join('\n');
  return context ? `<runtime_context>\n${context}\n</runtime_context>` : '';
}

function initialTitle(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, 80) || 'New conversation';
}

function reasoningEffort(value: ChatStreamRequest['reasoningLevel']) {
  return value === 'max' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController) {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}
