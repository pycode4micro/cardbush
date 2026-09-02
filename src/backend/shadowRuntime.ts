import type { RuntimeEvent } from '@cardbush/bush-protocol';
import {
  CHILD_AGENT_SYSTEM_PROMPT,
  createProductAgentTurnRequest,
  latestSessionEnvironmentLocalDate,
} from '@cardbush/bush-product-agent';

import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import type {
  ShadowConversationRecord,
  ShadowConversationStreamRequest,
} from './api';
import { resolveProductModel } from './runtimeChat';

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
    const source = await runtime.client.getSession(input.sessionId);
    if (!source) throw new Error('The source conversation does not exist.');
    const requestedTurnId = input.sourceTurnId?.trim() ?? '';
    const requestedTurnIndex = requestedTurnId
      ? source.turns.findIndex((turn) => turn.turnId === requestedTurnId)
      : -1;
    const sourceTurn = requestedTurnIndex >= 0
      ? source.turns[requestedTurnIndex]
      : source.turns.at(-1);
    const sourceTurnId = sourceTurn?.turnId ?? '';
    const sourceThroughTurnSequence = sourceTurn?.turnSequence ?? 0;
    const sourceMessageIds = new Set(
      source.turns
        .filter((turn) => turn.turnSequence <= sourceThroughTurnSequence)
        .flatMap((turn) => turn.messages.map((message) => message.messageId)),
    );
    const sourceSupersededMessageIds = source.supersededMessageIds.filter((messageId) =>
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
      agentName: input.mode === 'fork' ? 'Shadow Fork' : 'Shadow',
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
        mode: input.mode,
      },
    };
    conversations.set(id, state);
    return publicRecord(state);
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
    if (!state) throw new Error('The Shadow conversation is closed or unavailable.');
    if (state.mode === mode) return publicRecord(state);
    if (activeStreams.has(conversationId)) {
      throw new Error('Shadow mode cannot change while a Turn is running.');
    }
    if (modeTransitions.has(conversationId)) {
      throw new Error('Shadow mode is already changing.');
    }
    modeTransitions.add(conversationId);
    try {
      const session = await runtime.client.getSession(state.runtimeSessionId);
      if (!session) throw new Error('The Shadow runtime session is unavailable.');
      await runtime.client.updateSessionMetadata({
        sessionId: state.runtimeSessionId,
        expectedRevision: session.revision,
        metadata: {
          ...session.metadata,
          shadowMode: mode,
        },
      });
      state.mode = mode;
      state.agentName = mode === 'fork' ? 'Shadow Fork' : 'Shadow';
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
    if (!state) throw new Error('The Shadow conversation is closed or unavailable.');
    if (modeTransitions.has(request.conversationId)) {
      throw new Error('Shadow mode is changing. Try again after it settles.');
    }
    if (activeStreams.has(request.conversationId)) {
      throw new Error('This Shadow already has an active Turn.');
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    streamLease = { controller, settled, resolveSettled };
    activeStreams.set(request.conversationId, streamLease);
    const [source, shadowSession, resolved, catalog] = await Promise.all([
      runtime.client.getSession(state.sessionId, controller.signal),
      runtime.client.getSession(state.runtimeSessionId, controller.signal),
      resolveProductModel(request.modelConfig.id),
      runtime.client.getToolCatalogDetails(controller.signal),
    ]);
    if (!source) throw new Error('The source conversation is no longer available.');
    const frozenTurnSequence = Number(state.raw.sourceThroughTurnSequence);
    const sourceTurns = Number.isSafeInteger(frozenTurnSequence) && frozenTurnSequence >= 0
      ? source.turns.filter((turn) => turn.turnSequence <= frozenTurnSequence)
      : source.turns.slice(
          0,
          state.sourceTurnId
            ? Math.max(0, source.turns.findIndex((turn) => turn.turnId === state.sourceTurnId)) + 1
            : source.turns.length,
        );
    if (state.sourceTurnId && !sourceTurns.some((turn) => turn.turnId === state.sourceTurnId)) {
      state.status = 'stale';
      state.updatedAt = new Date().toISOString();
      throw new Error('The source Turn used by this Shadow is no longer available.');
    }
    const frozenSuperseded = new Set(
      Array.isArray(state.raw.sourceSupersededMessageIds)
        ? state.raw.sourceSupersededMessageIds.map(String)
        : source.supersededMessageIds,
    );
    const sourceMessages = sourceTurns.flatMap((turn) => turn.messages)
      .filter((item) => !frozenSuperseded.has(item.messageId))
      .map((item) => item.message);
    const readOnly = state.mode === 'readonly';
    const workspaceDir = request.projectDir?.trim() || state.workspaceDir ||
      String(source.metadata?.projectDir ?? '');
    const tools = catalog
      .filter((entry) => entry.definition.name === 'checkpoint_context' || (readOnly
        ? entry.manifest.mutating === false
        : entry.visibleToChild && (Boolean(workspaceDir) || entry.manifest.dispatch_scope !== 'resource')))
      .map((entry) => entry.definition);
    const base = createProductAgentTurnRequest({
      requestId: `request_${crypto.randomUUID()}`,
      sessionId: state.runtimeSessionId,
      turnId,
      messageId,
      createdAt: new Date().toISOString(),
      localDate: new Date().toLocaleDateString('en-CA'),
      sessionEnvironmentLocalDate: latestSessionEnvironmentLocalDate(shadowSession ?? undefined),
      userText: request.content,
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
      reasoningEffort: request.reasoningLevel,
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
        {
          role: 'developer' as const,
          name: 'shadow_mode',
          content: readOnly
            ? 'This is a human-opened read-only Shadow of a frozen parent conversation. Analyze and answer from the frozen history. Do not modify resources, delegate, request permission, or imply that changes were made.'
            : 'This is a human-opened Fork of a frozen parent conversation. You may modify the current workspace using only the child-safe Tools exposed to this Turn. Do not delegate, request permission, or act outside the configured workspace roots. Re-read before edits and fail closed on revision conflicts.',
        },
        ...base.prefixMessages.filter((message) => message.role !== 'system'),
        ...sourceMessages,
      ],
      requestCapabilities: {
        vision: false,
        interactiveRequests: false,
        userChoice: false,
      },
      metadata: {
        ...base.metadata,
        agentRole: 'child',
        parentSessionId: state.sessionId,
        inheritedObservationSessionId: state.sessionId,
        shadowReadOnly: readOnly,
        shadowMode: state.mode,
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
    if (!terminal) throw new Error('Shadow Turn ended without a terminal fact.');
    const snapshot = await runtime.client.getSession(state.runtimeSessionId, controller.signal);
    const finalId = terminal.payload.finalMessageId || assistantMessageId;
    const final = snapshot?.turns.flatMap((turn) => turn.messages)
      .find((item) => item.messageId === finalId);
    const content = final?.message.role === 'assistant' ? final.message.content : '';
    if (!content) throw new Error('Shadow Turn returned no assistant response.');
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
  return record;
}

async function resolveShadowState(
  conversationId: string,
  client: ReturnType<typeof createDesktopRuntimeSession>['client'],
): Promise<ShadowState | undefined> {
  const cached = conversations.get(conversationId);
  if (cached) return cached;
  const session = (await client.listSessions()).find((candidate) =>
    candidate.metadata?.shadowConversationId === conversationId &&
    candidate.metadata?.temporary === true);
  const sourceSessionId = String(session?.metadata?.shadowOfSessionId ?? '').trim();
  if (!session || !sourceSessionId) return undefined;
  const now = session.updatedAt;
  const state: ShadowState = {
    id: conversationId,
    runtimeSessionId: session.sessionId,
    sessionId: sourceSessionId,
    sourceTurnId: String(session.metadata?.sourceTurnId ?? ''),
    workspaceDir: String(session.metadata?.projectDir ?? ''),
    agentName: session.metadata?.shadowMode === 'fork' ? 'Shadow Fork' : 'Shadow',
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
      sourceSupersededMessageIds: Array.isArray(session.metadata?.sourceSupersededMessageIds)
        ? session.metadata.sourceSupersededMessageIds.map(String)
        : [],
      mode: session.metadata?.shadowMode === 'fork' ? 'fork' : 'readonly',
    },
  };
  conversations.set(conversationId, state);
  return state;
}
