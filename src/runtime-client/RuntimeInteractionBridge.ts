import type {
  RuntimePermissionAnswer,
  RuntimePermissionRequest,
  RuntimeStopReceipt,
  RuntimeSolutionSelection,
} from '@cardbush/bush-protocol';

import type { PendingInteraction } from '../types';

interface RuntimePermissionEntry {
  interaction: PendingInteraction;
  requestedCapabilityIds: string[];
  answer: (answer: RuntimePermissionAnswer) => Promise<unknown>;
}

/** Each connected host owns its interaction identities and answer routes. */
export function createRuntimeInteractions() {
  const permissions = new Map<string, RuntimePermissionEntry>();
  const solutions = new Map<string, PendingInteraction>();
  const listeners = new Set<(sessionId: string) => void>();
  const revisions = new Map<string, number>();
  const runtimeInteractionsRevision = (sessionId: string) => revisions.get(sessionId) ?? 0;
  const changed = (sessionId: string) => {
    revisions.set(sessionId, runtimeInteractionsRevision(sessionId) + 1);
    for (const listener of listeners) listener(sessionId);
  };

  function onRuntimeInteractionsChanged(listener: (sessionId: string) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function registerRuntimeSolution(request: RuntimeSolutionSelection, notify = true): PendingInteraction {
    const interaction: PendingInteraction = {
      id: request.selectionId, type: 'solution_selection', sessionId: request.sessionId, turnId: request.turnId,
      title: 'Solution Selection', toolName: 'solution_selection',
      questions: [{ id: 'solution', label: 'Solution Selection', question: request.prompt,
        options: request.options.map((label, index) => ({ id: String(index), label })) }], raw: { ...request },
    };
    solutions.set(request.selectionId, interaction);
    if (notify) changed(request.sessionId);
    return structuredClone(interaction);
  }

  function syncRuntimeSolutions(sessionId: string, requests: RuntimeSolutionSelection[]) {
    for (const [id, entry] of solutions) if (entry.sessionId === sessionId) solutions.delete(id);
    for (const request of requests) if (request.sessionId === sessionId) registerRuntimeSolution(request, false);
  }

  function runtimeSolution(interactionId: string): PendingInteraction | undefined {
    const entry = solutions.get(interactionId);
    return entry && structuredClone(entry);
  }

  function removeRuntimeSolution(id: string) {
    const entry = solutions.get(id);
    if (entry) { solutions.delete(id); changed(entry.sessionId!); }
  }
  const activeTurns = new Map<string, {
    stop: () => Promise<RuntimeStopReceipt>;
  }>();

  function registerRuntimePermission(input: {
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
    changed(input.sessionId);
    return interaction;
  }

  function pendingRuntimeInteraction(sessionId: string): PendingInteraction | null {
    const entry = [...permissions.values()].find(
      ({ interaction }) => interaction.sessionId === sessionId,
    );
    const solution = [...solutions.values()].find(entry => entry.sessionId === sessionId);
    return entry ? structuredClone(entry.interaction) : solution ? structuredClone(solution) : null;
  }

  function hasRuntimeInteraction(interactionId: string): boolean {
    return permissions.has(interactionId);
  }

  async function answerRuntimeInteraction(
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
    removeRuntimePermission(interactionId);
  }

  function interactionNotPendingError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
  }

  function removeRuntimePermission(permissionId: string): void {
    const entry = permissions.get(permissionId);
    if (entry) { permissions.delete(permissionId); changed(entry.interaction.sessionId!); }
  }

  function removeRuntimePermissionsForTurn(turnId: string): void {
    for (const [id, entry] of solutions) if (entry.turnId === turnId) removeRuntimeSolution(id);
    for (const [permissionId, entry] of permissions) {
      if (entry.interaction.turnId === turnId) removeRuntimePermission(permissionId);
    }
  }

  function registerActiveRuntimeTurn(
    turnId: string,
    stop: () => Promise<RuntimeStopReceipt>,
  ): () => void {
    activeTurns.set(turnId, { stop });
    return () => activeTurns.delete(turnId);
  }

  async function stopActiveRuntimeTurn(
    turnId: string,
  ): Promise<RuntimeStopReceipt | undefined> {
    const active = activeTurns.get(turnId);
    if (!active) return undefined;
    return active.stop();
  }

  return { runtimeInteractionsRevision, onRuntimeInteractionsChanged, registerRuntimeSolution, syncRuntimeSolutions, runtimeSolution, removeRuntimeSolution, registerRuntimePermission, pendingRuntimeInteraction, hasRuntimeInteraction, answerRuntimeInteraction, removeRuntimePermission, removeRuntimePermissionsForTurn, registerActiveRuntimeTurn, stopActiveRuntimeTurn };
}

export const defaultRuntimeInteractions = createRuntimeInteractions();
export type RuntimeInteractions = ReturnType<typeof createRuntimeInteractions>;
export const { runtimeInteractionsRevision, onRuntimeInteractionsChanged, registerRuntimeSolution, syncRuntimeSolutions, runtimeSolution, removeRuntimeSolution, registerRuntimePermission, pendingRuntimeInteraction, hasRuntimeInteraction, answerRuntimeInteraction, removeRuntimePermission, removeRuntimePermissionsForTurn, registerActiveRuntimeTurn, stopActiveRuntimeTurn } = defaultRuntimeInteractions;
