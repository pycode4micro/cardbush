import { ASSISTANT_MANAGEMENT_TOOLS, PERSONAL_ASSISTANT_SESSION, type AssistantManagementSnapshot, type ModelRequest,
  type RuntimeSessionTurnRequest, type RuntimePermissionAnswer, type ToolCall } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { ToolExecutionCoordinator, type RuntimeCapabilityStore, type ToolExecutionIdentity, type ToolExecutionHooks } from './toolExecutionCoordinator.js';
import { RuntimePermissionBroker } from './runtimePermissionBroker.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';
import type { CoordinationStore } from './coordinationStore.js';
import type { AutomationScheduler } from './automationScheduler.js';
import { projectMcpDiscoveryResult } from './mcpToolDiscovery.js';

const allowed = new Set<string>(ASSISTANT_MANAGEMENT_TOOLS);

/** Uses the ordinary validators, permission grants and receipts, without a child or a second scheduler. */
export class AssistantManagement {
  private pending = new Map<string, AssistantManagementSnapshot['permissions'][number]>();
  private identities = new Map<string, ToolExecutionIdentity>();
  private permissions: RuntimePermissionBroker;
  constructor(private options: {
    registry: ToolRegistry; executions: ToolExecutionStore; capabilities: RuntimeCapabilityStore;
    coordination: () => CoordinationStore; automation?: AutomationScheduler;
    hooks?: (request: ModelRequest) => ToolExecutionHooks;
  }) {
    this.permissions = new RuntimePermissionBroker({
      onRequested: request => {
        const identity = this.identities.get(request.toolCallId)!;
        this.pending.set(request.permissionId, { permissionId: request.permissionId, toolCallId: request.toolCallId,
          sessionId: identity.sessionId, turnId: identity.turnId,
          request: { reason: request.reason, actions: request.actions, targets: request.targets,
            requestedCapabilityIds: request.capabilityIds, scope: request.scope } });
      },
      onAnswered: answer => { this.pending.delete(answer.permissionId); },
      onCancelled: request => { this.pending.delete(request.permissionId); },
    });
  }
  definitions(parent: RuntimeSessionTurnRequest) {
    if (parent.sessionId !== PERSONAL_ASSISTANT_SESSION || parent.metadata.agentRole === 'child' || parent.metadata.toolExecutionPolicy === 'none') return [];
    const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1', messages: [] };
    return this.options.registry.definitions().filter(tool => allowed.has(tool.name) && parent.tools.some(item => item.name === tool.name)
      && this.options.registry.resolve(tool.name)?.modelAvailable?.(request) !== false).map(tool => {
        if (tool.name === 'mcp_search') return { ...tool, description: 'Discover MCP tool names and summaries available on this Runtime for delegation. Start with query keywords or *; optionally narrow by server. Continue with next_cursor as cursor without query/server. Try alternate queries before concluding a capability is unavailable. This query executes no target and grants no permission. Delegate actual execution to a child; schema loading and generic invocation are not available in this assistant scope. Local results do not establish remote worker capabilities.' };
        if (tool.name === 'search_skills') return { ...tool, description: 'Discover installed Skills on this Runtime by capability or name; query=* lists visible Skills. Results include descriptions, mainResource and optional plugin invocation IDs. Continue with next_offset as offset and the same query. Use these facts to choose a child for execution; reading instructions and invoking Skills belong to that child. Local results do not establish remote worker capabilities.' };
        return tool;
      });
  }
  snapshot(): AssistantManagementSnapshot {
    return { plan: this.options.coordination().getPlan(PERSONAL_ASSISTANT_SESSION), permissions: [...this.pending.values()] };
  }
  hasPermission(id: string) { return this.permissions.pendingIds().includes(id); }
  answerPermission(answer: RuntimePermissionAnswer) { return this.permissions.answer(answer); }
  reset() { this.options.coordination().clearPlan(PERSONAL_ASSISTANT_SESSION); }
  async execute(call: ToolCall, parent: RuntimeSessionTurnRequest, request: ModelRequest, round: number, ordinal: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.definitions(parent).some(tool => tool.name === call.name)) throw Object.assign(Error('This tool is not available to the assistant.'), { code: 'tool_not_exposed' });
    // Catalog queries need the caller's actual execution capabilities, not just
    // the small conversational schema. No generic invocation tool is exposed.
    const executionRequest: ModelRequest = { ...request, tools: parent.tools, requestCapabilities: parent.requestCapabilities };
    if (call.name === 'schedule_task') {
      const action = JSON.parse(call.argumentsText).action;
      if (action === 'create' || action === 'update') {
        await this.options.automation?.remember(parent);
        signal.throwIfAborted();
      }
    }
    const identity = { requestId: request.requestId, sessionId: parent.sessionId, turnId: parent.turnId, round: round + 1, ordinal };
    this.identities.set(call.id, identity);
    try {
      const coordinator = new ToolExecutionCoordinator({ registry: this.options.registry, permissions: this.permissions, capabilities: this.options.capabilities,
        hooks: this.options.hooks?.(executionRequest), observer: { completed: (call, identity, result) => this.options.executions.record(call, identity, result) } });
      const outcome = await coordinator.execute(call, identity, signal, { request: executionRequest, contextMessages: request.messages, signal });
      this.options.executions.record(call, identity, outcome);
      signal.throwIfAborted();
      if (outcome.hookStopTurn) throw Object.assign(Error(outcome.hookStopTurn), { code: 'assistant_management_stopped' });
      if (outcome.rejectToolResult) throw Object.assign(Error(`The tool ran, but its result was withheld by policy. Do not repeat the action. ${outcome.hookFeedback ?? ''}`), { code: 'plugin_hook_result_blocked' });
      if (outcome.kind !== 'returned') throw Object.assign(Error(outcome.error.message), { code: outcome.error.code });
      // Page-aware tools keep continuation cursors instead of dumping catalogues.
      const rendered = this.options.registry.projectModelPage(call.name, outcome.result, 12000, call)
        ?? projectMcpDiscoveryResult(JSON.stringify(outcome.result), 12000);
      return rendered ? JSON.parse(rendered) : outcome.result;
    } finally { this.identities.delete(call.id); }
  }
}
