import type {
  RuntimeInteraction,
  RuntimeInteractionAnswer,
  RuntimePermissionAnswer,
  RuntimeStopReceipt,
} from '@cardbush/bush-protocol';

import type { PendingInteraction } from '../types';

interface RuntimePermissionEntry {
  interaction: PendingInteraction;
  requestedCapabilityIds: string[];
  answer: (answer: RuntimePermissionAnswer) => Promise<unknown>;
}

const permissions = new Map<string, RuntimePermissionEntry>();
const genericInteractions = new Map<string, {
  interaction: PendingInteraction;
  answer: (answer: RuntimeInteractionAnswer) => Promise<unknown>;
}>();
const activeTurns = new Map<string, {
  sessionId: string;
  stop: () => Promise<RuntimeStopReceipt>;
}>();

export function registerRuntimePermission(input: {
  permissionId: string;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  reason: string;
  actions: string[];
  resources: string[];
  requestedCapabilityIds: string[];
  answer: RuntimePermissionEntry['answer'];
}): PendingInteraction {
  const interaction: PendingInteraction = {
    id: input.permissionId,
    type: 'path_permission_request',
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: 'Permission',
    reason: input.reason,
    message: input.reason,
    submitLabel: 'Continue',
    cancelLabel: 'Deny',
    replyMode: 'single',
    toolName: 'request_permission',
    permissionPreview: {
      actions: [...input.actions],
      resources: [...input.resources],
      reason: input.reason,
      toolCallId: input.toolCallId,
    },
    questions: [{
      id: 'permission',
      label: 'Permission',
      question: 'Allow this exact access request?',
      selectionMode: 'single',
      needInput: false,
      required: true,
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'allow_session', label: 'Allow for this session' },
        { id: 'deny', label: 'Deny' },
      ],
    }],
    raw: {
      protocol: 'bush.runtime_permission_answer.v1',
      permissionId: input.permissionId,
      requestedCapabilityIds: [...input.requestedCapabilityIds],
    },
  };
  permissions.set(input.permissionId, {
    interaction,
    requestedCapabilityIds: [...input.requestedCapabilityIds],
    answer: input.answer,
  });
  return interaction;
}

export function pendingRuntimeInteraction(sessionId: string): PendingInteraction | null {
  const entry = [...permissions.values()].find(
    ({ interaction }) => interaction.sessionId === sessionId,
  );
  if (entry) return structuredClone(entry.interaction);
  const generic = [...genericInteractions.values()].find(
    ({ interaction }) => interaction.sessionId === sessionId,
  );
  return generic ? structuredClone(generic.interaction) : null;
}

export function hasRuntimeInteraction(interactionId: string): boolean {
  return permissions.has(interactionId) || genericInteractions.has(interactionId);
}

export function hasRuntimeGenericInteraction(interactionId: string): boolean {
  return genericInteractions.has(interactionId);
}

export function registerRuntimeGenericInteraction(
  input: RuntimeInteraction,
  answer: (answer: RuntimeInteractionAnswer) => Promise<unknown>,
): PendingInteraction {
  const interaction: PendingInteraction = {
    id: input.interactionId,
    type: 'user_choice',
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: input.title,
    reason: input.reason,
    message: input.reason,
    description: input.description,
    submitLabel: input.submitLabel,
    cancelLabel: input.cancelLabel,
    replyMode: 'structured',
    toolName: 'request_user_choice',
    questions: input.questions,
    raw: input,
  };
  genericInteractions.set(input.interactionId, { interaction, answer });
  return structuredClone(interaction);
}

export async function answerRuntimeGenericInteraction(
  interactionId: string,
  input: Omit<RuntimeInteractionAnswer, 'protocol' | 'interactionId' | 'answerId'>,
): Promise<void> {
  const entry = genericInteractions.get(interactionId);
  if (!entry) throw new Error(`Runtime interaction ${interactionId} is not pending.`);
  await entry.answer({
    protocol: 'bush.runtime_interaction.v1',
    interactionId,
    answerId: `runtime_answer_${crypto.randomUUID()}`,
    ...input,
  });
  genericInteractions.delete(interactionId);
}

export function removeRuntimeGenericInteraction(interactionId: string): void {
  genericInteractions.delete(interactionId);
}

export async function answerRuntimeInteraction(
  interactionId: string,
  decision: 'allow_once' | 'allow_session' | 'deny' | 'cancel',
): Promise<void> {
  const entry = permissions.get(interactionId);
  if (!entry) throw new Error(`Runtime permission ${interactionId} is not pending.`);
  const answer: RuntimePermissionAnswer = {
    protocol: 'bush.runtime_permission_answer.v1',
    permissionId: interactionId,
    answerId: `runtime_answer_${crypto.randomUUID()}`,
    decision,
    grantedCapabilityIds:
      decision === 'allow_once' || decision === 'allow_session'
        ? [...entry.requestedCapabilityIds]
        : [],
  };
  await entry.answer(answer);
  permissions.delete(interactionId);
}

export function removeRuntimePermission(permissionId: string): void {
  permissions.delete(permissionId);
}

export function removeRuntimePermissionsForTurn(turnId: string): void {
  for (const [permissionId, entry] of permissions) {
    if (entry.interaction.turnId === turnId) permissions.delete(permissionId);
  }
  for (const [interactionId, entry] of genericInteractions) {
    if (entry.interaction.turnId === turnId) genericInteractions.delete(interactionId);
  }
}

export function registerActiveRuntimeTurn(
  turnId: string,
  sessionId: string,
  stop: () => Promise<RuntimeStopReceipt>,
): () => void {
  activeTurns.set(turnId, { sessionId, stop });
  return () => activeTurns.delete(turnId);
}

export async function stopActiveRuntimeTurn(
  turnId: string,
): Promise<RuntimeStopReceipt | undefined> {
  const active = activeTurns.get(turnId);
  if (!active) return undefined;
  return active.stop();
}

export function hasActiveRuntimeTurn(sessionId: string, turnId?: string): boolean {
  const normalizedSessionId = sessionId.trim();
  const normalizedTurnId = turnId?.trim();
  return [...activeTurns.entries()].some(([activeTurnId, active]) =>
    active.sessionId === normalizedSessionId &&
    (!normalizedTurnId || activeTurnId === normalizedTurnId),
  );
}
