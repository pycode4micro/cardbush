import { uiText } from '../i18n';
import { activeSessionTurnSchema, modelMessageSchema, sessionSummaryMetadata, type RuntimeEvent } from '@cardbush/bush-protocol';
import { resolveConversationStyle } from '../features/settings/conversationStyle';
import { readIndividuation } from '../features/settings/individuation';
import {
  CHILD_AGENT_SYSTEM_PROMPT,
  createProductAgentTurnRequest,
} from '@cardbush/bush-product-agent';

import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import type {
  ShadowConversationRecord,
  ShadowConversationStreamRequest,
} from './api';
import { resolveProductModel } from './runtimeChat';
import { isInternalRuntimeMessage } from './runtimeMessageVisibility';
import { projectRuntimeTurnMessages, restoreRuntimeTurnAttachmentMetadata } from './runtimeSessionMessageProjection';
import { attachHistoryToolExecutions } from './historyToolAssociation';
import { runtimeHistoryToolExecution } from './runtimeHistoryToolExecution';

interface ShadowState extends ShadowConversationRecord {
  runtimeSessionId: string;
}

const conversations = new Map<string, ShadowState>();
const activeStreams = new Map<string, {
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
}>();
const modeTransitions = new Set<string>();

export async function createRuntimeShadowConversation(input: {
  sessionId: string;
  sourceTurnId?: string;
  clientConversationId: string;
  mode: 'readonly' | 'fork';
}): Promise<ShadowConversationRecord> {
  const runtime = createDesktopRuntimeSession();
  const id = `shadow_${input.clientConversationId.trim() || crypto.randomUUID()}`;
  const runtimeSessionId = `shadow:${crypto.randomUUID()}`;
  try {
    const requestedTurnId = input.sourceTurnId?.trim() ?? '';
    const source = await runtime.client.getLiveSession(input.sessionId, undefined, requestedTurnId || undefined);
    if (!source) throw new Error(uiText()('shadowRuntime.the_source_conversation_does_not_exist'));
    const requestedTurnIndex = requestedTurnId
      ? source.turns.findIndex((turn) => turn.turnId === requestedTurnId)
      : -1;
    const sourceTurn = requestedTurnIndex >= 0
      ? source.turns[requestedTurnIndex]
      : source.turns.at(-1);
    const sourceActiveTurn = source.activeTurn && (!requestedTurnId || requestedTurnId === source.activeTurn.turnId)
      ? source.activeTurn : undefined;
    if ((requestedTurnId && requestedTurnIndex < 0 && !sourceActiveTurn) || (!sourceTurn && !sourceActiveTurn)) {
      throw new Error(uiText()('shadowRuntime.source_turn_not_ready'));
    }
    const sourceTurnId = sourceActiveTurn?.turnId ?? sourceTurn?.turnId ?? '';
    const sourceThroughTurnSequence = sourceTurn?.turnSequence ?? 0;
    const sourceMessageIds = new Set(
      source.turns
        .filter((turn) => turn.turnSequence <= sourceThroughTurnSequence)
        .flatMap((turn) => turn.messages.map((message) => message.messageId))
        .concat(sourceActiveTurn?.messages.map(message => message.messageId) ?? []),
    );
    const sourceSupersededMessageIds = [...source.supersededMessageIds, ...sourceActiveTurn?.supersededMessageIds ?? []].filter((messageId) =>
      sourceMessageIds.has(messageId)
    );
    await runtime.client.createSession({
      sessionId: runtimeSessionId,
      metadata: {
        title: `Shadow · ${String(source.metadata?.title ?? input.sessionId)}`,
        hidden: true,
        temporary: true,
        shadowConversationId: id,
        shadowOfSessionId: input.sessionId,
        sourceTurnId,
        sourceThroughTurnSequence,
        sourceSupersededMessageIds,
        sourceActiveTurn,
        sourceModelMessages: source.modelContext,
        sourceSessionRevision: source.revision,
        shadowMode: input.mode,
        projectDir: String(source.metadata?.projectDir ?? ''),
        parentSessionId: input.sessionId,
        agentRole: 'child',
      },
    });
    const now = new Date().toISOString();
    const state: ShadowState = {
      id,
      runtimeSessionId,
      sessionId: input.sessionId,
      sourceTurnId,
      workspaceDir: String(source.metadata?.projectDir ?? ''),
      agentName: input.mode === 'fork' ? uiText()('shadowRuntime.shadow_fork') : uiText()('shadowRuntime.shadow'),
      mode: input.mode,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      raw: {
        source: 'electron_runtime',
        temporary: true,
        sourceSessionRevision: source.revision,
        sourceThroughTurnSequence,
        sourceSupersededMessageIds,
        sourceActiveTurn,
        sourceModelMessages: source.modelContext,
        mode: input.mode,
      },
    };
    conversations.set(id, state);
    const excluded = new Set(sourceSupersededMessageIds);
    // Display exactly the same frozen boundary as the model, even if the
    // parent finishes or accepts another request before the window mounts.
    const sourceMessages = source.turns.filter(turn => turn.turnSequence <= sourceThroughTurnSequence)
      .flatMap(turn => {
        const restored = restoreRuntimeTurnAttachmentMetadata(turn);
        return projectRuntimeTurnMessages({ ...restored, messages: restored.messages.filter(item =>
          !excluded.has(item.messageId) && !isInternalRuntimeMessage(item)) }, source.sessionId);
      });
    if (sourceActiveTurn) {
      const restored = restoreRuntimeTurnAttachmentMetadata(sourceActiveTurn);
      sourceMessages.push(...projectRuntimeTurnMessages({ ...restored, messages: restored.messages.filter(item =>
        !excluded.has(item.messageId) && !isInternalRuntimeMessage(item)) }, source.sessionId));
    }
    const toolIdsByTurn = new Map<string, Set<string>>();
    for (const message of sourceMessages) {
      if (message.role !== 'tool' || !message.turnId || !message.metadata?.toolCallId) continue;
      const ids = toolIdsByTurn.get(message.turnId) ?? new Set<string>();
      ids.add(String(message.metadata.toolCallId));
      toolIdsByTurn.set(message.turnId, ids);
    }
    const executions = (await Promise.all([...toolIdsByTurn].map(async ([turnId, ids]) => {
      const records = await runtime.client.listTurnToolExecutionSummaries({ sessionId: source.sessionId, turnId }).catch(() => []);
      // A live tool may finish during this read. Only receipts in the frozen
      // snapshot belong in Shadow's transcript, even within the same Turn.
      return records.filter(record => ids.has(record.toolCall.id)).map(runtimeHistoryToolExecution);
    }))).flat();
    return { ...publicRecord(state), sourceMessages: attachHistoryToolExecutions(sourceMessages, executions) };
  } finally {
    runtime.dispose();
  }
}

