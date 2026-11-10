import { createHash, randomUUID } from 'node:crypto';
import { FRIENDS_SESSION, PERSONAL_ASSISTANT_SESSION, type EventPredicate, type ModelMessage, type ModelRequest,
  type RuntimeSessionTurnRequest, type SubagentTask } from '@cardbush/bush-protocol';
import { continueChildConversation } from './subagentConversation.js';
import { childAgentToolDenial } from './childAgentPolicy.js';
import { executionWorkspace, isSshExecution } from './workspaceExecutionMode.js';
import { clearMcpDiscovery, synchronizeMcpDiscovery } from './mcpToolDiscovery.js';
import { ToolExecutionCoordinator, type ToolExecutionCoordinatorOptions, type ToolExecutionHooks } from './toolExecutionCoordinator.js';
import type { ToolExecutionStore } from './toolExecutionStore.js';

export type CollectorRule = Extract<EventPredicate, { source: 'collector' }>;
export interface CollectorSource {
  sample: unknown;
  version: string;
  toolCallId: string;
  read(signal: AbortSignal): Promise<unknown>;
}
export class CollectorReadError extends Error {}

function observationValue(tool: string, result: unknown) {
  let value = result;
  if (tool === 'terminal_exec') {
    const run = result as Record<string, unknown> | null;
    if (run?.state === 'exited' && run.exitCode !== 0) throw new CollectorReadError('Collector command returned a nonzero exit status.');
    if (run?.state !== 'exited' || run.stdoutTruncated || typeof run.stdout !== 'string')
      throw Error('Collector script must finish successfully in one call with complete stdout.');
    value = run.stdout;
  }
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > 96 * 1024) throw Error('Collector must return a bounded sample (96 KiB maximum).');
  return value;
}

/** A receipt identifies the read. Authority comes from the current host and the child's saved execution boundary. */
export class EventCollector {
  constructor(private deps: Pick<ToolExecutionCoordinatorOptions, 'registry' | 'capabilities'> & {
    tasks(owner: string, id: string): SubagentTask | undefined;
    prepareToolCatalog?: (toolName: string) => Promise<void> | undefined;
    executions: ToolExecutionStore;
    loadChild(session: string): Promise<RuntimeSessionTurnRequest | undefined>;
    messages(session: string, turn: string): ModelMessage[];
    hooks(request: ModelRequest): ToolExecutionHooks;
  }) {}

