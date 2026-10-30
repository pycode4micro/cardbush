import { z } from 'zod';

/** Tool-independent interaction vocabulary. Transport authentication stays outside the body. */
export const SUBAGENT_REMOTE_PROFILE = 'subagent-remote-proton' as const;
export const SUBAGENT_REMOTE_VERSION = '0.1' as const;
export const SUBAGENT_INTERACTION_OPERATIONS = ['observe', 'queue', 'insert', 'respond', 'cancel'] as const;
export const subagentInteractionCapabilitiesSchema = z.object({
  operations: z.array(z.enum(SUBAGENT_INTERACTION_OPERATIONS)).max(5),
}).strict();
export type SubagentInteractionCapabilities = z.infer<typeof subagentInteractionCapabilitiesSchema>;
/** Version numbers alone do not identify a compatible interaction profile. */
export function supportsRemoteInteraction(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const capability = value as Record<string, unknown>;
  return capability.profile === SUBAGENT_REMOTE_PROFILE && capability.version === SUBAGENT_REMOTE_VERSION &&
    (capability.operations === undefined || subagentInteractionCapabilitiesSchema.safeParse({ operations: capability.operations }).success);
}
const id = z.string().trim().min(1).max(160);
const text = z.string().trim().min(1).max(16_000);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identity = { contextId: id, taskId: id };
export const remoteInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ ...identity, interactionId: id, kind: z.literal('question'), text,
    suggestions: z.array(z.string().min(1).max(500)).max(8).default([]), blocking: z.boolean(),
    createdAt: z.string().datetime(), expiresAt: z.string().datetime().optional() }).strict(),
  z.object({ ...identity, interactionId: id, kind: z.literal('permission'), text, actionDigest: digest,
    operations: z.array(id).min(1).max(64), resources: z.array(z.object({ kind: id, value: text }).strict()).min(1).max(64),
    authority: z.enum(['parent_delegate', 'human_required']),
    escalationReason: z.enum(['remote_policy_requires_human']).optional(),
    decisions: z.array(z.enum(['allow_once', 'deny'])).min(1).max(2),
    createdAt: z.string().datetime(), expiresAt: z.string().datetime().optional() }).strict(),
]);
export type RemoteInteraction = z.infer<typeof remoteInteractionSchema>;

export const remoteResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), interactionId: id, text }).strict(),
  z.object({ kind: z.literal('permission'), interactionId: id, actionDigest: digest,
    decision: z.enum(['allow_once', 'deny']) }).strict(),
]);
export type RemoteResponse = z.infer<typeof remoteResponseSchema>;

const envelope = { profile: z.literal(SUBAGENT_REMOTE_PROFILE), version: z.literal(SUBAGENT_REMOTE_VERSION), ...identity };
/** Method concepts, not tool names. Unsupported capabilities must fail, never downgrade. */
export const remoteControlSchema = z.discriminatedUnion('operation', [
  z.object({ ...envelope, operation: z.literal('observe'), after: z.number().int().nonnegative().optional(),
    waitMs: z.number().int().min(0).max(30_000).default(0) }).strict(),
  z.object({ ...envelope, operation: z.literal('message'), messageId: id,
    delivery: z.enum(['queue', 'insert']), text }).strict(),
  z.object({ ...envelope, operation: z.literal('respond'), messageId: id, response: remoteResponseSchema }).strict(),
  z.object({ ...envelope, operation: z.literal('cancel'), messageId: id }).strict(),
]);
export type RemoteControl = z.infer<typeof remoteControlSchema>;
// Local and remote adapters share one contract; retain the wire-facing names.
export const subagentControlSchema = remoteControlSchema;
export type SubagentControl = RemoteControl;
export const remoteObservationSchema = z.object({
  ...identity, cursor: z.number().int().nonnegative(),
  state: z.enum(['queued', 'working', 'input_required', 'completed', 'failed', 'canceled', 'interrupted']),
  progress: z.object({ phase: z.string().min(1).max(80), text: z.string().max(1000),
    completedActions: z.number().int().nonnegative(), failedActions: z.number().int().nonnegative() }).strict(),
  interactions: z.array(remoteInteractionSchema).max(64),
}).strict();
export type RemoteObservation = z.infer<typeof remoteObservationSchema>;
export type SubagentObservation = RemoteObservation;
export type SubagentResponse = RemoteResponse;

/** Never treat prose as approval. Authority is authenticated host context, not caller input. */
export function validateRemoteResponse(interaction: RemoteInteraction, response: RemoteResponse,
  authority: 'parent_delegate' | 'human', now = Date.now()): void {
  remoteInteractionSchema.parse(interaction); remoteResponseSchema.parse(response);
  if (interaction.interactionId !== response.interactionId) throw new Error('interaction_mismatch');
  if (interaction.expiresAt && Date.parse(interaction.expiresAt) <= now) throw new Error('interaction_expired');
  if (interaction.kind === 'question') {
    if (response.kind !== 'answer') throw new Error('response_kind_mismatch');
    return;
  }
  if (response.kind !== 'permission') throw new Error('structured_permission_required');
  if (interaction.actionDigest !== response.actionDigest) throw new Error('action_changed');
  if (!interaction.decisions.includes(response.decision)) throw new Error('decision_unavailable');
  if (response.decision === 'allow_once' && interaction.authority === 'human_required' && authority !== 'human') throw new Error('human_authority_required');
}
