import { randomUUID } from "node:crypto";

import {
  registeredAgentSchema,
  type SessionSnapshot,
  type RemoteSubagentRequest,
  type RemoteSubagentResult,
  type RuntimeGuidanceRequest,
  type RegisteredAgent,
  type DefinitionReceipt,
} from "@cardbush/bush-protocol";

import {
  buildChildTurnRequest,
  inheritedChildMessages,
  resolveChildTurn,
  type ChildTurnRunner,
  type SubagentPermissionPolicy,
} from "./childTurn.js";
import type { SubagentTaskStore } from "./subagentTaskStore.js";
import type { ToolRegistry, ToolHandlerContext } from "./toolRegistry.js";
import { RegisteredAgentStore, REGISTERED_AGENT_SCHEMA, validateRegisteredHooks } from './registeredAgents.js';
import type { PluginHook } from './pluginExtensions.js';
import { assertParentAgent } from './childAgentPolicy.js';
import { registerSubagentOptions } from './subagentOptions.js';
import { CLEAN_AGENT_SETTINGS_SCHEMA, decodeCleanAgentSettings, decodeToolOrSkillNames, type CleanAgentSettings, type SubagentModelCatalog } from './cleanAgentSettings.js';
import { pluginAgentTools, validateAgentSkills, type PluginAgent } from './pluginExtensions.js';
import { childConversationPage, type ChildConversationSource } from './subagentConversation.js';

export const SUBAGENT_TOOL = "subagent" as const;
export const AWAIT_SUBAGENTS_TOOL = "await_subagents" as const;

export interface RemoteSubagentBridge {
  list(signal?: AbortSignal): Promise<Array<{ id: string; name: string; agentId?: string }>>;
  run(input: RemoteSubagentRequest, signal?: AbortSignal): Promise<RemoteSubagentResult>;
  read?(input: { connectionId: string; agentId?: string; parentSessionId: string; sessionId: string }, signal?: AbortSignal): Promise<SessionSnapshot | undefined>;
  guide?(input: { connectionId: string; agentId?: string; parentSessionId: string; sessionId: string; turnId: string; messageId: string; content: string }, signal?: AbortSignal): Promise<unknown>;
}

export interface SubagentInput {
  prompt: string;
  mode: 'fork' | 'clean';
  systemPrompt?: string;
  allowedTools?: string[];
  settings?: CleanAgentSettings;
  agentType?: string;
  runInBackground?: boolean;
  taskId?: string;
  targetAgent?: string;
  agentId?: string;
  registration?: { action: 'save' | 'delete'; agent?: unknown; id?: string; revision: number };
}

export interface SubagentExecutionOptions {
  waitForResult?: boolean;
  onStarted?: (identity: { taskId: string; sessionId: string }) => Promise<void>;
  agent?: DefinitionReceipt<RegisteredAgent>;
  taskId?: string;
  team?: { id: string; nodeId: string; runId: string };
}
export interface SubagentDispatcher {
  dispatch(context: ToolHandlerContext<SubagentInput>, options?: SubagentExecutionOptions): Promise<unknown>;
}

interface AwaitSubagentsInput {
  taskIds: string[];
  mode: 'any' | 'all';
}

export interface JoinedSubagentResult {
  taskId: string;
  message: { role: "user"; name: "subagent_result" | "background_tool_result"; content: string };
}

type AwaitAsyncSubagentResults = (input: {
  parentSessionId: string;
  parentTurnId: string;
  taskIds: string[];
  mode?: 'any' | 'all';
}) => Promise<JoinedSubagentResult[]>;

export type SubagentChildRunner = ChildTurnRunner;

