import type { RuntimePermissionAnswer } from '@cardbush/bush-protocol';

import type { PendingInteraction } from '../types';

interface RuntimePermissionEntry {
  interaction: PendingInteraction;
  requestedCapabilityIds: string[];
  answer: (answer: RuntimePermissionAnswer) => Promise<unknown>;
}

const permissions = new Map<string, RuntimePermissionEntry>();
const activeTurns = new Map<string, { sessionId: string; stop: () => void }>();

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
  return entry ? structuredClone(entry.interaction) : null;
}

export function hasRuntimeInteraction(interactionId: string): boolean {
  return permissions.has(interactionId);
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
}

export function registerActiveRuntimeTurn(
  turnId: string,
  sessionId: string,
  stop: () => void,
): () => void {
  activeTurns.set(turnId, { sessionId, stop });
  return () => activeTurns.delete(turnId);
}

export function stopActiveRuntimeTurn(turnId: string): boolean {
  const active = activeTurns.get(turnId);
  if (!active) return false;
  active.stop();
  return true;
}
