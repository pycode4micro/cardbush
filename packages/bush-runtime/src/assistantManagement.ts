import { ASSISTANT_MANAGEMENT_TOOLS, PERSONAL_ASSISTANT_SESSION, type AssistantManagementSnapshot, type ModelRequest,
  type RuntimeSessionTurnRequest, type RuntimePermissionAnswer, type ToolCall } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { ToolExecutionCoordinator, type RuntimeCapabilityStore, type ToolExecutionIdentity, type ToolExecutionHooks } from './toolExecutionCoordinator.js';
import { RuntimePermissionBroker } from './runtimePermissionBroker.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';
import type { CoordinationStore } from './coordinationStore.js';
import type { AutomationScheduler } from './automationScheduler.js';
import { projectMcpDiscoveryResult } from './mcpToolDiscovery.js';
import { presentExistingScheduleActions } from './extendedBuiltins.js';

const allowed = new Set<string>(ASSISTANT_MANAGEMENT_TOOLS);

/** Uses the ordinary validators, permission grants and receipts, without a child or a second scheduler. */
export class AssistantManagement {
  private pending = new Map<string, AssistantManagementSnapshot['permissions'][number]>();
  private identities = new Map<string, ToolExecutionIdentity>();
  private executions = new Map<string, string>();
  private permissions: RuntimePermissionBroker;
  constructor(private options: {
    registry: ToolRegistry; executions: ToolExecutionStore; capabilities: RuntimeCapabilityStore;
    coordination: () => CoordinationStore; automation?: AutomationScheduler;
    hooks?: (request: ModelRequest) => ToolExecutionHooks;
    onPermissionState?: (sessionId: string, executionId: string, waiting: boolean) => void;
  }) {
    this.permissions = new RuntimePermissionBroker({
      onRequested: request => {
        const identity = this.identities.get(request.toolCallId)!;
        this.pending.set(request.permissionId, { permissionId: request.permissionId, toolCallId: request.toolCallId,
          sessionId: identity.sessionId, turnId: identity.turnId,
          request: { reason: request.reason, actions: request.actions, targets: request.targets,
            requestedCapabilityIds: request.capabilityIds, scope: request.scope } });
        this.permissionState(identity, request.toolCallId);
      },
      onAnswered: answer => this.clearPermission(answer.permissionId),
      onCancelled: request => this.clearPermission(request.permissionId),
    });
  }
  private clearPermission(permissionId: string) {
    const pending = this.pending.get(permissionId);
    this.pending.delete(permissionId);
    if (pending) this.permissionState(pending, pending.toolCallId);
  }
  private permissionState(identity: { sessionId: string }, toolCallId: string) {
    const executionId = this.executions.get(toolCallId);
    if (executionId) this.options.onPermissionState?.(identity.sessionId, executionId,
      [...this.pending.values()].some(item => this.executions.get(item.toolCallId) === executionId));
  }
  definitions(parent: RuntimeSessionTurnRequest) {
    if (parent.sessionId !== PERSONAL_ASSISTANT_SESSION || parent.metadata.agentRole === 'child' || parent.metadata.toolExecutionPolicy === 'none') return [];
    const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1', messages: [] };
    const unified = parent.tools.some(tool => tool.name === 'search_plugins');
    const catalog = this.options.registry.definitions().filter(tool => allowed.has(tool.name));
    if (!unified) for (const name of ['mcp_search', 'search_skills']) {
      const previous = this.options.registry.resolve(name);
      if (previous) catalog.push(previous.definition);
    }
    return catalog.filter(tool => parent.tools.some(item => item.name === tool.name) &&
      this.options.registry.resolve(tool.name)?.modelAvailable?.(request) !== false).map(tool => {
        if (tool.name === 'search_plugins') return { ...tool, description: 'Discover MCP tools, Skills and local packages (bundled or user-installed) on this Runtime before delegation. Start with query, default mode=all. Narrow with mcp, skill or plugins. Use * to browse; pass a standby server ID in mcp mode or continue with cursor alone. Give the child the matched Skill mainResource or exact tool/package identity. The child reads instructions and executes on its own host.' };
        if (tool.name === 'mcp_search') return { ...tool, description: 'Discover MCP tool names and summaries available on this Runtime for delegation. Start with query keywords or *; pass an ID from available_servers as server to load that plugin on demand. Continue with next_cursor as cursor without query/server. Try alternate queries before concluding a capability is unavailable. This query executes no target and grants no permission. Delegate actual execution to a child; schema loading and generic invocation are not available in this assistant scope. Local results do not establish remote worker capabilities.' };
        if (tool.name === 'search_skills') return { ...tool, description: 'Discover installed Skills on this Runtime by capability or name; query=* lists visible Skills. Results include descriptions, mainResource and optional plugin invocation IDs. Continue with next_offset as offset and the same query. Use these facts to choose a child for execution; reading instructions and invoking Skills belong to that child. Local results do not establish remote worker capabilities.' };
        return presentExistingScheduleActions(tool);
      });
  }
  snapshot(): AssistantManagementSnapshot {
    return { plan: this.options.coordination().getPlan(PERSONAL_ASSISTANT_SESSION), permissions: [...this.pending.values()] };
  }
  get awaitingPermission() { return this.pending.size > 0; }
  hasPermission(id: string) { return this.permissions.pendingIds().includes(id); }
  answerPermission(answer: RuntimePermissionAnswer) { return this.permissions.answer(answer); }
  reset() { this.options.coordination().clearPlan(PERSONAL_ASSISTANT_SESSION); }
  async execute(call: ToolCall, parent: RuntimeSessionTurnRequest, request: ModelRequest, round: number, ordinal: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.definitions(parent).some(tool => tool.name === call.name)) throw Object.assign(Error('This tool is not available to the assistant.'), { code: 'tool_not_exposed' });
    // Catalog queries need the caller's actual execution capabilities, not just
    // the small conversational schema. No generic invocation tool is exposed.
    const executionRequest: ModelRequest = { ...request, tools: [...parent.tools, ...this.definitions(parent).filter(tool => !parent.tools.some(item => item.name === tool.name))], requestCapabilities: parent.requestCapabilities };
    if (call.name === 'schedule_task') {
      const action = JSON.parse(call.argumentsText).action;
      if (action === 'update') {
        await this.options.automation?.remember(parent);
        signal.throwIfAborted();
      }
    }
    if (call.name === 'search_plugins' || call.name === 'mcp_search') executionRequest.metadata = { ...executionRequest.metadata, mcpToolDiscovery: true };
    const identity = { requestId: request.requestId, sessionId: parent.sessionId, turnId: parent.turnId, round: round + 1, ordinal };
    this.identities.set(call.id, identity);
    if (typeof parent.metadata.environmentExecutionId === 'string') this.executions.set(call.id, parent.metadata.environmentExecutionId);
    try {
      const coordinator = new ToolExecutionCoordinator({ registry: this.options.registry, permissions: this.permissions, capabilities: this.options.capabilities,
        hooks: this.options.hooks?.(executionRequest), observer: { completed: (call, identity, result) => this.options.executions.record(call, identity, result) } });
      const outcome = await coordinator.execute(call, identity, signal, { request: executionRequest, contextMessages: request.messages, signal });
      this.options.executions.record(call, identity, outcome);
      signal.throwIfAborted();
      if (outcome.hookStopTurn) throw Object.assign(Error(outcome.hookStopTurn), { code: 'assistant_management_stopped' });
      if (outcome.rejectToolResult) throw Object.assign(Error(`The tool ran, but its result was withheld by policy. Do not repeat the action. ${outcome.hookFeedback ?? ''}`), { code: 'plugin_hook_result_blocked' });
      if (outcome.kind !== 'returned') throw Object.assign(Error(outcome.error.message), { code: outcome.error.code });
      if (call.name === 'search_plugins' || call.name === 'mcp_search') {
        const localTools = new Set(parent.tools.filter(tool => !this.options.registry.resolve(tool.name)?.mcpHook).map(tool => tool.name));
        parent.tools = executionRequest.tools.filter(tool => localTools.has(tool.name) || this.options.registry.resolve(tool.name)?.mcpHook);
      }
      // Page-aware tools keep continuation cursors instead of dumping catalogues.
      const rendered = this.options.registry.projectModelPage(call.name, outcome.result, 12000, call)
        ?? projectMcpDiscoveryResult(JSON.stringify(outcome.result), 12000);
      return rendered ? JSON.parse(rendered) : outcome.result;
    } finally { this.identities.delete(call.id); this.executions.delete(call.id); }
  }
}
