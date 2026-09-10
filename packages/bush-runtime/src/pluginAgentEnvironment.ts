import type { ModelMessage, RuntimeSessionTurnRequest } from '@cardbush/bush-protocol';
import type { PluginAgent } from './pluginExtensions.js';
import { pluginAgentTools, validateAgentSkills } from './pluginExtensions.js';
import { PluginAgentMemory } from './pluginAgentMemory.js';
import type { TaskWorkspaceManager } from './taskWorkspace.js';
import type { ToolRegistration, ToolRegistry } from './toolRegistry.js';

export type OpenAgentMcpScope = (agent: PluginAgent, request: RuntimeSessionTurnRequest, signal?: AbortSignal) => Promise<{ registrations: ToolRegistration<any>[]; close: () => Promise<void> }>;

/** Acquires per-agent module capabilities and releases them exactly once after the child settles. */
export class PluginAgentEnvironment {
  private readonly memory: PluginAgentMemory;
  constructor(root: string, private readonly registry: ToolRegistry, private readonly workspaces?: TaskWorkspaceManager, private readonly openMcp?: OpenAgentMcpScope, private readonly readContext?: (session: string) => ModelMessage[]) { this.memory = new PluginAgentMemory(root, registry); }
  async acquire(request: RuntimeSessionTurnRequest, agent: PluginAgent, signal?: AbortSignal) {
    const owner = `plugin-agent:${request.sessionId}`, cleanup: Array<() => Promise<void>> = [];
    let released = false;
    const release = async () => {
      if (released) return; released = true;
      this.memory.release(request.sessionId); this.registry.removeOwned(owner);
      const results = await Promise.allSettled(cleanup.reverse().map(operation => operation()));
      const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    };
    try {
      signal?.throwIfAborted();
      request.metadata.pluginAgentPermissionMode = agent.permissionMode ?? 'default';
      if (agent.permissionMode === 'dontAsk') request.metadata.pluginAgentDontAsk = true;
      if (agent.isolation) {
        if (!this.workspaces) throw new Error('Isolated Agent workspaces require runtime storage.');
        const source = String(request.metadata.workspaceDir || request.metadata.projectDir || '');
        const workspace = await this.workspaces.create(request.sessionId, source, 'worktree');
        request.metadata = { ...request.metadata, projectDir: workspace.workspaceDir, workspaceDir: workspace.workspaceDir, taskRoots: [workspace.workspaceDir], userRoots: [], pluginAgentSourceDir: source };
        request.sessionMetadata = { ...request.sessionMetadata, workspace };
        cleanup.push(async () => {
          const review = await this.workspaces!.review(request.sessionId);
          if (review && !review.changes.length && !review.error && !review.checkpoints.some(checkpoint => checkpoint.backgroundProcesses || checkpoint.status === 'pending' || checkpoint.status === 'failed')) await this.workspaces!.update(request.sessionId, review.workspace.revision, 'discard', review.snapshotId);
          // Modified copies retain their review and apply lifecycle; never merge or delete them implicitly.
        });
      }
      if (agent.mcpServers?.some(server => typeof server !== 'string')) {
        if (agent.trusted !== true) throw new Error('Review and trust this Agent’s local MCP definition in plugin settings first.');
        if (!this.openMcp) throw new Error('The host has no Agent MCP scope adapter.');
        const lease = await this.openMcp(agent, request, signal); cleanup.push(lease.close);
        const registrations = lease.registrations.map(registration => ({ ...registration, sessionScope: request.sessionId,
          execute: (context: Parameters<typeof registration.execute>[0]) => { if (context.sessionId !== request.sessionId) throw new Error('Agent MCP connection belongs to another task.'); return registration.execute(context); },
          mcpHook: registration.mcpHook ? { ...registration.mcpHook, call: (input: Record<string, unknown>, options: Parameters<NonNullable<typeof registration.mcpHook>['call']>[1]) => { if (options.request.sessionId !== request.sessionId) throw new Error('Agent MCP scope mismatch.'); return registration.mcpHook!.call(input, options); } } : undefined,
        }));
        this.registry.replaceOwned(owner, registrations);
        request.tools.push(...registrations.map(registration => registration.definition));
      }
      if (agent.mcpServers) for (const reference of agent.mcpServers.filter((value): value is string => typeof value === 'string')) {
        if (!request.tools.some(tool => { const server = this.registry.resolve(tool.name)?.mcpHook?.server; return server === reference || server === `plugin_${agent.pluginId.replace(/\./g, '_')}_${reference}`; })) throw new Error(`Agent MCP reference ${reference} is not connected in the parent task.`);
      }
      const allowed = new Set(pluginAgentTools(agent, request.tools.map(tool => tool.name)));
      request.tools = request.tools.filter(tool => allowed.has(tool.name));
      if (agent.tools?.length && !request.tools.length) throw new Error(`Agent ${agent.id} has no available tools matching its declaration.`);
      if (agent.permissionMode === 'plan') request.tools = request.tools.filter(tool => this.registry.resolve(tool.name)?.manifest.mutating === false);
      if (agent.permissionMode === 'dontAsk') request.metadata.pluginAgentDontAsk = true;
      // A plugin cannot raise the user's configured permission level.
      request.metadata.pluginAgentPermissionMode = agent.permissionMode ?? 'default';
      await this.memory.prepare(agent, request, this.registry, this.readContext?.(request.sessionId));
      request.metadata.pluginScopedSkillIds = [...new Set([...(Array.isArray(request.metadata.pluginScopedSkillIds) ? request.metadata.pluginScopedSkillIds : []), ...(agent.skills ?? []).map(skill => skill.name)])];
      validateAgentSkills(agent, request, this.registry);
      signal?.throwIfAborted(); return { release };
    } catch (error) { try { await release(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Agent setup and cleanup failed.'); } throw error; }
  }
}