export function registerSubagentTool(
  registry: ToolRegistry,
  tasks: SubagentTaskStore,
  runChild: SubagentChildRunner,
  options: {
    createTaskId?: () => string;
    createRequestId?: () => string;
    createSessionId?: () => string;
    createTurnId?: () => string;
    createMessageId?: () => string;
    asyncDispatch?: boolean;
    onAsyncResult?: (input: {
      parentSessionId: string;
      parentTurnId: string;
      taskId: string;
      result: Promise<{ role: "user"; name: "subagent_result"; content: string } | null>;
    }) => void;
    awaitAsyncResults?: AwaitAsyncSubagentResults;
    permissionPolicy?: SubagentPermissionPolicy;
    models?: SubagentModelCatalog;
    remoteAgents?: RemoteSubagentBridge;
    inheritBrowserScope?: (parentSessionId: string, childSessionId: string, signal?: AbortSignal) => Promise<void>;
    guideChild?: (input: RuntimeGuidanceRequest) => Promise<unknown>;
    loadPluginAgents?: () => Promise<PluginAgent[]>;
    runBackground?: <T>(session: string, turn: string, taskId: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    saveChildRequest?: (request: Parameters<SubagentChildRunner>[0]) => Promise<void>;
    loadChildRequest?: (sessionId: string) => Promise<Parameters<SubagentChildRunner>[0] | undefined>;
    readChildConversation?: (sessionId: string) => ChildConversationSource | undefined;
    agents?: RegisteredAgentStore;
    loadHooks?: () => Promise<PluginHook[]>;
  } = {},
): SubagentDispatcher | undefined {
  if (options.readChildConversation && !registry.resolve('read_subagent_conversation')) registry.register<{ taskId: string; cursor?: string }>({
    definition: { name: 'read_subagent_conversation',
      description: 'Read the ordered inputs and final answers of a child dispatched by this parent: parent assignments, direct user messages or guidance, and one final answer per completed turn. Intermediate loop messages, reasoning and tool activity are excluded. Use nextCursor until null for remaining content; a completed dispatch may have later human follow-ups. This reads conversation history, not a status polling loop.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['task_id'], properties: {
        task_id: { type: 'string', minLength: 1 }, cursor: { type: 'string', pattern: '^\\d+:\\d+$' },
      } } },
    manifest: { effect_kind: 'observation', operation: 'agent.read_conversation', risk: 'low', owner: 'runtime_subagent', dispatch_scope: 'parent_session', mutating: false },
    visibleToChild: false,
    decodeInput: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide a task_id and optional conversation cursor.');
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !['task_id', 'cursor'].includes(key)) || typeof input.task_id !== 'string' || !input.task_id.trim() ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^\d+:\d+$/.test(input.cursor)))) throw new Error('Provide a task_id and optional conversation cursor.');
      return { taskId: input.task_id, cursor: input.cursor as string | undefined };
    },
    execute: async context => {
      assertParentAgent(context.turn?.request);
      const task = tasks.get(context.sessionId, context.input.taskId);
      if (!task) throw new Error('This child task does not belong to the current parent conversation.');
      const session = task.remote
        ? await options.remoteAgents?.read?.({ ...task.remote, parentSessionId: context.sessionId, sessionId: task.childSessionId }, context.signal)
        : options.readChildConversation!(task.childSessionId);
      if (!session) throw new Error('The child conversation is not available yet.');
      return { taskId: task.taskId, status: task.status, ...childConversationPage(session, context.input.cursor) };
    },
  });
  if (registry.resolve(SUBAGENT_TOOL)) return;
  registerSubagentOptions(registry, options);
  const createTaskId = options.createTaskId ?? (() => `subagent_task_${randomUUID()}`);
  const createRequestId = options.createRequestId ?? (() => `subagent_request_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? (() => `subagent_session_${randomUUID()}`);
  const createTurnId = options.createTurnId ?? (() => `subagent_turn_${randomUUID()}`);
  const createMessageId = options.createMessageId ?? (() => `subagent_message_${randomUUID()}`);

  registry.register<SubagentInput>({
    definition: {
      name: SUBAGENT_TOOL,
      description:
        "Dispatch useful parallel work, or follow up on an existing child with task_id. Omit task_id only for new work; an existing running child receives guidance immediately, while a finished child resumes its original session and instructions. Fork continuations inherit the parent's current model configuration; explicitly configured clean children retain their own configuration. Continue independent parent work, then reconcile subagent_result; use await_subagents when only child results remain instead of polling. Background tasks may outlive this Turn and are managed by manage_plugin_agents. Host permissions and child-state restrictions remain enforced.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...(options.agents ? {
            action: { type: 'string', enum: ['run', 'save', 'delete'], default: 'run', description: 'run dispatches work. save registers/updates a reusable clean employee; delete removes its definition, retaining recorded conversations and memory.' },
            agent_id: { type: 'string', description: 'Registered employee ID from list_subagent_options.registered_agents. Uses clean mode and the saved configuration; omit configuration overrides.' },
            agent: REGISTERED_AGENT_SCHEMA,
            expected_revision: { type: 'integer', minimum: 0, description: 'Required for save/delete. 0 creates a new definition; otherwise use its observed revision.' },
          } : {}),
          prompt: { type: "string", minLength: 1, description: "Child assignment as a user message: necessary facts, original user's communication language, expected output, your concurrent next steps and handoffs. Distinguish pending dependencies from confirmed facts." },
          ...(options.remoteAgents ? { target_agent: { type: 'string', description: 'Delegate new work to a saved HTTP Agent ID from list_subagent_options.remote_agents. Supply prompt and target_agent only. It uses its own server workspace, model, tools and instructions; no parent history, credentials or local paths are copied. Results participate in await_subagents. Follow up with task_id.' } } : {}),
          ...(options.loadChildRequest || options.guideChild || options.remoteAgents ? { task_id: { type: 'string', minLength: 1, description: 'Follow up on a subagent owned by this parent. Running children receive guidance without a new task; finished children retain their history and execution host. Fork children inherit the current parent model; clean children and remote hosts retain their own configuration. Supply task_id and prompt only, with optional run_in_background for continuations; do not override configuration or create a duplicate task.' } } : {}),
          mode: { type: 'string', enum: ['fork', 'clean'], default: 'fork', description: 'fork is a snapshot of the pre-dispatch conversation and intent; later parent messages are not synchronized. clean uses a registered agent_id, or explicit independent system_prompt/settings. Discover reusable employees with list_subagent_options. Clean tasks have independent conversations and employee-scoped memory.' },
          system_prompt: { type: 'string', minLength: 1, description: 'Required for an unregistered clean Agent; omit when using agent_id or fork. Sets the actual system message. Host permissions cannot be overridden.' },
          allowed_tools: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Clean mode only. Exact tool names from your exposed catalog; omitted keeps the parent catalog, [] permits no tools. Intersects with any plugin Agent role and host restrictions. Enforced at execution, not just a prompt suggestion.' },
          settings: CLEAN_AGENT_SETTINGS_SCHEMA,
          ...(options.runBackground ? { run_in_background: { type: 'boolean', default: false } } : {}),
          ...(options.loadPluginAgents ? { agent_type: { type: 'string', description: 'Optional exact plugin Agent id from list_subagent_options.agent_roles. Its role and tool restrictions apply to the child.' } } : {}),
        },
      },
    },
    manifest: {
      effect_kind: "delegation",
      operation: "agent.delegate",
      risk: "low",
      owner: "runtime_subagent",
      dispatch_scope: "child_session",
      mutating: true,
    },
    parallelSafe: true,
    visibleToChild: true,
    decodeInput: decodeInput,
    execute: context => dispatch(context),
  });
  if (options.awaitAsyncResults && !registry.resolve(AWAIT_SUBAGENTS_TOOL)) {
    registerAwaitSubagentsTool(registry, options.awaitAsyncResults);
  }
  return { dispatch };

  async function dispatch(context: ToolHandlerContext<SubagentInput>, execution: SubagentExecutionOptions = {}) {
      if (!context.turn) throw new Error("Subagent dispatch requires the parent Turn context.");
      assertParentAgent(context.turn.request);
      if (context.input.registration) {
        if (!options.agents) throw new Error('Registered Agents are unavailable in this host.');
        const input = context.input.registration;
        if (input.action === 'delete') { await options.agents.remove(input.id!, input.revision); return { deleted: true, agent_id: input.id }; }
        // Validate hook references before publishing a new revision.
        const agent = registeredAgentSchema.parse(input.agent);
        validateRegisteredHooks(agent, await options.loadHooks?.() ?? []);
        const saved = await options.agents.put(agent, input.revision);
        return { agent_id: saved.definition.id, name: saved.definition.name, revision: saved.revision, updatedAt: saved.updatedAt, enabled: saved.definition.enabled };
      }
      const previous = context.input.taskId ? tasks.get(context.sessionId, context.input.taskId) : undefined;
      if (context.input.taskId && (!previous || previous.origin !== 'subagent' && (!execution.team || previous.teamId !== execution.team.id))) throw new Error('Only a subagent task owned by this parent conversation can receive a follow-up.');
      // An older task ID addresses the same child even after a later continuation.
      const running = previous && tasks.list(context.sessionId).find(task => task.childSessionId === previous.childSessionId && task.status === 'running');
      if (running) {
        try {
          const messageId = `subagent_guidance_${context.toolCall.id}`;
          let receipt: unknown;
          if (running.remote) {
            if (!options.remoteAgents?.guide) throw new Error('Remote child guidance is unavailable.');
            receipt = await options.remoteAgents.guide({ ...running.remote, parentSessionId: context.sessionId,
              sessionId: running.childSessionId, turnId: running.childTurnId, messageId, content: context.input.prompt }, context.signal);
          } else {
            if (!options.guideChild) throw new Error('Running child guidance is unavailable.');
            await options.inheritBrowserScope?.(context.sessionId, running.childSessionId, context.signal);
            receipt = await options.guideChild({ protocol: 'bush.runtime_guidance.v1', sessionId: running.childSessionId,
              turnId: running.childTurnId, messageId, content: context.input.prompt,
              createdAt: new Date().toISOString(), mode: 'interrupt_and_continue', metadata: { subagentAuthor: 'parent',
                realtimeParent: true, realtimeParentSessionId: context.sessionId, realtimeTaskId: running.taskId } });
          }
          return { status: 'message_queued', taskId: running.taskId, childSessionId: running.childSessionId, receipt };
        } catch (error) {
          if (tasks.get(context.sessionId, running.taskId)?.status === 'running') throw error;
          // If completion raced guidance, continue in the original session below.
        }
      }
      const taskId = execution.taskId ?? createTaskId();
      if (context.input.targetAgent || previous?.remote) {
        if (!options.remoteAgents) throw new Error('Remote Agent delegation is unavailable in this host.');
        const targetId = previous?.remote?.connectionId ?? context.input.targetAgent!;
        const target = (await options.remoteAgents.list(context.signal)).find(item => item.id === targetId);
        if (!target) throw new Error('The selected Agent connection is unavailable.');
        if (previous?.remote?.agentId && target.agentId !== previous.remote.agentId) throw new Error('The remote Agent identity changed. Start a new task after verifying the connection.');
        if (previous && tasks.list(context.sessionId).some(task => task.childSessionId === previous.childSessionId && task.status === 'running')) throw new Error('This child session is still running.');
        const remote = { connectionId: targetId, agentId: previous?.remote?.agentId ?? target.agentId };
        const parent = context.turn.request;
        const policy = parent.metadata.childAgentPolicy as Partial<SubagentPermissionPolicy> | undefined;
        const route = parent.metadata.subagentPermissionRouting ?? policy?.permissionRouting ?? options.permissionPolicy?.permissionRouting ?? 'user';
        const permissionMode = parent.permissionMode === 'all_free' || route === 'user'
          ? parent.permissionMode ?? 'task_free' : policy?.childPermissionMode ?? options.permissionPolicy?.childPermissionMode ?? 'task_free';
        const childSessionId = previous?.childSessionId ?? `delegated-${taskId}`;
        const childTurnId = `turn-${taskId}`;
        tasks.start({ taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId, childSessionId, childTurnId,
          prompt: context.input.prompt, inheritContext: false, inheritedMessageCount: 0, remote, ...(previous ? { resumedFromTaskId: previous.taskId } : {}) });
        const completion = options.remoteAgents.run({ ...remote, taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId,
          sessionId: childSessionId, turnId: childTurnId, prompt: context.input.prompt,
          permissionMode, language: parent.metadata.uiLanguage === 'en' ? 'en' : 'zh',
        }, context.signal).catch(error => ({ status: error instanceof Error && error.name === 'AbortError' ? 'stopped' as const : 'failed' as const, finalResponse: '', errorMessage: error instanceof Error ? error.message : String(error), usage: {} }))
          .then(result => tasks.finish({ parentSessionId: context.sessionId, taskId, ...result }));
        if (options.asyncDispatch && !execution.waitForResult) {
          options.onAsyncResult?.({ parentSessionId: context.sessionId, parentTurnId: context.turnId, taskId, result: completion.then(asyncResultMessage) });
          return { ...submittedResult(tasks.get(context.sessionId, taskId)!), remote };
        }
        return taskResult(await completion);
      }
      const saved = previous ? await options.loadChildRequest?.(previous.childSessionId) : undefined;
      if (previous && (!saved || saved.metadata.parentSessionId !== context.sessionId)) throw new Error('The original child execution configuration is unavailable. Start a new subagent with the needed context.');
      // Recheck after asynchronous loading; simultaneous resume calls must not fork the same identity.
      if (previous && tasks.list(context.sessionId).some(task => task.childSessionId === previous.childSessionId && task.status === 'running')) throw new Error('This child session is still running.');
      const childSessionId = previous?.childSessionId ?? createSessionId();
      const childTurnId = createTurnId();
      const registered = saved?.metadata.registeredAgent as DefinitionReceipt<RegisteredAgent> | undefined
        ?? execution.agent ?? (context.input.agentId ? await options.agents?.get(context.input.agentId) : undefined);
      if (context.input.agentId && !registered) throw new Error('The registered Agent does not exist. Inspect list_subagent_options.');
      if (registered) {
        const current = await options.agents?.get(registered.definition.id);
        if (!registered.definition.enabled || !current?.definition.enabled) throw new Error('The registered Agent is unavailable or disabled.');
        validateRegisteredHooks(registered.definition, await options.loadHooks?.() ?? []);
        context = { ...context, input: { ...context.input, mode: 'clean', systemPrompt: registered.definition.system_prompt,
          allowedTools: registered.definition.allowed_tools, settings: decodeCleanAgentSettings(registered.definition.settings ?? {}) } };
      }
      const inheritContext = previous?.inheritContext ?? context.input.mode === 'fork';
      const inherited = previous ? [] : inheritedChildMessages(context, inheritContext);
      const agentType = registered ? undefined : previous?.agentProfileId ?? context.input.agentType;
      const profile = agentType ? (await options.loadPluginAgents?.())?.find(agent => agent.id === agentType) : undefined;
      const background = !execution.waitForResult && (previous?.background === true || context.input.runInBackground === true || profile?.background === true);
      if (background && !options.runBackground) throw new Error('Background Agent execution is unavailable in this host.');
      if (agentType && !profile) throw new Error('The requested plugin Agent is not installed and enabled.');
      if (context.input.settings?.model_id && !options.models) throw new Error('This host cannot select a configured clean Agent model.');
      const selectedModel = context.input.settings?.model_id ? await options.models!.resolve(context.input.settings.model_id, context.signal) : undefined;

      let childRequest = buildChildTurnRequest({
        context,
        registry,
        ids: {
          requestId: createRequestId(),
          sessionId: childSessionId,
          turnId: childTurnId,
          messageId: createMessageId(),
        },
        prompt: context.input.prompt,
        cleanSystemPrompt: context.input.systemPrompt,
        toolAllowlist: context.input.allowedTools,
        cleanSettings: context.input.settings,
        cleanModel: selectedModel,
        inherited,
        metadata: { subagentTaskId: taskId, subagentMode: context.input.mode, pluginBackground: background,
          ...(execution.team ? { teamId: execution.team.id, teamRunId: execution.team.runId, teamMemberId: execution.team.nodeId } : {}),
          ...(registered ? { registeredAgent: registered, registeredAgentId: registered.definition.id, registeredAgentHooks: registered.definition.hooks,
            registeredAgentReadOnly: registered.definition.guards.includes('read_only'), individuation: { habits: false, predictions: false } } : {}),
          ...(profile ? { pluginAgentId: profile.id, pluginAgentMaxTurns: profile.maxTurns } : {}) },
        ...(profile ? {
          additionalPrefixMessages: [{ role: 'developer' as const, name: 'plugin_agent_role', content: `Plugin Agent: ${profile.id}\nPlugin directory: ${profile.root}\n${profile.prompt}\n${(profile.skills ?? []).map(skill => `\nPreloaded Skill ${skill.name} (${skill.path}):\n${skill.prompt}`).join('\n')}\n\nUse CardBush tool names; CardBush's configured child model and permission policies apply.` }],
          allowedToolNames: pluginAgentTools(profile, context.turn!.request.tools.map(tool => tool.name).filter(name => registry.childDefinitions().some(tool => tool.name === name))),
        } : {}),
        permissionPolicy: options.permissionPolicy,
      });
      if (registered) {
        delete childRequest.metadata.pluginAgentId;
        childRequest.metadata.pluginScopedSkillIds = [];
      }
      if (registered && registered.definition.memory !== 'none') {
        const memoryNames = registered.definition.guards.includes('read_only') ? ['agent_memory_read'] : ['agent_memory_read', 'agent_memory_write'];
        for (const name of memoryNames) {
          const tool = registry.resolve(name)?.definition;
          if (tool && !childRequest.tools.some(item => item.name === name)) childRequest.tools.push(tool);
        }
        if (Array.isArray(childRequest.metadata.childToolAllowlist)) childRequest.metadata.childToolAllowlist = [...new Set([...childRequest.metadata.childToolAllowlist, ...memoryNames])];
      }
      if (saved) {
        if (saved.metadata.workspaceDir !== childRequest.metadata.workspaceDir || saved.metadata.projectDir !== childRequest.metadata.projectDir)
          throw new Error('The parent workspace changed. Start a new child for that workspace instead of moving an existing child implicitly.');
        const originalTools = new Set(saved.tools.map(tool => tool.name));
        const levels = ['task_free', 'user_free', 'all_free'];
        const routing = saved.metadata.permissionRouting === 'parent' ? 'parent' : childRequest.metadata.permissionRouting;
        const disabled = [...new Set([...(saved.metadata.disabledTools as string[] ?? []), ...(childRequest.metadata.disabledTools as string[] ?? [])])];
        const turnLimits = [saved.metadata.pluginAgentMaxTurns, childRequest.metadata.pluginAgentMaxTurns]
          .filter((value): value is number => typeof value === 'number');
        // Keep the child's history and restrictions, but resolve inherited model
        // settings again for this dispatch. Only explicit clean configuration is pinned.
        const modelSource = saved.metadata.subagentMode === 'clean' ? saved : childRequest;
        childRequest = { ...saved, requestId: childRequest.requestId, turnId: childTurnId,
          model: modelSource.model, providerBinding: modelSource.providerBinding,
          maxOutputTokens: modelSource.maxOutputTokens, reasoningEffort: modelSource.reasoningEffort,
          temperature: modelSource.temperature, topP: modelSource.topP, requestCapabilities: modelSource.requestCapabilities,
          inputMessages: childRequest.inputMessages, sessionMetadata: childRequest.sessionMetadata,
          tools: childRequest.tools.filter(tool => originalTools.has(tool.name)),
          permissionMode: levels[Math.min(levels.indexOf(saved.permissionMode), levels.indexOf(childRequest.permissionMode))] as typeof saved.permissionMode,
          metadata: { ...saved.metadata, ...childRequest.metadata, disabledTools: disabled,
            subagentMode: saved.metadata.subagentMode,
            contextWindowTokens: modelSource.metadata.contextWindowTokens,
            childAgentModelMode: modelSource.metadata.childAgentModelMode,
            childAgentModelId: modelSource.metadata.childAgentModelId,
            ...(turnLimits.length ? { pluginAgentMaxTurns: Math.min(...turnLimits) } : {}),
            permissionRouting: routing, permissionScopeSessionId: routing === 'parent' ? childSessionId : context.sessionId,
            childToolAllowlist: childRequest.tools.filter(tool => originalTools.has(tool.name)).map(tool => tool.name),
            ...(saved.metadata.allowedSkills ? { allowedSkills: (saved.metadata.allowedSkills as string[]).filter(name => !Array.isArray(childRequest.metadata.allowedSkills) || childRequest.metadata.allowedSkills.includes(name)) } : {}),
            disabledSkills: [...new Set([...(saved.metadata.disabledSkills as string[] ?? []), ...(childRequest.metadata.disabledSkills as string[] ?? [])])],
          } };
      }
      // Host adapters validate dependencies after acquiring Agent-local MCP connections.
      if (!profile?.mcpServers?.some(server => typeof server !== 'string')) validateAgentSkills(profile, childRequest, registry);

      // Copy host-authorized grants before execution, keeping the child's scope
      // independent. Model-supplied URLs or page IDs never grant browser access.
      await options.inheritBrowserScope?.(context.sessionId, childSessionId, context.signal);
      if (previous && tasks.list(context.sessionId).some(task => task.childSessionId === previous.childSessionId && task.status === 'running')) throw new Error('This child session is still running.');

      tasks.start({ taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId,
        agentName: registered?.definition.name ?? profile?.name,
        childSessionId, childTurnId, background, agentProfileId: registered ? `registered:${registered.definition.id}` : profile?.id, prompt: context.input.prompt, inheritContext, inheritedMessageCount: saved?.prefixMessages.length ?? inherited.length,
        ...(execution.team ? { origin: 'team', teamId: execution.team.id, teamMemberId: execution.team.nodeId } : {}),
        ...(previous ? { resumedFromTaskId: previous.taskId } : {}) });

      const run = (signal = context.signal) => finishTask({
        runChild: async (request, childSignal) => {
          await options.saveChildRequest?.(request);
          await execution.onStarted?.({ taskId, sessionId: request.sessionId });
          return runChild(request, childSignal);
        },
        childRequest,
        signal,
        childTurnId,
        tasks,
        parentSessionId: context.sessionId,
        taskId,
      });
      const completion = background ? options.runBackground!(context.sessionId, context.turnId, taskId, run) : run();
      if (background) return { ...submittedResult(tasks.get(context.sessionId, taskId)!), background: true, instructions: 'Background task started. Its result is pending; use manage_plugin_agents when needed.' };
      if (options.asyncDispatch && !execution.waitForResult) {
        options.onAsyncResult?.({
          parentSessionId: context.sessionId,
          parentTurnId: context.turnId,
          taskId,
          result: completion.then(asyncResultMessage),
        });
        return submittedResult(tasks.get(context.sessionId, taskId)!);
      }
      return taskResult(await completion);
  }
}