export async function closeRuntimeShadowConversation(conversationId: string): Promise<void> {
  const runtime = createDesktopRuntimeSession();
  try {
    const state = await resolveShadowState(conversationId, runtime.client);
    if (!state) return;
    const active = activeStreams.get(conversationId);
    if (active) {
      active.controller.abort();
      await Promise.race([
        active.settled,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    conversations.delete(conversationId);
    await runtime.client.deleteSession(state.runtimeSessionId);
  } finally {
    runtime.dispose();
  }
}

export async function updateRuntimeShadowConversationMode(
  conversationId: string,
  mode: 'readonly' | 'fork',
): Promise<ShadowConversationRecord> {
  const runtime = createDesktopRuntimeSession();
  try {
    const state = await resolveShadowState(conversationId, runtime.client);
    if (!state) throw new Error(uiText()('shadowRuntime.the_shadow_conversation_is_closed_or_unavailable'));
    if (state.mode === mode) return publicRecord(state);
    if (activeStreams.has(conversationId)) {
      throw new Error(uiText()('shadowRuntime.shadow_mode_cannot_change_while_a_turn'));
    }
    if (modeTransitions.has(conversationId)) {
      throw new Error(uiText()('shadowRuntime.shadow_mode_is_already_changing'));
    }
    modeTransitions.add(conversationId);
    try {
      const session = await runtime.client.getSession(state.runtimeSessionId);
      if (!session) throw new Error(uiText()('shadowRuntime.the_shadow_runtime_session_is_unavailable'));
      await runtime.client.updateSessionMetadata({
        sessionId: state.runtimeSessionId,
        expectedRevision: session.revision,
        metadata: {
          ...session.metadata,
          shadowMode: mode,
        },
      });
      state.mode = mode;
      state.agentName = mode === 'fork' ? uiText()('shadowRuntime.shadow_fork') : uiText()('shadowRuntime.shadow');
      state.updatedAt = new Date().toISOString();
      state.raw = { ...state.raw, mode };
      return publicRecord(state);
    } finally {
      modeTransitions.delete(conversationId);
    }
  } finally {
    runtime.dispose();
  }
}

export async function streamRuntimeShadowConversationMessage(
  request: ShadowConversationStreamRequest,
): Promise<void> {
  const runtime = createDesktopRuntimeSession();
  const turnId = `turn_${crypto.randomUUID()}`;
  const messageId = request.clientMessageId.trim() || `message_${crypto.randomUUID()}`;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal?.aborted) controller.abort();
  else request.signal?.addEventListener('abort', abort, { once: true });
  let terminal: Extract<RuntimeEvent, { kind: 'turn_terminal' }> | undefined;
  let assistantMessageId = '';
  let streamLease: ReturnType<typeof activeStreams.get>;
  try {
    const state = await resolveShadowState(request.conversationId, runtime.client);
    if (!state) throw new Error(uiText()('shadowRuntime.the_shadow_conversation_is_closed_or_unavailable'));
    if (modeTransitions.has(request.conversationId)) {
      throw new Error(uiText()('shadowRuntime.shadow_mode_is_changing_try_again_after'));
    }
    if (activeStreams.has(request.conversationId)) {
      throw new Error(uiText()('shadowRuntime.this_shadow_already_has_an_active_turn'));
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    streamLease = { controller, settled, resolveSettled };
    activeStreams.set(request.conversationId, streamLease);
    const [source, resolved, catalog, capabilities] = await Promise.all([
      runtime.client.getSession(state.sessionId, controller.signal),
      resolveProductModel(request.modelConfig.id),
      runtime.client.getToolCatalogDetails(controller.signal),
      runtime.client.getCapabilities(controller.signal),
    ]);
    // A newly opened window can load newer assets while the host is still old.
    // Never expose unrestricted Shadow tools against a host missing admission.
    if (!capabilities.features.includes('shadow_execution_policy')) {
      throw Object.assign(new Error(uiText()('shadowRuntime.restart_cardbush_to_use_the_updated_shadow')), {
        code: 'shadow_runtime_update_required',
      });
    }
    if (!source) throw new Error(uiText()('shadowRuntime.the_source_conversation_is_no_longer_available'));
    const frozenTurnSequence = Number(state.raw.sourceThroughTurnSequence);
    const sourceTurns = Number.isSafeInteger(frozenTurnSequence) && frozenTurnSequence >= 0
      ? source.turns.filter((turn) => turn.turnSequence <= frozenTurnSequence)
      : source.turns.slice(
          0,
          state.sourceTurnId
            ? Math.max(0, source.turns.findIndex((turn) => turn.turnId === state.sourceTurnId)) + 1
            : source.turns.length,
        );
    const sourceActiveTurn = state.raw.sourceActiveTurn == null ? undefined
      : activeSessionTurnSchema.parse(state.raw.sourceActiveTurn);
    if (state.sourceTurnId && sourceActiveTurn?.turnId !== state.sourceTurnId &&
        !sourceTurns.some((turn) => turn.turnId === state.sourceTurnId)) {
      state.status = 'stale';
      state.updatedAt = new Date().toISOString();
      throw new Error(uiText()('shadowRuntime.the_source_turn_used_by_this_shadow'));
    }
    const frozenSuperseded = new Set(
      Array.isArray(state.raw.sourceSupersededMessageIds)
        ? state.raw.sourceSupersededMessageIds.map(String)
        : source.supersededMessageIds,
    );
    const sourceMessages = Array.isArray(state.raw.sourceModelMessages)
      ? state.raw.sourceModelMessages.map(message => modelMessageSchema.parse(message))
      : [...sourceTurns.flatMap((turn) => turn.messages), ...sourceActiveTurn?.messages ?? []]
      .filter((item) => !frozenSuperseded.has(item.messageId))
      .map((item) => item.message);
    const readOnly = state.mode === 'readonly';
    const workspaceDir = request.projectDir?.trim() || state.workspaceDir ||
      String(source.metadata?.projectDir ?? '');
    // Like subagent Forks, preserve declarations. Child/Shadow restrictions are
    // enforced by the Runtime on every invocation, including indirect MCP calls.
    const tools = catalog.map((entry) => entry.definition);
    const base = createProductAgentTurnRequest({
      requestId: `request_${crypto.randomUUID()}`,
      sessionId: state.runtimeSessionId,
      turnId,
      messageId,
      createdAt: new Date().toISOString(),
      userText: request.content,
      conversationStyle: resolveConversationStyle(state.sessionId),
      individuation: readIndividuation(),
      userMessageName: 'shadow_user',
      model: resolved.model,
      providerBinding: resolved.binding,
      tools,
      projectDir: workspaceDir,
      // Human-opened Forks are intentionally narrower than the parent. They may
      // mutate the project workspace, but never inherit user_free/all_free.
      permissionMode: 'task_free',
      planEnabled: false,
      maxOutputTokens: resolved.maxOutputTokens,
      maxContextTokens: resolved.maxContextTokens,
      reasoningEffort: request.reasoningLevel === 'default' ? undefined : request.reasoningLevel ?? resolved.reasoningEffort,
      sessionMetadata: {
        parentSessionId: state.sessionId,
        agentRole: 'child',
        shadowMode: state.mode,
        projectDir: workspaceDir,
      },
    });
    const turnRequest = {
      ...base,
      prefixMessages: [
        { role: 'system' as const, content: CHILD_AGENT_SYSTEM_PROMPT },
        ...base.prefixMessages.filter((message) => message.role !== 'system'),
        ...sourceMessages,
      ],
      inputMessages: [
        {
          messageId: `shadow_state_${turnId}`,
          createdAt: base.inputMessages[0]!.createdAt,
          message: {
            role: 'user' as const,
            name: 'shadow_mode',
            visibility: 'internal' as const,
            content: 'You are currently a child Agent in a human-opened Shadow. Tool declarations remain available; the Runtime checks child-state restrictions at execution. Do not delegate or request permission. ' + (readOnly
              ? 'Current mode: read-only. Analyze the frozen history without modifying resources or implying that changes were made.'
              : 'Current mode: Fork. You may modify the attached workspace within its configured roots. Re-read before edits and fail closed on revision conflicts.'),
          },
        },
        ...base.inputMessages,
      ],
      requestCapabilities: {
        vision: false,
        interactiveRequests: false,
      },
      metadata: {
        ...base.metadata,
        agentRole: 'child',
        parentSessionId: state.sessionId,
        inheritedObservationSessionId: state.sessionId,
        shadowReadOnly: readOnly,
        shadowMode: state.mode,
        shadowWorkspaceDir: workspaceDir,
        sourceSessionId: state.sessionId,
        projectDir: workspaceDir,
      },
    };
    const consume = (async () => {
      for await (const event of runtime.client.events({
        sessionId: state.runtimeSessionId,
        turnId,
        signal: controller.signal,
      })) {
        if (event.kind === 'turn_accepted') request.onStart?.(messageId);
        else if (event.kind === 'assistant_segment_delta') {
          assistantMessageId = event.payload.messageId;
          request.onDelta?.(event.payload.delta);
        } else if (event.kind === 'turn_terminal') terminal = event;
      }
    })();
    const command = runtime.client.runSessionTurn(turnRequest, controller.signal);
    const [streamResult, commandResult] = await Promise.allSettled([consume, command]);
    if (streamResult.status === 'rejected') throw streamResult.reason;
    if (commandResult.status === 'rejected' && !terminal) throw commandResult.reason;
    terminal ??= commandResult.status === 'fulfilled' ? commandResult.value : undefined;
    if (!terminal) throw new Error(uiText()('shadowRuntime.shadow_turn_ended_without_a_terminal_fact'));
    const snapshot = await runtime.client.getSession(state.runtimeSessionId, controller.signal);
    const finalId = terminal.payload.finalMessageId || assistantMessageId;
    const final = snapshot?.turns.flatMap((turn) => turn.messages)
      .find((item) => item.messageId === finalId);
    const content = final?.message.role === 'assistant' ? final.message.content : '';
    if (!content) throw new Error(uiText()('shadowRuntime.shadow_turn_returned_no_assistant_response'));
    state.updatedAt = terminal.createdAt;
    request.onDone?.({ id: finalId, content, createdAt: terminal.createdAt });
  } finally {
    if (streamLease && activeStreams.get(request.conversationId) === streamLease) {
      activeStreams.delete(request.conversationId);
      streamLease.resolveSettled();
    }
    request.signal?.removeEventListener('abort', abort);
    runtime.dispose();
  }
}

function publicRecord(state: ShadowState): ShadowConversationRecord {
  const { runtimeSessionId: _runtimeSessionId, ...record } = state;
  return structuredClone({ ...record, raw: sessionSummaryMetadata(record.raw) });
}

async function resolveShadowState(
  conversationId: string,
  client: ReturnType<typeof createDesktopRuntimeSession>['client'],
): Promise<ShadowState | undefined> {
  const cached = conversations.get(conversationId);
  if (cached) return cached;
  const summary = (await client.listSessionSummaries()).find((candidate) =>
    candidate.metadata?.shadowConversationId === conversationId &&
    candidate.metadata?.temporary === true);
  const session = summary ? await client.getSession(summary.sessionId) : undefined;
  const sourceSessionId = String(session?.metadata?.shadowOfSessionId ?? '').trim();
  if (!session || !sourceSessionId) return undefined;
  const now = session.updatedAt;
  const state: ShadowState = {
    id: conversationId,
    runtimeSessionId: session.sessionId,
    sessionId: sourceSessionId,
    sourceTurnId: String(session.metadata?.sourceTurnId ?? ''),
    workspaceDir: String(session.metadata?.projectDir ?? ''),
    agentName: session.metadata?.shadowMode === 'fork' ? uiText()('shadowRuntime.shadow_fork') : uiText()('shadowRuntime.shadow'),
    mode: session.metadata?.shadowMode === 'fork' ? 'fork' : 'readonly',
    status: 'active',
    createdAt: session.createdAt,
    updatedAt: now,
    raw: {
      source: 'electron_runtime',
      temporary: true,
      restored: true,
      sourceSessionRevision: Number(session.metadata?.sourceSessionRevision),
      sourceThroughTurnSequence: Number(session.metadata?.sourceThroughTurnSequence),
      sourceActiveTurn: session.metadata?.sourceActiveTurn,
      sourceModelMessages: session.metadata?.sourceModelMessages,
      sourceSupersededMessageIds: Array.isArray(session.metadata?.sourceSupersededMessageIds)
        ? session.metadata.sourceSupersededMessageIds.map(String)
        : [],
      mode: session.metadata?.shadowMode === 'fork' ? 'fork' : 'readonly',
    },
  };
  conversations.set(conversationId, state);
  return state;
}
