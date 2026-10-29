import { subagentControlSchema, remoteObservationSchema, type SubagentControl,
  type SubagentTask, type SubagentInteractionCapabilities } from '@cardbush/bush-protocol';
import { assertParentAgent } from './childAgentPolicy.js';
import type { ToolHandlerContext } from './toolRegistry.js';
import type { SubagentTaskStore } from './subagentTaskStore.js';

export interface SubagentInteractionAdapter {
  capabilities: SubagentInteractionCapabilities;
  control(task: SubagentTask, control: SubagentControl, context: ToolHandlerContext<unknown>): Promise<unknown>;
}

/** One ownership/admission boundary. Each adapter retains its own execution and authority. */
export class SubagentInteractions {
  readonly #receipts = new Map<string, { input: string; result: Promise<unknown> }>();
  constructor(private readonly tasks: SubagentTaskStore,
    private readonly adapter: (task: SubagentTask) => SubagentInteractionAdapter,
    private readonly queue: (task: SubagentTask, text: string, context: ToolHandlerContext<unknown>) => Promise<unknown>) {}

  capabilities(task: SubagentTask): SubagentInteractionCapabilities { return this.adapter(task).capabilities; }

  async control(context: ToolHandlerContext<unknown>, value: SubagentControl): Promise<unknown> {
    assertParentAgent(context.turn?.request);
    context.signal?.throwIfAborted();
    const control = subagentControlSchema.parse(value);
    const task = this.tasks.get(context.sessionId, control.taskId);
    if (!task || task.childSessionId !== control.contextId) throw new Error('This child task does not belong to the current parent conversation.');
    if (context.turn?.request.metadata.toolExecutionPolicy === 'web_restricted' && !task.remote) throw new Error('Local child interaction is forbidden in this deployment.');
    const adapter = this.adapter(task), operation = control.operation === 'message' ? control.delivery : control.operation;
    if (!adapter.capabilities.operations.includes(operation)) throw new Error(`Child interaction ${operation} is unavailable on this host.`);
    const invoke = async () => control.operation === 'message' && control.delivery === 'queue'
      ? this.queue(task, control.text, context) : adapter.control(task, control, context);
    if (control.operation === 'observe') {
      const observation = remoteObservationSchema.parse(await invoke());
      if (observation.contextId !== task.childSessionId || observation.taskId !== task.taskId) throw new Error('Child observation identity mismatch.');
      this.tasks.observe(context.sessionId, task.taskId, observation);
      return observation;
    }
    const key = JSON.stringify([context.sessionId, control.contextId, control.messageId]);
    const input = JSON.stringify(control), previous = this.#receipts.get(key);
    if (previous && previous.input !== input) throw new Error('idempotency_conflict');
    // A stop always reconciles current state, including an earlier uncertain stop.
    if (control.operation === 'cancel') {
      const result = Promise.resolve().then(invoke);
      if (!previous && this.#receipts.size < 10_000) this.#receipts.set(key, { input, result });
      return result;
    }
    if (previous) return previous.result;
    if (this.#receipts.size >= 10_000) throw new Error('Child interaction receipt capacity reached. Observe and stop remain available.');
    const result = Promise.resolve().then(invoke);
    this.#receipts.set(key, { input, result });
    return result;
  }
}

export function observationControl(task: SubagentTask, after?: number, waitMs = 0): SubagentControl {
  return { profile: 'subagent-remote-proton', version: '0.1', contextId: task.childSessionId, taskId: task.taskId,
    operation: 'observe', after, waitMs };
}

export function queuedChild(task: SubagentTask): boolean { return Boolean(task.queuedAfterTaskId && !task.executionStartedAt && task.status === 'running'); }