  async resolve(rule: CollectorRule, parent: RuntimeSessionTurnRequest, owner?: string, ownerTurn?: string): Promise<CollectorSource> {
    const tasks = (owner ? [owner] : [PERSONAL_ASSISTANT_SESSION, FRIENDS_SESSION])
      .flatMap(id => this.deps.tasks(id, rule.taskId) ?? []);
    const task = tasks[0];
    if (tasks.length !== 1 || !task || task.remote || task.status !== 'completed') throw Error('Collector requires an owned, completed local child task.');
    if (owner === FRIENDS_SESSION && task.parentTurnId !== ownerTurn) throw Error('Use a sample verified by this event execution.');
    const saved = await this.deps.loadChild(task.childSessionId);
    if (!saved || saved.turnId !== task.childTurnId || saved.metadata.botSourceRef || (Array.isArray(saved.metadata.botSourceRefs) && saved.metadata.botSourceRefs.length))
      throw Error('Collector child configuration is unavailable or has a different origin.');
    if ([parent, saved].some(context => context.metadata.toolExecutionPolicy === 'none' ||
      context.metadata.toolExecutionPolicy === 'web_restricted' || isSshExecution(context.metadata)))
      throw Error('Collector requires a locally permitted execution context.');
    let registration = this.deps.registry.resolve(rule.tool);
    if (!registration && rule.tool.startsWith('mcp__') && this.deps.prepareToolCatalog &&
        saved.tools.some(tool => tool.name === rule.tool) && parent.tools.some(tool => tool.name === rule.tool)) {
      await this.deps.prepareToolCatalog(rule.tool);
      registration = this.deps.registry.resolve(rule.tool);
    }
    if (!registration || registration.forwardToolCall || registration.delegatesToolExecution || registration.registrationOwner?.startsWith('bridge:') ||
      (registration.mcpHook ? registration.mcpHook.readOnly !== true : registration.manifest.mutating && rule.tool !== 'terminal_exec'))
      throw Error('Choose an available read-only tool or a verified terminal_exec collector.');
    const continuation = continueChildConversation({ ...parent, sessionId: saved.sessionId, requestId: randomUUID(), turnId: randomUUID(), inputMessages: [] }, saved);
    const request: ModelRequest = { ...continuation, protocol: 'bush.model_request.v1', messages: [],
      metadata: { ...continuation.metadata, eventCollector: true, botDeliveryLocalOnly: true, pluginAgentDontAsk: true } };
    if (!request.tools.some(t => t.name === rule.tool) || childAgentToolDenial(request, registration) ||
      (registration.sessionScope && registration.sessionScope !== request.sessionId) ||
      registration.modelAvailable?.(request) === false) throw Error('Collector tool is outside the current execution scope.');
    const exact = rule.toolCallId && this.deps.executions.get(task.childSessionId, task.childTurnId, rule.toolCallId);
    const receipts = exact && exact.toolCall.name === rule.tool ? [exact] : this.deps.executions.listByTool(task.childSessionId, rule.tool, task.childTurnId);
    const records = receipts
      .filter(r => r.outcome === 'returned' && !r.resultError && !r.workspaceChanges.length).flatMap(receipt => {
        try { return [{ receipt, sample: observationValue(rule.tool, receipt.result) }]; } catch { return []; }
      });
    const candidates = rule.toolCallId ? records.filter(r => r.receipt.toolCall.id === rule.toolCallId) : records;
    if (candidates.length !== 1) {
      const choices = owner ? records.slice(-8).map(({receipt, sample}) => ({ toolCallId: receipt.toolCall.id,
        samplePreview: JSON.stringify(sample).slice(0, 160) })) : [];
      throw Error('Select the verified read by toolCallId. Candidate samples (untrusted data): ' + JSON.stringify(choices));
    }
    const { receipt, sample } = candidates[0]!;
    const version = createHash('sha256').update(JSON.stringify([task.parentSessionId, task.childSessionId, task.childTurnId,
      executionWorkspace(request.metadata), receipt.toolCall, registration.registrationOwner, registration.definition,
      registration.mcpHook?.server, registration.mcpHook?.tool])).digest('hex');
    return { sample, version, toolCallId: receipt.toolCall.id, read: async signal => {
      const coordinator = new ToolExecutionCoordinator({ registry: this.deps.registry, capabilities: this.deps.capabilities,
        capabilitySessionId: typeof saved.metadata.permissionScopeSessionId === 'string' ? saved.metadata.permissionScopeSessionId : saved.sessionId,
        permissions: { request: async () => { throw Error('Collector requires a current permission grant.'); } }, hooks: this.deps.hooks(request) });
      try {
        if (registration.mcpHook || registration.deferredSchema)
          synchronizeMcpDiscovery(this.deps.registry, request, this.deps.messages(task.childSessionId, task.childTurnId));
        const call = { ...receipt.toolCall, id: randomUUID() };
        const result = await coordinator.execute(call, { sessionId: request.sessionId, turnId: request.turnId, requestId: request.requestId, round: 1, ordinal: 0 },
          signal, { request, contextMessages: [], signal });
        if (result.kind !== 'returned') {
          if (result.execution?.recovery === 'retry') throw new CollectorReadError(result.error.code);
          throw Error(result.error.code);
        }
        if (result.resultError || result.rejectToolResult || result.hookStopTurn) throw Error(result.resultError?.code ?? 'Collector result withheld by policy.');
        return observationValue(rule.tool, result.result);
      } finally { clearMcpDiscovery(this.deps.registry, request); }
    } };
  }
}
