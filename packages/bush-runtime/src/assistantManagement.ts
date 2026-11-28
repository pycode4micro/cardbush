import { ASSISTANT_MANAGEMENT_TOOLS, PERSONAL_ASSISTANT_SESSION, type AssistantManagementSnapshot, type ModelRequest,
  type RuntimeSessionTurnRequest, type RuntimePermissionAnswer, type ToolCall, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { ToolExecutionCoordinator, type RuntimeCapabilityStore, type ToolExecutionIdentity, type ToolExecutionHooks, type ToolExecutionOutcome } from './toolExecutionCoordinator.js';
import { resultDelivery } from './taskResultDelivery.js';
import { RuntimePermissionBroker } from './runtimePermissionBroker.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';
import type { CoordinationStore } from './coordinationStore.js';
import { synchronizeMcpDiscovery } from './mcpToolDiscovery.js';
import { projectBuiltinDefinitions } from './builtinToolDisclosure.js';
import { stripToolDisplayTitle } from './toolDisplay.js';
import { pluginCommandDeniesTool } from './pluginCommandTools.js';

const allowed = new Set<string>(ASSISTANT_MANAGEMENT_TOOLS);
const disclosureNames = ['get_tool_schema', 'call_tool'] as const;
const disclosureDescriptions = {
  get_tool_schema: 'Read complete definitions for Assistant-owned management tools and advanced actions. Pass one exact name or up to 16 names. Use the returned invocation. Tool discovery for delegated work belongs to the child Agent.',
  call_tool: 'Invoke an Assistant-owned management tool or advanced action using its exact name and the arguments returned by the complete definition. Load that definition in an earlier round. All existing permissions and receipts apply.',
} satisfies Record<(typeof disclosureNames)[number], string>;
// The parent owns requested lifecycle changes. The child owns package discovery
// and verification, including the version comparison needed for an update.
const productPluginMutationTools = new Set(['install_plugin', 'uninstall_plugin']);

/** Uses the ordinary validators, permission grants and receipts, without a child or a second scheduler. */
export class AssistantManagement {
  private pending = new Map<string, AssistantManagementSnapshot['permissions'][number]>();
  private identities = new Map<string, ToolExecutionIdentity>();
  private executions = new Map<string, string>();
  private permissions: RuntimePermissionBroker;
  constructor(private options: {
    registry: ToolRegistry; executions: ToolExecutionStore; capabilities: RuntimeCapabilityStore;
    coordination: () => CoordinationStore;
    childPermissions?: () => AssistantManagementSnapshot['permissions'];
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
    const ownerHistory = !parent.metadata.botSourceRef && !(Array.isArray(parent.metadata.botSourceRefs) && parent.metadata.botSourceRefs.length);
    const catalog = this.options.registry.definitions().filter(tool => allowed.has(tool.name) ||
      (ownerHistory && tool.name === 'read_conversation_history') ||
      parent.metadata.toolExecutionPolicy !== 'web_restricted' && (this.isBridgeTool(tool.name) ||
        this.isProductPluginMutation(tool.name, parent)));
    return catalog.filter(tool => parent.tools.some(item => item.name === tool.name) &&
      this.options.registry.resolve(tool.name)?.modelAvailable?.(request) !== false);
  }
  private isBridgeTool(name: string) {
    const registration = this.options.registry.resolve(name);
    return registration?.registrationOwner === `bridge:${PERSONAL_ASSISTANT_SESSION}` &&
      registration.manifest?.operation === 'bridge.plugin.call' && registration.mcpHook?.modelVisible !== false;
  }
  private isProductPluginMutation(name: string, parent: RuntimeSessionTurnRequest) {
    if (parent.metadata.botSourceRef || (Array.isArray(parent.metadata.botSourceRefs) && parent.metadata.botSourceRefs.length)) return false;
    const registration = this.options.registry.resolve(name);
    return registration?.registrationOwner === 'runtime_mcp' && registration.mcpHook?.server === 'cardbush_management' &&
      registration.mcpHook.modelVisible !== false && productPluginMutationTools.has(registration.mcpHook.tool);
  }
  projectModelDefinitions(parent: RuntimeSessionTurnRequest, tools: ToolDefinition[]) {
    const visible = tools.filter(tool => !this.isProductPluginMutation(tool.name, parent));
    const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1', messages: [], tools: visible };
    return { tools: projectBuiltinDefinitions(this.options.registry, request, visible), hasDeferredProductPlugins: visible.length < tools.length };
  }
  private disclosureDefinitions(parent: RuntimeSessionTurnRequest) {
    if (parent.sessionId !== PERSONAL_ASSISTANT_SESSION || parent.metadata.agentRole === 'child' ||
        ['none', 'web_restricted'].includes(String(parent.metadata.toolExecutionPolicy))) return [];
    const request: ModelRequest = { ...parent, protocol: 'bush.model_request.v1', messages: [] };
    const definitions = disclosureNames.flatMap(name => {
      const registration = this.options.registry.resolve(name);
      return registration && parent.tools.some(tool => tool.name === name) && registration.modelAvailable?.(request) !== false
        ? [{ ...registration.definition, description: disclosureDescriptions[name] }] : [];
    });
    return definitions.length === disclosureNames.length ? definitions : [];
  }
  delegationWithDisclosure(parent: RuntimeSessionTurnRequest, nativeTools: ToolDefinition[]) {
    return nativeTools.length ? [...nativeTools, ...this.disclosureDefinitions(parent)] : nativeTools;
  }
  private disclosureRequest(parent: RuntimeSessionTurnRequest, request: ModelRequest, nativeTools: ToolDefinition[]): ModelRequest {
    // Host-owned bridge and plugin management registrations can run directly
    // through the normal permission and execution pipeline.
    const candidates = [...nativeTools, ...this.definitions(parent), ...this.disclosureDefinitions(parent)];
    const hasTool = (name: string) => request.tools.some(item => item.name === name);
    const scope = { hasTool, canRecall: disclosureNames.every(hasTool) };
    const tools = candidates.flatMap(tool => {
      const registration = this.options.registry.resolve(tool.name);
      const productPlugin = this.isProductPluginMutation(tool.name, parent);
      return registration && (!registration.mcpHook || this.isBridgeTool(tool.name) || productPlugin) && parent.tools.some(item => item.name === tool.name) &&
        registration.modelAvailable?.(request) !== false && (productPlugin || hasTool(tool.name) ||
          scope.canRecall && registration.projectModelDefinition?.(registration.definition, scope) === null)
        ? [registration.definition] : [];
    });
    return { ...request, tools, metadata: { ...request.metadata }, requestCapabilities: parent.requestCapabilities };
  }
  /** Resolve only the envelope with the ordinary decoder/revision gate. The
   * selected tool still runs through its existing dispatcher and coordinator. */
  resolveInvocation(call: ToolCall, parent: RuntimeSessionTurnRequest, request: ModelRequest, nativeTools: ToolDefinition[]) {
    if (call.name !== 'call_tool' && !nativeTools.some(tool => tool.name === call.name)) return call;
    const scoped = this.disclosureRequest(parent, request, nativeTools);
    if (!scoped.tools.some(tool => tool.name === call.name)) throw Object.assign(Error('This tool is not available to the assistant.'), { code: 'tool_not_exposed' });
    if (call.name !== 'call_tool') return call;
    if (pluginCommandDeniesTool(scoped, call.name)) throw Object.assign(Error('Invocation is disabled by the active plugin Command.'), { code: 'plugin_command_tool_disallowed' });
    const registration = this.options.registry.resolve(call.name)!;
    const input = registration.decodeInput(stripToolDisplayTitle(JSON.parse(call.argumentsText), registration.definition));
    const target = registration.forwardToolCall!({ input, sessionId: request.sessionId,
      turn: { request: scoped, contextMessages: request.messages } });
    return { ...call, name: target.name, argumentsText: JSON.stringify(target.input) };
  }
  snapshot(): AssistantManagementSnapshot {
    return { plan: this.options.coordination().getPlan(PERSONAL_ASSISTANT_SESSION),
      permissions: [...this.pending.values(), ...(this.options.childPermissions?.() ?? [])] };
  }
  get awaitingPermission() { return this.pending.size > 0; }
  hasPermission(id: string) { return this.permissions.pendingIds().includes(id); }
  answerPermission(answer: RuntimePermissionAnswer) { return this.permissions.answer(answer); }
  reset() { this.options.coordination().clearPlan(PERSONAL_ASSISTANT_SESSION); }
  async execute(call: ToolCall, parent: RuntimeSessionTurnRequest, request: ModelRequest, round: number, ordinal: number, signal: AbortSignal, nativeTools: ToolDefinition[] = [], onOutcome?: (outcome: ToolExecutionOutcome) => void) {
    signal.throwIfAborted();
    const disclosure = call.name === 'get_tool_schema';
    if (!(disclosure ? nativeTools.length && this.disclosureDefinitions(parent).some(tool => tool.name === call.name) && request.tools.some(tool => tool.name === call.name)
      : this.definitions(parent).some(tool => tool.name === call.name))) throw Object.assign(Error('This tool is not available to the assistant.'), { code: 'tool_not_exposed' });
    const executionRequest: ModelRequest = disclosure ? this.disclosureRequest(parent, request, nativeTools)
      : { ...request, tools: [...parent.tools, ...this.definitions(parent).filter(tool => !parent.tools.some(item => item.name === tool.name))], requestCapabilities: parent.requestCapabilities };
    if (this.isBridgeTool(call.name) || this.isProductPluginMutation(call.name, parent)) synchronizeMcpDiscovery(this.options.registry, executionRequest, request.messages);
    const identity = { requestId: request.requestId, sessionId: parent.sessionId, turnId: parent.turnId, round: round + 1, ordinal };
    this.identities.set(call.id, identity);
    if (typeof parent.metadata.environmentExecutionId === 'string') this.executions.set(call.id, parent.metadata.environmentExecutionId);
    try {
      const coordinator = new ToolExecutionCoordinator({ registry: this.options.registry, permissions: this.permissions, capabilities: this.options.capabilities,
        hooks: this.options.hooks?.(executionRequest), observer: { completed: (call, identity, result) => this.options.executions.record(call, identity, result) } });
      const outcome = await coordinator.execute(call, identity, signal, { request: executionRequest, contextMessages: request.messages, signal });
      this.options.executions.record(call, identity, outcome);
      signal.throwIfAborted();
      onOutcome?.(outcome);
      if (outcome.kind === 'returned' && (outcome.hookStopTurn || outcome.hookFeedback !== undefined || outcome.rejectToolResult)) resultDelivery(outcome.result)?.release();
      if (outcome.hookStopTurn) throw Object.assign(Error(outcome.hookStopTurn), { code: 'assistant_management_stopped' });
      if (outcome.rejectToolResult) throw Object.assign(Error(`The tool ran, but its result was withheld by policy. Do not repeat the action. ${outcome.hookFeedback ?? ''}`), { code: 'plugin_hook_result_blocked' });
      if (outcome.kind !== 'returned') throw Object.assign(Error(outcome.error.message), { code: outcome.error.code });
      if (outcome.hookFeedback !== undefined) return outcome.hookFeedback;
      // Complete schemas are prerequisites, not pageable search summaries.
      if (disclosure) return outcome.result;
      // Page-aware tools keep continuation cursors instead of dumping catalogues.
      const rendered = this.options.registry.projectModelPage(call.name, outcome.result, 12000, call);
      return rendered ? JSON.parse(rendered) : outcome.result;
    } finally { this.identities.delete(call.id); this.executions.delete(call.id); }
  }
}
