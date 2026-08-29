import type {
  RuntimeEvent,
  RuntimeSessionTurnRequest,
  ToolExecutionRecord,
} from '@cardbush/bush-protocol';
import {
  GOAL_CONTINUATION_PROMPT,
  createProductAgentTurnRequest,
} from '@cardbush/bush-product-agent';

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
  takeRuntimeGuidance,
} from '../runtime-client';
import type {
  ChatStreamEventHandlers,
  ChatStreamRequest,
  TurnEventStreamRequest,
} from './api';
import { synchronizeProductMcpSnapshot } from './productMcp';
import { synchronizeProductTeamSnapshot } from './productTeams';
import { parseGoalCommand } from './goalCommand';

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
  const goalCommand = parseGoalCommand(request.userInput);
  const effectiveUserInput = goalCommand?.objective ?? request.userInput;
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
    await synchronizeProductMcpSnapshot(runtime.client);
    const catalog = await runtime.client.getToolCatalogDetails(controller.signal);
    await synchronizeProductTeamSnapshot(
      runtime.client,
      catalog.map((entry) => entry.definition),
    );
    const disabled = new Set(request.disabledTools ?? []);
    const hasWorkspace = Boolean(request.projectDir?.trim());
    const tools = catalog.filter((entry) =>
      !disabled.has(entry.definition.name) &&
      (hasWorkspace || entry.manifest.dispatch_scope !== 'resource') &&
      (request.referencePlanMode !== 'off' || entry.manifest.operation !== 'plan.update') &&
      (request.teamModeEnabled === true || entry.manifest.operation !== 'agent.team_delegate'),
    ).map((entry) => entry.definition);
    const runtimeRequest = createProductAgentTurnRequest({
      requestId,
      sessionId: request.sessionId,
      turnId,
      messageId: userMessageId,
      createdAt: new Date().toISOString(),
      localDate: new Date().toLocaleDateString('en-CA'),
      userText: effectiveUserInput,
      ...(goalCommand ? { userMessageName: 'goal_request' } : {}),
      model: request.modelConfig?.modelName.trim() || request.model,
      providerBinding,
      tools,
      projectDir: request.projectDir,
      projectInstructions: request.projectUserPrompt,
      files: request.files,
      images: request.images?.map((image) => image.path),
      permissionMode: request.permissionMode ?? 'task_free',
      teamId: request.teamId,
      allowedSkills: request.allowedSkills,
      planEnabled: request.referencePlanMode !== 'off',
      maxOutputTokens: positiveInteger(request.modelConfig?.maxCompletionTokens),
      reasoningEffort: reasoningEffort(request.reasoningLevel),
    });
    if (goalCommand) {
      await runtime.client.createGoal({
        goalId: `goal_${crypto.randomUUID()}`,
        sessionId: request.sessionId,
        objective: goalCommand.objective,
        linkedA2ATaskIds: [],
      }, controller.signal);
    }
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

      const guidance = takeRuntimeGuidance(request.sessionId);
      const goal = await runtime.client.getGoal(request.sessionId, controller.signal);
      if (!guidance && (goal?.status !== 'active' || terminal.payload.status !== 'completed')) {
        break;
      }
      currentRequest = {
        ...runtimeRequest,
        requestId: `request_${crypto.randomUUID()}`,
        turnId: `turn_${crypto.randomUUID()}`,
        inputMessages: [{
          messageId: guidance?.clientMessageId || `message_${crypto.randomUUID()}`,
          createdAt: new Date().toISOString(),
          message: {
            role: 'user',
            name: guidance ? 'turn_guidance' : 'goal_continuation',
            content: guidance?.content ?? GOAL_CONTINUATION_PROMPT,
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

export async function streamRuntimeTurnEvents(
  request: TurnEventStreamRequest,
): Promise<void> {
  const runtime = createDesktopRuntimeSession();
  const pendingToolLoads = new Set<Promise<void>>();
  let terminal: Extract<RuntimeEvent, { kind: 'turn_terminal' }> | undefined;
  try {
    await consumeRuntimeEvents(
      runtime,
      { sessionId: request.sessionId, turnId: request.turnId },
      request,
      pendingToolLoads,
      (event) => { terminal = event; },
      () => undefined,
      request.signal ?? new AbortController().signal,
      {
        afterSequence: request.afterSequence,
        lastEventId: request.lastEventId,
      },
    );
    await Promise.allSettled([...pendingToolLoads]);
    if (terminal) request.onDone?.(terminalSnapshot(terminal));
    const snapshot = await runtime.client.getSession(request.sessionId, request.signal);
    if (snapshot) {
      request.onMessages?.(
        snapshot.turns.flatMap((turn) => turn.messages).map((message) => ({
          id: message.messageId,
          messageId: message.messageId,
          role: message.message.role === 'developer' ? 'system' : message.message.role,
          content: message.message.content,
          conversationId: snapshot.sessionId,
          turnId: message.turnId,
          createdAt: message.createdAt,
          turnSequence: message.turnSequence,
          messageIndex: message.messageIndex,
        })),
        true,
      );
    }
  } finally {
    runtime.dispose();
  }
}

async function consumeRuntimeEvents(
  runtime: ReturnType<typeof createDesktopRuntimeSession>,
  runtimeRequest: Pick<RuntimeSessionTurnRequest, 'sessionId' | 'turnId'>,
  request: ChatStreamEventHandlers,
  pendingToolLoads: Set<Promise<void>>,
  onTerminal: (event: Extract<RuntimeEvent, { kind: 'turn_terminal' }>) => void,
  onAssistantMessage: (messageId: string) => void,
  signal: AbortSignal,
  cursor?: { afterSequence?: number; lastEventId?: string },
) {
  for await (const event of runtime.client.events({
    sessionId: runtimeRequest.sessionId,
    turnId: runtimeRequest.turnId,
    cursor,
    signal,
  })) {
    request.onEventCursor?.({
      eventName: event.kind,
      eventId: event.eventId,
      sequence: event.sequence,
    });
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
