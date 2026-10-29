import { createHash } from 'node:crypto';
import type { RuntimeEvent, SubagentObservation, RemoteInteraction } from '@cardbush/bush-protocol';

type PermissionEvent = Extract<RuntimeEvent, { kind: 'permission_requested' }>;
type Authority = 'parent_delegate' | 'human_required';

/** Public progress and pending input only; never expose arguments, reasoning or raw tool results. */
export function projectSubagentObservation(
  identity: { contextId: string; taskId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' },
  events: RuntimeEvent[], authority: Authority | ((event: PermissionEvent) => Authority),
  routedPermissions: RuntimeEvent[] = [],
): SubagentObservation {
  const pending = new Map<string, RemoteInteraction>();
  const done = new Set<string>(), failed = new Set<string>();
  let phase = identity.status === 'queued' ? 'queued' : 'starting', text = '';
  for (const event of [...events, ...routedPermissions]) {
    switch (event.kind) {
      case 'provider_input_observed': phase = 'model'; break;
      case 'tool_queued': phase = 'tools'; break;
      case 'tool_returned': done.add(event.payload.toolCallId); if (event.payload.resultError) failed.add(event.payload.toolCallId); break;
      case 'tool_failed': case 'tool_cancelled': done.add(event.payload.toolCallId); failed.add(event.payload.toolCallId); break;
      case 'context_compaction_started': phase = 'compacting'; break;
      case 'context_compaction_completed': phase = 'model'; break;
      case 'solution_selection_requested': {
        const question = event.payload;
        if (question.questions) break;
        pending.set(question.selectionId, { kind: 'question', contextId: identity.contextId, taskId: identity.taskId,
          interactionId: question.selectionId, text: question.prompt!, suggestions: question.options ?? [],
          blocking: question.blocking === true, createdAt: question.createdAt });
        break;
      }
      case 'solution_selection_answered': case 'solution_selection_cancelled': pending.delete(event.payload.selectionId); break;
      case 'permission_requested': {
        const p = event.payload;
        pending.set(p.permissionId, { kind: 'permission', contextId: identity.contextId, taskId: identity.taskId, interactionId: p.permissionId,
          text: p.reason, actionDigest: permissionDigest(p), operations: p.actions, resources: p.targets.map(({ kind, value }) => ({ kind, value })),
          authority: typeof authority === 'function' ? authority(event) : authority, decisions: ['allow_once', 'deny'], createdAt: event.createdAt });
        break;
      }
      case 'permission_answered': case 'permission_rejected': case 'permission_cancelled': case 'permission_expired': pending.delete(event.payload.permissionId); break;
    }
  }
  const running = identity.status === 'running' || identity.status === 'queued';
  if (!running) pending.clear();
  if (pending.size) { phase = 'waiting'; text = [...pending.values()][0]!.text; }
  return { contextId: identity.contextId, taskId: identity.taskId, cursor: (events.at(-1)?.sequence ?? 0) + routedPermissions.length,
    state: pending.size ? 'input_required' : identity.status === 'running' ? 'working' : identity.status === 'stopped' ? 'canceled' : identity.status,
    progress: { phase: running ? phase : identity.status, text: text.slice(0, 1000), completedActions: done.size, failedActions: failed.size },
    interactions: [...pending.values()] };
}

export function permissionDigest(value: { reason: string; actions: string[]; targets: unknown[]; requestedCapabilityIds: string[]; scope?: unknown }): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify({ reason: value.reason, actions: value.actions,
    targets: value.targets, capabilities: value.requestedCapabilityIds, scope: value.scope })).digest('hex');
}
