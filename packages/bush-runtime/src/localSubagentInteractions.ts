import { setTimeout as delay } from 'node:timers/promises';
import { validateRemoteResponse, type SubagentTask, type SubagentControl, type RuntimeEvent,
  type RuntimePermissionAnswer } from '@cardbush/bush-protocol';
import { projectSubagentObservation } from './subagentObservation.js';
import { queuedChild } from './subagentInteractions.js';
import type { InMemoryRuntimeEventLog } from './runtimeEventLog.js';
import type { SubagentTaskStore } from './subagentTaskStore.js';

/** Adapts the existing local journals and brokers, without a second loop or permission store. */
export class LocalSubagentInteractions {
  constructor(private readonly tasks: SubagentTaskStore, private readonly events: InMemoryRuntimeEventLog,
    private readonly host: {
      answerQuestion(session: string, turn: string, id: string, text: string): unknown;
      answerPermission(answer: RuntimePermissionAnswer): unknown;
      hasPermission(session: string, turn: string, id: string): boolean;
      stop(session: string, turn: string): Promise<unknown>;
    }) {}

  #streams(task: SubagentTask) {
    const child = this.events.replay(task.childSessionId, task.childTurnId);
    const parent = this.events.replay(task.parentSessionId, task.parentTurnId);
    // Child approvals can be routed to the parent journal. Never include sibling or parent approvals.
    const permissions = parent.filter(event => event.kind.startsWith('permission_') &&
      'sourceSessionId' in event.payload && event.payload.sourceSessionId === task.childSessionId &&
      'sourceTurnId' in event.payload && event.payload.sourceTurnId === task.childTurnId);
    return { child, parent, permissions };
  }

  snapshot(task: SubagentTask) {
    const { child, permissions } = this.#streams(task);
    return projectSubagentObservation({ contextId: task.childSessionId, taskId: task.taskId,
      status: queuedChild(task) ? 'queued' : task.status === 'unavailable' ? 'interrupted' : task.status }, child,
      event => event.payload.permissionRouting === 'parent' ? 'parent_delegate' : 'human_required', permissions);
  }

  async control(task: SubagentTask, control: SubagentControl, signal?: AbortSignal): Promise<unknown> {
    if (control.operation === 'observe') {
      const snapshot = this.snapshot(task);
      if ((control.after ?? 0) > snapshot.cursor) throw new Error('invalid_cursor');
      if (task.status === 'running' && control.waitMs && control.after === snapshot.cursor) {
        const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const { child, parent } = this.#streams(task);
        const next = async (session: string, turn: string, events: RuntimeEvent[], filter?: (event: RuntimeEvent) => boolean) => {
          for await (const event of this.events.subscribe(session, turn, { afterSequence: events.at(-1)?.sequence ?? 0 }, combined)) {
            if (!filter || filter(event)) return;
          }
        };
        try {
          await Promise.race([
            delay(control.waitMs, undefined, { signal: combined }),
            this.tasks.waitForChange(task.parentSessionId, task.taskId, task.revision, combined),
            ...(child.at(-1)?.kind === 'turn_terminal' ? [] : [next(task.childSessionId, task.childTurnId, child)]),
            ...(parent.at(-1)?.kind === 'turn_terminal' ? [] : [next(task.parentSessionId, task.parentTurnId, parent,
              event => event.kind.startsWith('permission_') && 'sourceSessionId' in event.payload && event.payload.sourceSessionId === task.childSessionId &&
                'sourceTurnId' in event.payload && event.payload.sourceTurnId === task.childTurnId)]),
          ]);
        } finally { controller.abort(); }
        signal?.throwIfAborted();
      }
      return this.snapshot(this.tasks.get(task.parentSessionId, task.taskId)!);
    }
    if (control.operation === 'cancel') return this.host.stop(task.childSessionId, task.childTurnId);
    if (control.operation !== 'respond') throw new Error('unsupported_operation');
    const interaction = this.snapshot(task).interactions.find(item => item.interactionId === control.response.interactionId);
    if (!interaction) throw new Error('interaction_not_pending');
    validateRemoteResponse(interaction, control.response, 'parent_delegate');
    if (control.response.kind === 'answer') return this.host.answerQuestion(task.childSessionId, task.childTurnId,
      control.response.interactionId, control.response.text);
    const { child, permissions } = this.#streams(task);
    const request = [...child, ...permissions].find(event => event.kind === 'permission_requested' && event.payload.permissionId === control.response.interactionId);
    if (!request || request.kind !== 'permission_requested' || !this.host.hasPermission(task.childSessionId, task.childTurnId, request.payload.permissionId)) throw new Error('interaction_not_pending');
    return this.host.answerPermission({ protocol: 'bush.runtime_permission_answer.v1', permissionId: request.payload.permissionId,
      answerId: control.messageId, decision: control.response.decision,
      grantedCapabilityIds: control.response.decision === 'allow_once' ? request.payload.requestedCapabilityIds : [] });
  }
}
