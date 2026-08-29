import type { RuntimeEvent } from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';

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

export async function createRuntimeShadowConversation(input: {
  sessionId: string;
  sourceTurnId?: string;
  clientConversationId: string;
}): Promise<ShadowConversationRecord> {
  const runtime = createDesktopRuntimeSession();
  const id = `shadow_${input.clientConversationId.trim() || crypto.randomUUID()}`;
  const runtimeSessionId = `shadow:${crypto.randomUUID()}`;
  try {
    const source = await runtime.client.getSession(input.sessionId);
    if (!source) throw new Error('The source conversation does not exist.');
    const sourceTurnId = input.sourceTurnId?.trim() || source.turns.at(-1)?.turnId || '';
    await runtime.client.createSession({
      sessionId: runtimeSessionId,
      metadata: {
        title: `Shadow · ${String(source.metadata?.title ?? input.sessionId)}`,
        hidden: true,
        temporary: true,
        shadowConversationId: id,
        shadowOfSessionId: input.sessionId,
        sourceTurnId,
      },
    });
    const now = new Date().toISOString();
    const state: ShadowState = {
      id,
      runtimeSessionId,
      sessionId: input.sessionId,
      sourceTurnId,
      agentName: 'Shadow Agent',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      raw: { source: 'electron_runtime', temporary: true },
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
    conversations.delete(conversationId);
    await runtime.client.deleteSession(state.runtimeSessionId);
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
  try {
    const state = await resolveShadowState(request.conversationId, runtime.client);
    if (!state) throw new Error('The Shadow conversation is closed or unavailable.');
    const [source, resolved, catalog] = await Promise.all([
      runtime.client.getSession(state.sessionId, controller.signal),
      resolveProductModel(request.modelConfig.id),
      runtime.client.getToolCatalogDetails(controller.signal),
    ]);
    if (!source) throw new Error('The source conversation is no longer available.');
    const sourceTurnIndex = state.sourceTurnId
      ? source.turns.findIndex((turn) => turn.turnId === state.sourceTurnId)
      : -1;
    const sourceTurns = source.turns.slice(
      0,
      sourceTurnIndex >= 0 ? sourceTurnIndex + 1 : source.turns.length,
    );
    const sourceMessages = sourceTurns.flatMap((turn) => turn.messages)
      .filter((item) => !source.supersededMessageIds.includes(item.messageId))
      .map((item) => item.message);
    const base = createProductAgentTurnRequest({
      requestId: `request_${crypto.randomUUID()}`,
      sessionId: state.runtimeSessionId,
      turnId,
      messageId,
      createdAt: new Date().toISOString(),
      localDate: new Date().toLocaleDateString('en-CA'),
      userText: request.content,
      userMessageName: 'shadow_user',
      model: resolved.model,
      providerBinding: resolved.binding,
      tools: catalog
        .filter((entry) =>
          entry.manifest.dispatch_side_effect === 'none' ||
          entry.manifest.operation === 'turn.declare_outcome')
        .map((entry) => entry.definition),
      permissionMode: 'user_free',
      planEnabled: false,
      maxOutputTokens: resolved.maxOutputTokens,
      reasoningEffort: request.reasoningLevel,
      sessionMetadata: {},
    });
    const turnRequest = {
      ...base,
      prefixMessages: [...base.prefixMessages, ...sourceMessages],
      metadata: { ...base.metadata, shadowReadOnly: true, sourceSessionId: state.sessionId },
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
    agentName: 'Shadow Agent',
    status: 'active',
    createdAt: session.createdAt,
    updatedAt: now,
    raw: { source: 'electron_runtime', temporary: true, restored: true },
  };
  conversations.set(conversationId, state);
  return state;
}
