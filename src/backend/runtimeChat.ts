import type {
  RuntimeEvent,
  RuntimeProviderBindingRef,
  RuntimeSessionTurnRequest,
  ToolExecutionRecord,
} from '@cardbush/bush-protocol';
import { runtimeProviderBindingRefSchema } from '@cardbush/bush-protocol';
import {
  GOAL_CONTINUATION_PROMPT,
  createProductAgentTurnRequest,
} from '@cardbush/bush-product-agent';
import type { ProductSubagentConfig } from '@cardbush/product-host';

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
  registerActiveRuntimeTurn,
  registerRuntimePermission,
  registerRuntimeGenericInteraction,
  removeRuntimeGenericInteraction,
  removeRuntimePermission,
  removeRuntimePermissionsForTurn,
} from '../runtime-client/RuntimeInteractionBridge';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
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
    const rootModelId = request.modelConfig?.id.trim() || request.model;
    const [resolvedModel, subagentConfig, filesystemLocations] = await Promise.all([
      resolveProductModel(rootModelId),
      readProductSubagentConfig(),
      readOsFilesystemLocations(),
    ]);
    const childModel = subagentConfig.model.mode === 'fixed'
      ? subagentConfig.model.modelId === rootModelId
        ? resolvedModel
        : await resolveProductModel(subagentConfig.model.modelId)
      : undefined;
    const childAgentPolicy: Record<string, unknown> = {
      permissionRouting: request.subagentPermissionRouting ?? subagentConfig.permissionRouting,
      childPermissionMode: subagentConfig.childPermissionMode,
      model: childModel ? {
        mode: 'fixed',
        modelId: subagentConfig.model.mode === 'fixed'
          ? subagentConfig.model.modelId
          : rootModelId,
        model: childModel.model,
        providerBinding: childModel.binding,
        ...(childModel.maxContextTokens ? { maxContextTokens: childModel.maxContextTokens } : {}),
        ...(childModel.maxOutputTokens ? { maxOutputTokens: childModel.maxOutputTokens } : {}),
      } : { mode: 'inherit' },
      disabledTools: subagentConfig.disabledTools,
    };
    await synchronizeProductMcpSnapshot(runtime.client);
    const catalog = await runtime.client.getToolCatalogDetails(controller.signal);
    const activeGoal = await runtime.client.getGoal(request.sessionId, controller.signal);
    await synchronizeProductTeamSnapshot(
      runtime.client,
      catalog.map((entry) => entry.definition),
    );
    const disabled = new Set(request.disabledTools ?? []);
    const permissionMode = request.permissionMode ?? 'task_free';
    const interactiveRequests = request.interactiveRequestsEnabled === true;
    const vision = request.standardImageInputEnabled === true;
    const userChoice = false;
    const goalAvailable = Boolean(goalCommand || activeGoal?.status === 'active');
    const tools = catalog.filter((entry) =>
      (!disabled.has(entry.definition.name) || entry.definition.name === 'checkpoint_context') &&
      (entry.definition.name !== 'request_permission' || (interactiveRequests && permissionMode !== 'all_free')) &&
      (entry.definition.name !== 'request_user_choice' || (interactiveRequests && userChoice)) &&
      (entry.definition.name !== 'inject_image_input' || vision) &&
      (entry.definition.name !== 'update_goal' || goalAvailable) &&
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
      model: resolvedModel.model,
      providerBinding: resolvedModel.binding,
      tools,
      projectDir: request.projectDir,
      projectInstructions: request.projectUserPrompt,
      files: request.files,
      images: request.images?.map((image) => image.path),
      filesystemLocations,
      permissionMode,
      subagentPermissionRouting: request.subagentPermissionRouting ?? subagentConfig.permissionRouting,
      childAgentPolicy,
      interactiveRequestsEnabled: request.interactiveRequestsEnabled,
      userChoiceEnabled: userChoice,
      visionEnabled: vision,
      teamId: request.teamId,
      allowedSkills: request.allowedSkills,
      planEnabled: request.referencePlanMode !== 'off',
      maxOutputTokens: positiveInteger(
        request.modelConfig?.maxCompletionTokens ?? resolvedModel.maxOutputTokens,
      ),
      maxContextTokens: positiveInteger(
        request.modelConfig?.maxContextTokens ?? resolvedModel.maxContextTokens,
      ),
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
        () => runtime.client.stopTurn({
          sessionId: request.sessionId,
          turnId: currentRequest.turnId,
        }),
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
      if (goal?.status !== 'active' || terminal.payload.status !== 'completed') {
        break;
      }
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

async function readOsFilesystemLocations(): Promise<Array<{
  id: string;
  name: string;
  path: string;
}>> {
  const read = window.cardbushDesktop?.osFilesystemLocations;
  if (!read) return [];
  try {
    return await read();
  } catch {
    return [];
  }
}

interface ResolvedProductModel {
  model: string;
  binding: RuntimeProviderBindingRef;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export async function resolveProductModel(modelId: string): Promise<ResolvedProductModel> {
  const execute = window.cardbushDesktop?.productHostCommand;
  if (!execute) throw new Error('CardBush Product Host is unavailable.');
  const response = await execute({
    protocol: 'cardbush.product_host_ipc.v1',
    kind: 'model.resolve',
    modelId,
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('CardBush Product Host returned an invalid model resolution.');
  }
  const envelope = response as Record<string, unknown>;
  if (envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown>
      : {};
    throw new Error(String(error.message ?? 'Product model resolution failed.'));
  }
  const value = envelope.value && typeof envelope.value === 'object' && !Array.isArray(envelope.value)
    ? envelope.value as Record<string, unknown>
    : {};
  const model = String(value.model ?? '').trim();
  if (!model) throw new Error('Product model resolution omitted the model name.');
  return {
    model,
    binding: runtimeProviderBindingRefSchema.parse(value.binding),
    ...(positiveInteger(value.maxContextTokens) ? {
      maxContextTokens: positiveInteger(value.maxContextTokens),
    } : {}),
    ...(positiveInteger(value.maxOutputTokens) ? {
      maxOutputTokens: positiveInteger(value.maxOutputTokens),
    } : {}),
  };
}

async function readProductSubagentConfig(): Promise<ProductSubagentConfig> {
  const execute = window.cardbushDesktop?.productHostCommand;
  if (!execute) throw new Error('CardBush Product Host is unavailable.');
  const response = await execute({
    protocol: 'cardbush.product_host_ipc.v1',
    kind: 'subagents.get',
  });
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('CardBush Product Host returned an invalid Subagent configuration.');
  }
  const envelope = response as Record<string, unknown>;
  if (envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown>
      : {};
    throw new Error(String(error.message ?? 'Product Subagent configuration failed.'));
  }
  const value = envelope.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Product Subagent configuration payload must be an object.');
  }
  return value as unknown as ProductSubagentConfig;
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
        snapshot.turns.flatMap((turn) => turn.messages.map((message) => ({
          id: message.messageId,
          messageId: message.messageId,
          role: message.message.role === 'developer' ? 'system' : message.message.role,
          content: message.message.content,
          conversationId: snapshot.sessionId,
          turnId: message.turnId,
          createdAt: message.createdAt,
          ...(message.message.role === 'assistant' ? {
            status: turn.status === 'completed' ? 'complete' : turn.status,
          } : {}),
          turnSequence: message.turnSequence,
          messageIndex: message.messageIndex,
          ...(message.message.role === 'assistant' ? {
            metadata: {
              toolCalls: message.message.toolCalls,
              cardbush_turn_started_at: turn.createdAt,
              cardbush_turn_completed_at: turn.completedAt,
              cardbush_turn_duration_ms: Math.max(
                0,
                Date.parse(turn.completedAt) - Date.parse(turn.createdAt),
              ),
            },
          } : {}),
        }))),
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
              subagentDispatches(record, event).forEach((dispatch) =>
                request.onSubagentDispatch?.(dispatch),
              );
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
      case 'interaction_requested': {
        const interaction = registerRuntimeGenericInteraction({
          protocol: 'bush.runtime_interaction.v1',
          interactionId: event.payload.interactionId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolCallId: event.payload.toolCallId,
          title: event.payload.title,
          description: event.payload.description,
          reason: event.payload.reason,
          questions: event.payload.questions,
          submitLabel: event.payload.submitLabel,
          cancelLabel: event.payload.cancelLabel,
          createdAt: event.createdAt,
          expiresAt: event.payload.expiresAt,
        }, (answer) => runtime.client.answerInteraction(answer));
        request.onInteractiveRequest?.(interaction);
        break;
      }
      case 'interaction_answered':
      case 'interaction_cancelled':
      case 'interaction_expired':
        removeRuntimeGenericInteraction(event.payload.interactionId);
        break;
      case 'provider_retry':
        request.onConnectionState?.({
          state: 'retrying',
          source: 'provider',
          sessionId: event.sessionId,
          turnId: event.turnId,
          attempt: event.payload.attempt,
          maxAttempts: event.payload.maxAttempts,
          nextRetryMs: event.payload.nextRetryMs,
          reason: event.payload.code,
          message: event.payload.message,
          createdAt: event.createdAt,
        });
        break;
      case 'connection_interrupted':
        request.onConnectionState?.({
          state: event.payload.resumable ? 'retrying' : 'failed',
          source: event.payload.source === 'provider' ? 'provider' : 'network',
          sessionId: event.sessionId,
          turnId: event.turnId,
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
    sourceSessionId: event.payload.sourceSessionId,
    sourceTurnId: event.payload.sourceTurnId,
    parentSessionId: event.payload.parentSessionId,
    parentTurnId: event.payload.parentTurnId,
    subagentTaskId: event.payload.subagentTaskId,
    permissionRouting: event.payload.permissionRouting,
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

function subagentDispatches(
  record: ToolExecutionRecord,
  event: Extract<RuntimeEvent, { kind: 'tool_completed' | 'tool_failed' }>,
) {
  const output = object(record.result.output);
  const members = Array.isArray(output.members)
    ? output.members.map((item) => object(item))
    : [];
  const items = record.toolCall.name === 'team_delegate' && members.length > 0
    ? members
    : [output];
  return items.map((item) => {
    const status = String(item.status ?? output.status ?? (record.result.success ? 'completed' : 'failed'));
    const terminal = ['completed', 'failed', 'stopped', 'cancelled'].includes(status);
    return {
    protocol: 'bush.subagent_task.v1',
    phase: record.result.success ? 'dispatched' as const : 'failed' as const,
    status,
    terminal,
    accepted: record.result.success,
    taskId: optionalString(item.taskId),
    toolCallId: record.toolCall.id,
    parentSessionId: event.sessionId,
    parentTurnId: event.turnId,
    childSessionId: optionalString(item.childSessionId),
    childTurnId: optionalString(item.childTurnId),
    origin: record.toolCall.name === 'team_delegate' ? 'team' : 'subagent',
    teamId: optionalString(output.teamId),
    teamMemberId: optionalString(item.memberId),
    agentProfileId: optionalString(item.agentProfileId),
    errorCode: record.result.error?.code,
    raw: item,
    };
  });
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
  return value === 'max' || value === 'xhigh' || value === 'high' ||
    value === 'medium' || value === 'low' || value === 'minimal' || value === 'none'
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
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
