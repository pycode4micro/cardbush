import { FRIENDS_SESSION, PERSONAL_ASSISTANT_SESSION, applyWebhookTurnPolicy, createTurnTimeContext, runtimeSessionTurnRequestSchema, runtimeProviderBindingRefSchema, assistantProfileSchema, type SessionSnapshot, type RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { StoredWebhookBinding } from './contextWebhookTypes.js';
import type { WebhookMessage } from './contextWebhookProtocol.mjs';
import { WebhookError, webhookHash } from './contextWebhookProtocol.mjs';

const bindingFields = { title: z.string().max(300), parent: runtimeSessionTurnRequestSchema };
export const webhookBindingSchema = z.object({
  ...bindingFields, kind: z.literal('assistant'), sessionId: z.literal(PERSONAL_ASSISTANT_SESSION),
  profile: assistantProfileSchema, generation: z.number().int().nonnegative(),
}).strict().refine(value => value.parent.sessionId === value.sessionId);

export const storedWebhookBindingSchema = z.union([
  webhookBindingSchema,
  z.object({ ...bindingFields, kind: z.literal('conversation'), sessionId: z.string().min(1).max(220),
    profile: assistantProfileSchema.optional(), generation: z.number().int().nonnegative().optional(),
  }).strict().refine(value => value.parent.sessionId === value.sessionId && value.sessionId !== PERSONAL_ASSISTANT_SESSION && value.sessionId !== FRIENDS_SESSION),
  z.object({ kind: z.literal('friends'), sessionId: z.literal(FRIENDS_SESSION), title: bindingFields.title }).strict(),
]);
export type WebhookResult = { status: 'completed' | 'failed' | 'interrupted' | 'stopped'; reply: string; errorCode?: string };
export type WebhookRuntime = { command(kind: string, payload: unknown): Promise<any>;
  prepareParent?(parent: RuntimeSessionTurnRequest, signal: AbortSignal): Promise<RuntimeSessionTurnRequest> };

/** Saved connections keep model identities, not a live worker's credential registry. */
export async function prepareWebhookParentModels(parent: RuntimeSessionTurnRequest,
  resolve: (modelId: string) => Promise<unknown>, signal: AbortSignal): Promise<RuntimeSessionTurnRequest> {
  const result = structuredClone(parent), resolved = new Map<string, Promise<{ model: string; binding: import('@cardbush/bush-protocol').RuntimeProviderBindingRef }>>();
  const model = (id: string) => {
    signal.throwIfAborted();
    if (!resolved.has(id)) resolved.set(id, resolve(id).then(value => z.object({ model: z.string().min(1), binding: runtimeProviderBindingRefSchema }).parse(value)));
    return resolved.get(id)!;
  };
  if (parent.providerBinding) {
    const current = await model(parent.providerBinding.bindingId);
    result.model = current.model; result.providerBinding = current.binding;
  }
  const policy = result.metadata.childAgentPolicy as { model?: { mode?: string; modelId?: string; providerBinding?: { bindingId: string }; model?: string } } | undefined;
  if (policy?.model?.mode === 'fixed') {
    const id = policy.model.modelId || policy.model.providerBinding?.bindingId;
    if (id) { const current = await model(id); policy.model.model = current.model; policy.model.providerBinding = current.binding; }
  }
  signal.throwIfAborted(); return result;
}

/** Uses the bound desktop identity. The external request never supplies policy, model or session. */
export async function runContextWebhook(runtime: WebhookRuntime, binding: StoredWebhookBinding, message: WebhookMessage,
  id: string, recovering: boolean, signal: AbortSignal, sourceRef?: string, origin?: { connectionId: string; createdAt: string }): Promise<WebhookResult> {
  if (binding.kind !== 'assistant' || binding.sessionId !== PERSONAL_ASSISTANT_SESSION || binding.parent.sessionId !== PERSONAL_ASSISTANT_SESSION)
    throw new WebhookError('assistant_only', 403);
  const sessionId = binding.sessionId, turnId = `webhook-${id}`, inputId = `webhook-input-${id}`;
  const snapshot = await runtime.command('runtime.get_session', { sessionId }) as SessionSnapshot | null;
  if (!snapshot) throw new WebhookError('context_deleted', 404);
  const recipientKey = origin && message.senderId && message.conversationId ? webhookHash([origin.connectionId, message.senderId, message.conversationId]) : undefined;
  let parent = applyWebhookTurnPolicy(structuredClone(binding.parent));
  parent.requestId = turnId; parent.turnId = turnId;
  delete parent.metadata.botSourceRef;
  if (sourceRef) parent.metadata.botSourceRef = sourceRef;
  const createdAt = new Date().toISOString();
  parent.inputMessages = [{ messageId: `${inputId}:turn-context`, createdAt,
    message: { role: 'user', name: 'turn_runtime_context', visibility: 'internal', content: createTurnTimeContext({ createdAt }) } },
    { messageId: inputId, createdAt, message: { role: 'user', content: message.text },
    metadata: { externalMessage: { messageId: message.messageId, senderId: message.senderId, conversationId: message.conversationId } } }];
  delete parent.supersession;
  const read = () => runtime.command('runtime.assistant_conversation', { action: 'read', sessionId });
  let journal = await read();
  if (journal.generation !== binding.generation) throw new WebhookError('context_reset', 409);
  if (!journal.entries.some((entry: { id: string }) => entry.id === inputId)) {
    if (recovering) return { status: 'interrupted', reply: '', errorCode: 'submission_unknown' };
    parent = applyWebhookTurnPolicy(await runtime.prepareParent?.(parent, signal) ?? parent);
    await runtime.command('runtime.assistant_conversation', { action: 'turn', sessionId, generation: binding.generation,
      profile: binding.profile, parent: { ...parent, metadata: { ...parent.metadata, assistantOutputMode: 'text' } },
      entry: { id: inputId, originTurnId: turnId, role: 'user', source: 'text', visibility: 'conversation', content: message.text, createdAt,
        ...(sourceRef ? { botSourceRef: sourceRef } : {}), ...(recipientKey ? { botRecipientKey: recipientKey } : {}) } });
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
