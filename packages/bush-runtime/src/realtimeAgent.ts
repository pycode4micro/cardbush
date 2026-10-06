import { BUSH_MODEL_REQUEST_PROTOCOL, BUSH_TOOL_CALL_PROTOCOL, modelRequestSchema,
  realtimeAgentToolRequestSchema, type RealtimeAgentToolRequest } from '@cardbush/bush-protocol';
import type { RuntimeSessionCoordinator } from './runtimeSessionCoordinator.js';
import type { SubagentTaskStore } from './subagentTaskStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import { ToolExecutionCoordinator } from './toolExecutionCoordinator.js';
import { childConversationPage, type ChildConversationSource } from './subagentConversation.js';
import { createHash } from 'node:crypto';

/** Runtime-owned delegation for a realtime parent, independent of the parent's text turn lock. */
export class RealtimeAgentDispatcher {
  private receipts = new Map<string, { fingerprint: string; result: Promise<unknown>; settled: boolean }>();
  constructor(private deps: {
    sessions: RuntimeSessionCoordinator; tasks: SubagentTaskStore; registry: ToolRegistry;
    read(sessionId: string): ChildConversationSource | undefined;
    remote?: import('./subagentTool.js').RemoteSubagentBridge;
  }) {}
  execute(value: unknown): Promise<unknown> {
    const input = realtimeAgentToolRequestSchema.parse(value);
    const key = JSON.stringify([input.sessionId, input.callId]);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = this.receipts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw Error('Realtime tool call ID was reused with different arguments.');
      return existing.result;
    }
    const entry = { fingerprint, result: Promise.resolve<unknown>(undefined), settled: false };
    entry.result = this.run(input).finally(() => { entry.settled = true; });
    this.receipts.set(key, entry);
    if (this.receipts.size > 512) for (const [id, old] of this.receipts) {
      if (old.settled && id !== key) this.receipts.delete(id);
      if (this.receipts.size <= 512) break;
    }
    return entry.result;
  }
  private async run(input: RealtimeAgentToolRequest): Promise<unknown> {
    const { sessions, tasks, registry } = this.deps;
    if (sessions.snapshot(input.sessionId)?.metadata?.agentRole === 'child') throw delegationError('realtime_parent_required', 'Only a parent conversation can delegate.');
    const task = input.taskId ? tasks.get(input.sessionId, input.taskId) : undefined;
    if ((input.taskId !== undefined || input.action === 'read_subagent_conversation') && (!task || task.origin !== 'subagent')) throw Error('This child does not belong to this parent conversation.');
    if (input.action === 'read_subagent_conversation') {
      const source = task!.remote ? await this.deps.remote?.read?.({ ...task!.remote, parentSessionId: input.sessionId, sessionId: task!.childSessionId }) : this.deps.read(task!.childSessionId);
      if (!source) return { status: 'starting', taskId: task!.taskId };
      return { taskId: task!.taskId, status: task!.status, ...childConversationPage(source, input.cursor) };
    }
    const parent = input.parent;
    if (!parent || parent.sessionId !== input.sessionId || !input.prompt) throw Error('A configured parent and prompt are required.');
    if (parent.metadata.agentRole === 'child') throw delegationError('realtime_parent_required', 'Only a parent conversation can delegate.');
    if (!parent.tools.some(tool => tool.name === 'subagent')) throw delegationError('realtime_subagent_disabled', 'Subagent delegation is disabled for this parent. Enable it in the conversation tool settings; a spoken confirmation does not change this setting.');
    const context = sessions.assemble({ sessionId: input.sessionId, prefix: parent.prefixMessages,
      current: parent.inputMessages.map(item => item.message) });
    const request = modelRequestSchema.parse({ ...parent, protocol: BUSH_MODEL_REQUEST_PROTOCOL, messages: context.messages });
    const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => {
      throw Error('Delegation cannot request extra permission; the child retains the configured execution policy.');
    } } });
    const outcome = await coordinator.execute({ protocol: BUSH_TOOL_CALL_PROTOCOL, id: input.callId, name: 'subagent',
      argumentsText: JSON.stringify(task ? { prompt: input.prompt, task_id: task.taskId, run_in_background: true }
        : input.targetAgent ? { prompt: input.prompt, target_agent: input.targetAgent }
        : { prompt: input.prompt, run_in_background: true }) },
      { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: 0 },
      undefined, { request, contextMessages: context.messages });
    if (outcome.kind !== 'returned') throw delegationError(outcome.error.code, outcome.error.message);
    return { ...(outcome.result as Record<string, unknown>), instructions: 'Request accepted; execution continues in the background. Continue the call. await_subagents registers a non-blocking result notification.' };
  }
}

function delegationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
