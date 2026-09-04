import type {
  RuntimePermissionAnswer,
  RuntimePermissionRequest,
  RuntimeStopReceipt,
} from '@cardbush/bush-protocol';

import type { PendingInteraction } from '../types';

interface RuntimePermissionEntry {
  interaction: PendingInteraction;
  requestedCapabilityIds: string[];
  answer: (answer: RuntimePermissionAnswer) => Promise<unknown>;
}

const permissions = new Map<string, RuntimePermissionEntry>();
const activeTurns = new Map<string, {
  sessionId: string;
  stop: () => Promise<RuntimeStopReceipt>;
}>();

export function registerRuntimePermission(input: {
  permissionId: string;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  request: RuntimePermissionRequest;
  sourceSessionId?: string;
  sourceTurnId?: string;
  parentSessionId?: string;
  parentTurnId?: string;
  subagentTaskId?: string;
  permissionRouting?: 'user' | 'parent';
  answer: RuntimePermissionEntry['answer'];
}): PendingInteraction {
  const fromSubagent = Boolean(input.sourceSessionId && input.sourceSessionId !== input.sessionId);
  const interaction: PendingInteraction = {
    id: input.permissionId,
    type: 'path_permission_request',
    sessionId: input.sessionId,
    turnId: input.turnId,
    title: fromSubagent ? 'Subagent permission' : 'Permission',
    reason: input.request.reason,
    toolName: 'request_permission',
    runtimePermission: structuredClone(input.request),
    questions: [{
      id: 'permission',
      label: 'Permission',
      question: 'Allow this exact access request?',
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'allow_session', label: 'Allow for this session' },
        { id: 'deny', label: 'Deny' },
      ],
    }],
    raw: {
      protocol: 'bush.runtime_permission_answer.v1',
      permissionId: input.permissionId,
      requestedCapabilityIds: [...input.request.requestedCapabilityIds],
      sourceSessionId: input.sourceSessionId,
      sourceTurnId: input.sourceTurnId,
      parentSessionId: input.parentSessionId,
      parentTurnId: input.parentTurnId,
      subagentTaskId: input.subagentTaskId,
      permissionRouting: input.permissionRouting,
    },
  };
  permissions.set(input.permissionId, {
    interaction,
    requestedCapabilityIds: [...input.request.requestedCapabilityIds],
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
  if (!entry) throw interactionNotPendingError(
    'permission_not_pending',
    `Runtime permission ${interactionId} is not pending.`,
  );
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

function interactionNotPendingError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
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