function registerAwaitSubagentsTool(
  registry: ToolRegistry,
  awaitAsyncResults: AwaitAsyncSubagentResults,
): void {
  registry.register<AwaitSubagentsInput>({
    definition: {
      name: AWAIT_SUBAGENTS_TOOL,
      description:
        "Wait without polling when progress depends on child results or no independent work remains. Returns completed results for reconciliation. Omit task_ids to select outstanding tasks from this parent Turn.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['any', 'all'], default: 'any', description: 'any resumes after the first selected task finishes; all joins every selected task. Remaining tasks keep running.' },
          task_ids: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    manifest: {
      effect_kind: "observation",
      operation: "agent.join",
      risk: "low",
      owner: "runtime_subagent",
      dispatch_scope: "child_session",
      mutating: false,
    },
    parallelSafe: false,
    visibleToChild: true,
    decodeInput: decodeAwaitInput,
    execute: async (context) => {
      if (!context.turn) throw new Error("Subagent join requires the parent Turn context.");
      assertParentAgent(context.turn.request);
      const joined = await awaitAsyncResults({
        parentSessionId: context.sessionId,
        parentTurnId: context.turnId,
        taskIds: context.input.taskIds,
        mode: context.input.mode,
      });
      return {
        status: "joined",
        taskIds: joined.map((result) => result.taskId),
        count: joined.length,
        results: joined.map((result) => ({ taskId: result.taskId, content: result.message.content })),
      };
    },
  });
}

export function asyncResultMessage(
  task: ReturnType<SubagentTaskStore["finish"]>,
): { role: "user"; name: "subagent_result"; content: string } {
  const body = task.finalResponse.trim()
    ? task.finalResponse
    : task.errorMessage.trim()
      ? task.errorMessage
      : "No terminal response was produced.";
  return {
    role: "user",
    name: "subagent_result",
    content: `<subagent_result task_id="${task.taskId}" status="${task.status}">\n${body}\nRead read_subagent_conversation with this task_id for the ordered child conversation, including direct user interventions and later replies.\n</subagent_result>`,
  };
}

async function finishTask(input: {
  runChild: SubagentChildRunner;
  childRequest: Parameters<SubagentChildRunner>[0];
  signal?: AbortSignal;
  childTurnId: string;
  tasks: SubagentTaskStore;
  parentSessionId: string;
  taskId: string;
}) {
  let status: "completed" | "failed" | "stopped" = "failed";
  let finalResponse = "";
  let errorMessage = "";
  let usage: SessionSnapshot["turns"][number]["usage"] = {};
  try {
    const child = await input.runChild(input.childRequest, input.signal);
    ({ status, finalResponse, errorMessage, usage } = resolveChildTurn(child, input.childTurnId));
  } catch (error) {
    status = input.signal?.aborted ? "stopped" : "failed";
    errorMessage = error instanceof Error ? error.message : String(error);
  }
  return input.tasks.finish({
    parentSessionId: input.parentSessionId,
    taskId: input.taskId,
    status,
    finalResponse,
    errorMessage,
    usage,
  });
}

function submittedResult(task: ReturnType<SubagentTaskStore["start"]>): Record<string, unknown> {
  return {
    ...(task.agentProfileId ? { agentProfileId: task.agentProfileId, agentName: task.agentName } : {}),
    taskId: task.taskId,
    status: task.status,
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    mode: task.inheritContext ? 'fork' : 'clean',
    inheritedMessageCount: task.inheritedMessageCount,
    ...(task.remote ? { remote: task.remote } : {}),
  };
}

function taskResult(task: ReturnType<SubagentTaskStore["finish"]>): Record<string, unknown> {
  return {
    ...(task.agentProfileId ? { agentProfileId: task.agentProfileId, agentName: task.agentName } : {}),
    taskId: task.taskId,
    status: task.status,
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    mode: task.inheritContext ? 'fork' : 'clean',
    inheritedMessageCount: task.inheritedMessageCount,
    finalResponse: task.finalResponse,
    ...(task.remote ? { remote: task.remote } : {}),
    errorMessage: task.errorMessage,
    usage: task.usage,
  };
}

export function decodeSubagentInput(input: unknown): SubagentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("subagent input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter(
    (key) => !['prompt', 'mode', 'system_prompt', 'allowed_tools', 'settings', 'inherit_context', 'agent_type', 'run_in_background', 'task_id', 'target_agent', 'action', 'agent_id', 'agent', 'expected_revision'].includes(key),
  );
  if (unexpected.length > 0) throw new Error(`unsupported subagent arguments: ${unexpected.join(", ")}`);
  if (object.action !== undefined && !['run', 'save', 'delete'].includes(String(object.action))) throw new Error('Invalid subagent action.');
  if (object.action === 'save' || object.action === 'delete') {
    const allowed = object.action === 'save' ? ['action', 'agent', 'expected_revision'] : ['action', 'agent_id', 'expected_revision'];
    if (Object.keys(object).some(key => !allowed.includes(key)) || !Number.isSafeInteger(object.expected_revision) || Number(object.expected_revision) < 0) throw new Error('Registration requires the definition/agent_id and expected_revision only.');
    if (object.action === 'delete' && (typeof object.agent_id !== 'string' || !object.agent_id.trim())) throw new Error('agent_id is required.');
    return { prompt: '', mode: 'clean', registration: { action: object.action, agent: object.agent, id: object.agent_id as string | undefined, revision: Number(object.expected_revision) } };
  }
  if (object.agent !== undefined || object.expected_revision !== undefined) throw new Error('agent and expected_revision require a registration action.');
  const prompt = typeof object.prompt === "string" ? object.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (object.agent_id !== undefined) {
    if (typeof object.agent_id !== 'string' || !object.agent_id.trim() || object.mode !== undefined && object.mode !== 'clean' ||
        Object.keys(object).some(key => !['action', 'prompt', 'agent_id', 'mode', 'run_in_background'].includes(key))) throw new Error('A registered employee accepts agent_id, prompt, clean mode and optional run_in_background only.');
    if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
    return { prompt, mode: 'clean', agentId: object.agent_id.trim(), runInBackground: object.run_in_background as boolean | undefined };
  }
  if (object.target_agent !== undefined) {
    if (typeof object.target_agent !== 'string' || !object.target_agent.trim()) throw new Error('target_agent must be a saved Agent connection ID.');
    if (Object.keys(object).some(key => !['action', 'prompt', 'target_agent'].includes(key))) throw new Error('Remote delegation accepts prompt and target_agent only; the server owns its configuration.');
    return { prompt, mode: 'clean', targetAgent: object.target_agent.trim() };
  }
  if (object.task_id !== undefined) {
    if (typeof object.task_id !== 'string' || !object.task_id.trim()) throw new Error('task_id must be non-empty.');
    if (Object.keys(object).some(key => !['action', 'prompt', 'task_id', 'run_in_background'].includes(key))) throw new Error('Follow-up accepts prompt, task_id and optional run_in_background; the original configuration is preserved.');
    if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
    return { prompt, mode: 'fork', taskId: object.task_id.trim(), runInBackground: object.run_in_background as boolean | undefined };
  }
  if (object.inherit_context !== undefined && typeof object.inherit_context !== "boolean") {
    throw new Error("inherit_context must be a boolean.");
  }
  if (object.mode !== undefined && object.mode !== 'fork' && object.mode !== 'clean') throw new Error('mode must be fork or clean.');
  if (object.mode !== undefined && object.inherit_context !== undefined) throw new Error('Use mode instead of combining mode and legacy inherit_context.');
  // Decode already-issued calls from older tool snapshots, without advertising a second mode switch.
  const mode = object.mode ?? (object.inherit_context === false ? 'clean' : 'fork');
  if (mode === 'fork' && (object.system_prompt !== undefined || object.allowed_tools !== undefined || object.settings !== undefined)) throw new Error('system_prompt, allowed_tools and settings require clean mode; fork preserves the parent prefix.');
  if ((object.mode === 'clean' || object.system_prompt !== undefined) && (typeof object.system_prompt !== 'string' || !object.system_prompt.trim())) throw new Error('clean mode requires a non-empty system_prompt.');
  const allowedTools = object.allowed_tools === undefined ? undefined : decodeToolOrSkillNames(object.allowed_tools, 'allowed_tools');
  const settings = object.settings === undefined ? undefined : decodeCleanAgentSettings(object.settings);
  if (object.agent_type !== undefined && (typeof object.agent_type !== 'string' || !object.agent_type.trim())) throw new Error('agent_type must be a non-empty string.');
  if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
  return { prompt, mode, systemPrompt: object.system_prompt as string | undefined, allowedTools, settings, agentType: object.agent_type as string | undefined, runInBackground: object.run_in_background as boolean | undefined };
}

const decodeInput = decodeSubagentInput;

function decodeAwaitInput(input: unknown): AwaitSubagentsInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("await_subagents input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter((key) => !['task_ids', 'mode'].includes(key));
  if (unexpected.length > 0) {
    throw new Error(`unsupported await_subagents arguments: ${unexpected.join(", ")}`);
  }
  if (object.mode !== undefined && object.mode !== 'any' && object.mode !== 'all') throw new Error('mode must be any or all.');
  const mode = object.mode === 'all' ? 'all' : 'any';
  if (object.task_ids === undefined) return { taskIds: [], mode };
  if (!Array.isArray(object.task_ids) || object.task_ids.length === 0) {
    throw new Error("task_ids must be a non-empty array when provided.");
  }
  const taskIds = object.task_ids.map((value) =>
    typeof value === "string" ? value.trim() : ""
  );
  if (taskIds.some((value) => !value)) throw new Error("task_ids must contain non-empty strings.");
  if (new Set(taskIds).size !== taskIds.length) throw new Error("task_ids must be unique.");
  return { taskIds, mode };
}
