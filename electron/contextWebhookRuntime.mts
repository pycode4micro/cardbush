import { createTurnTimeContext, runtimeSessionTurnRequestSchema, assistantProfileSchema, type SessionSnapshot } from '@cardbush/bush-protocol';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { WebhookBinding } from './contextWebhookTypes.js';
import type { WebhookMessage } from './contextWebhookProtocol.mjs';
import { WebhookError } from './contextWebhookProtocol.mjs';

export const webhookBindingSchema = z.object({
  kind: z.enum(['conversation', 'assistant']), sessionId: z.string().min(1).max(220), title: z.string().max(300),
  parent: runtimeSessionTurnRequestSchema, profile: assistantProfileSchema.optional(), generation: z.number().int().nonnegative().optional(),
}).strict().refine(value => value.parent.sessionId === value.sessionId && (value.kind === 'assistant'
  ? value.sessionId === 'personal-assistant' && Boolean(value.profile) && value.generation !== undefined : value.sessionId !== 'personal-assistant'));
export type WebhookResult = { status: 'completed' | 'failed' | 'interrupted' | 'stopped'; reply: string; errorCode?: string };
export type WebhookRuntime = { command(kind: string, payload: unknown): Promise<any> };

export function contextWebhookTurnResult(state: SessionSnapshot, turnId: string): WebhookResult | undefined {
  const turn = state.turns.find(turn => turn.turnId === turnId);
  if (!turn) return;
  const authored = turn.messages.filter(entry => entry.message.role === 'assistant' && !entry.message.toolCalls.length);
  const explicit = authored.filter(entry => entry.metadata?.transcript_kind === 'assistant_final');
  const finals = explicit.length ? explicit : authored.slice(-1);
  return { status: turn.status === 'completed' ? 'completed' : turn.status === 'stopped' ? 'stopped' : 'failed',
    reply: finals.map(entry => entry.message.content).join('\n\n'), ...(turn.status === 'completed' ? {} : { errorCode: 'turn_failed' }) };
}

/** Uses the bound desktop identity. The external request never supplies policy, model or session. */
export async function runContextWebhook(runtime: WebhookRuntime, binding: WebhookBinding, message: WebhookMessage,
  id: string, recovering: boolean, signal: AbortSignal, sourceRef?: string): Promise<WebhookResult> {
  const sessionId = binding.sessionId, turnId = `webhook-${id}`, inputId = `webhook-input-${id}`;
  const snapshot = await runtime.command('runtime.get_session', { sessionId }) as SessionSnapshot | null;
  if (!snapshot) throw new WebhookError('context_deleted', 404);
  const parent = structuredClone(binding.parent);
  parent.requestId = turnId; parent.turnId = turnId;
  delete parent.metadata.botSourceRef;
  if (sourceRef) parent.metadata.botSourceRef = sourceRef;
  const createdAt = new Date().toISOString();
  parent.inputMessages = [{ messageId: `${inputId}:turn-context`, createdAt,
    message: { role: 'user', name: 'turn_runtime_context', visibility: 'internal', content: createTurnTimeContext({ createdAt }) } },
    { messageId: inputId, createdAt, message: { role: 'user', content: message.text },
    metadata: { externalMessage: { messageId: message.messageId, senderId: message.senderId, conversationId: message.conversationId } } }];
  delete parent.supersession;
  if (binding.kind === 'assistant') {
    const read = () => runtime.command('runtime.assistant_conversation', { action: 'read', sessionId });
    let journal = await read();
    if (journal.generation !== binding.generation) throw new WebhookError('context_reset', 409);
    if (!journal.entries.some((entry: { id: string }) => entry.id === inputId)) {
      if (recovering) return { status: 'interrupted', reply: '', errorCode: 'submission_unknown' };
      await runtime.command('runtime.assistant_conversation', { action: 'turn', sessionId, generation: binding.generation,
        profile: binding.profile, parent: { ...parent, metadata: { ...parent.metadata, assistantOutputMode: 'text' } },
        entry: { id: inputId, originTurnId: turnId, role: 'user', source: 'text', visibility: 'conversation', content: message.text, createdAt,
          ...(sourceRef ? { botSourceRef: sourceRef } : {}) } });
    }
    for (;;) {
      signal.throwIfAborted(); journal = await read();
      if (journal.generation !== binding.generation) throw new WebhookError('context_reset', 409);
      const replies = journal.entries.filter((entry: { role: string; visibility: string; responseTo?: string[] }) =>
        entry.role === 'assistant' && entry.visibility === 'conversation' && entry.responseTo?.includes(inputId));
      if (!journal.busy) {
        const reply = replies.map((entry: { content: string }) => entry.content).join('\n\n');
        return journal.error ? { status: 'failed', reply, errorCode: 'assistant_failed' }
          : replies.length ? { status: 'completed', reply } : { status: 'interrupted', reply, errorCode: 'response_unavailable' };
      }
      await delay(500, undefined, { signal });
    }
  }
  const resultFrom = (state: SessionSnapshot) => contextWebhookTurnResult(state, turnId);
  const existing = resultFrom(snapshot); if (existing) return existing;
  if (recovering) return { status: 'interrupted', reply: '', errorCode: 'submission_unknown' };
  await runtime.command('runtime.run_session_turn', parent);
  const finished = await runtime.command('runtime.get_session', { sessionId }) as SessionSnapshot | null;
  return finished && resultFrom(finished) || { status: 'interrupted', reply: '', errorCode: 'response_unavailable' };
}
