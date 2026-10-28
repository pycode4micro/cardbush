import { randomUUID } from "node:crypto";

import {
  registeredAgentSchema,
  resolveSubagentName,
  SUBAGENT_NAME_MAX_LENGTH,
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
import { childConversationPage, childConversationReadHint, type ChildConversationSource } from './subagentConversation.js';
import { presentTool } from './toolPresentation.js';
import { onlySubagentArguments, subagentInputSchema } from './subagentContract.js';

export const SUBAGENT_TOOL = "subagent" as const;

function fallbackSubagentName(sessionId: string, language: unknown) {
  // The child session survives follow-ups; task IDs and assignment messages do not.
  return `${language === 'en' ? 'Subagent' : '子 Agent'} ${sessionId.slice(-8)}`;
}

export interface RemoteSubagentBridge {
  list(signal?: AbortSignal): Promise<Array<{ id: string; name: string; agentId?: string }>>;
  run(input: RemoteSubagentRequest, signal?: AbortSignal): Promise<RemoteSubagentResult>;
  read?(input: { connectionId: string; agentId?: string; parentSessionId: string; sessionId: string }, signal?: AbortSignal): Promise<SessionSnapshot | undefined>;
  guide?(input: { connectionId: string; agentId?: string; parentSessionId: string; sessionId: string; turnId: string; messageId: string; content: string }, signal?: AbortSignal): Promise<unknown>;
}

export interface SubagentInput {
  prompt: string;
  name?: string;
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
  readConversation?(context: ToolHandlerContext<unknown>, taskId: string, cursor?: string): Promise<unknown>;
}

export interface JoinedSubagentResult {
  taskId: string;
  message: { role: "user"; name: "subagent_result" | "background_tool_result"; content: string };
}

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
  // Task conversation reads retain the same ownership check,
  // remote bridge and privacy-preserving conversation projection.
  const readConversation = async (context: ToolHandlerContext<unknown>, taskId: string, cursor?: string) => {
    assertParentAgent(context.turn?.request);
    const task = tasks.get(context.sessionId, taskId);
    if (!task) throw new Error('This child task does not belong to the current parent conversation.');
    if (context.turn?.request.metadata.toolExecutionPolicy === 'web_restricted' && !task.remote) throw new Error('Only remote child conversations are available.');
    const session = task.remote
      ? await options.remoteAgents?.read?.({ ...task.remote, parentSessionId: context.sessionId, sessionId: task.childSessionId }, context.signal)
      : options.readChildConversation?.(task.childSessionId);
    if (!session) throw new Error('The child conversation is not available yet.');
    return { taskId: task.taskId, ...(task.agentName ? { agentName: task.agentName } : {}), status: task.status, ...childConversationPage(session, cursor) };
  };
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
        "Delegate ad-hoc work to one child per call; use separate calls for independent assignments, even with several agents. Choose team when the host should schedule a saved dependency workflow and resume unfinished steps. Follow up on an owned child with task_id and prompt: running children receive guidance; finished children resume their session and name. Give new ad-hoc children short responsibility names. Fork continuations inherit the current parent model; configured clean children retain theirs. Use tasks to inspect, wait, stop or read child conversations. Continue independent work and reconcile subagent_result. Independent peers use an available collaboration plugin. Host permissions and child restrictions remain enforced.",
      inputSchema: subagentInputSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          ...(options.agents ? {
            action: { type: 'string', enum: ['run', 'save', 'delete'], default: 'run', description: 'run dispatches work. save registers/updates a reusable clean employee; delete removes its definition, retaining recorded conversations.' },
            agent_id: { type: 'string', description: 'Employee definition ID from list_subagent_options.registered_agents[].id. Starts a new clean child with saved configuration. Continue an existing child with task_id instead; omit configuration overrides.' },
            agent: REGISTERED_AGENT_SCHEMA,
            expected_revision: { type: 'integer', minimum: 0, description: 'Required for save/delete. 0 creates a new definition; otherwise use its observed revision.' },
          } : {}),
          prompt: { type: "string", minLength: 1, description: "Child assignment as a user message: necessary facts, original user's communication language, expected output, your concurrent next steps and handoffs. Distinguish pending dependencies from confirmed facts." },
          name: { type: 'string', minLength: 1, maxLength: SUBAGENT_NAME_MAX_LENGTH, description: 'Short responsibility label in the user\'s language, e.g. 视觉设计 or API reviewer; put assignment details in prompt. New ad-hoc children only. Omit when task_id or agent_id is supplied: follow-ups and registered employees keep their existing name. This labels the task without changing its instructions or permissions.' },
          ...(options.remoteAgents ? { target_agent: { type: 'string', description: 'Saved HTTP Agent ID from list_subagent_options.remote_agents. Supply prompt, target_agent and optional name; follow up with task_id. Uses its own workspace, model, tools and instructions; parent history, credentials and local paths are not copied. Results arrive as subagent_result.' } } : {}),
          ...(options.loadChildRequest || options.guideChild || options.remoteAgents ? { task_id: { type: 'string', minLength: 1, description: 'Owned child taskId from a subagent result, or task_id with kind=subagent from tasks list. Never substitute agent_id, childSessionId, team run_id or a workflow node ID. Supply task_id and prompt, with optional run_in_background; the original history and execution host are retained.' } } : {}),
          mode: { type: 'string', enum: ['fork', 'clean'], default: 'fork', description: 'fork is a snapshot of the pre-dispatch conversation and intent; later parent messages are not synchronized. clean uses a registered agent_id, or explicit independent system_prompt/settings. Discover reusable employees with list_subagent_options. Each new clean task has its own conversation; use task_id to continue an existing task.' },
          system_prompt: { type: 'string', minLength: 1, description: 'Required for an unregistered clean Agent; omit when using agent_id or fork. Sets the actual system message. Host permissions cannot be overridden.' },
          allowed_tools: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Clean mode only. Exact tool names from your exposed catalog; omitted keeps the parent catalog, [] permits no tools. Intersects with any plugin Agent role and host restrictions. Enforced at execution, not just a prompt suggestion.' },
          settings: CLEAN_AGENT_SETTINGS_SCHEMA,
          ...(options.runBackground ? { run_in_background: { type: 'boolean', default: false } } : {}),
          ...(options.loadPluginAgents ? { agent_type: { type: 'string', description: 'Optional exact plugin Agent id from list_subagent_options.agent_roles. Its role and tool restrictions apply to the child.' } } : {}),
        },
      }),
    },
    projectModelDefinition: (definition, scope) => !scope.canRecall ? definition : presentTool(definition, {
      fields: ['action', 'name', 'prompt', 'agent_id', 'agent_type', 'task_id', 'target_agent', 'mode', 'run_in_background'], actions: ['run'],
      description: `Delegate ad-hoc work to one child per call; separate calls suit independent assignments even with several agents. Choose team for saved dependency workflows scheduled by the host. Start with a saved agent_id, plugin agent_type or fork. Give new ad-hoc children a short responsibility name; put assignment details in prompt. Follow up with task_id and prompt only (optional run_in_background); omit name, mode and configuration. The host retains the original name and execution scope. Use tasks to inspect/wait for results, stop tasks or read child conversations. Independent peers use an available collaboration plugin. For employee registration or a new clean agent's configuration, load get_tool_schema(name="subagent"), then use call_tool with its full arguments.`,
    }),
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
  return { dispatch, ...(options.readChildConversation ? { readConversation } : {}) };

  async function dispatch(context: ToolHandlerContext<SubagentInput>, execution: SubagentExecutionOptions = {}) {
      if (!context.turn) throw new Error("Subagent dispatch requires the parent Turn context.");
      assertParentAgent(context.turn.request);
      if (context.turn.request.metadata.toolExecutionPolicy === 'web_restricted' &&
          (context.input.registration || context.input.agentId || context.input.agentType || context.input.systemPrompt || context.input.settings || context.input.allowedTools || context.input.runInBackground || execution.team || execution.agent))
        throw new Error('This deployment only permits administrator-registered remote Agents.');
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
      if (context.turn.request.metadata.toolExecutionPolicy === 'web_restricted' &&
          (!context.input.targetAgent && !previous?.remote || previous && !previous.remote))
        throw new Error('Local subagent execution is forbidden in this deployment.');
      if (context.input.taskId && !previous) throw new Error('Only a subagent task owned by this parent conversation can receive a follow-up. Use taskId from the subagent result or task_id with kind=subagent from tasks list; employee IDs, childSessionId and Team run IDs are not child task IDs.');
      if (previous && previous.origin !== 'subagent' && (!execution.team || previous.teamId !== execution.team.id)) throw new Error('This task belongs to a Team workflow node. Use team resume with the workflow run_id for unfinished steps, or tasks to inspect/stop the workflow run.');
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
          return { status: 'message_queued', taskId: running.taskId, ...(running.agentName ? { agentName: running.agentName } : {}), childSessionId: running.childSessionId, receipt };
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
          agentName: previous?.agentName ?? resolveSubagentName({ name: context.input.name ?? target.name }) ?? fallbackSubagentName(childSessionId, parent.metadata.uiLanguage),
          prompt: context.input.prompt, inheritContext: false, inheritedMessageCount: 0, remote, ...(previous ? { resumedFromTaskId: previous.taskId } : {}) });
        const completion = options.remoteAgents.run({ ...remote, taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId,
          sessionId: childSessionId, turnId: childTurnId, prompt: context.input.prompt,
          permissionMode, language: String(parent.metadata.uiLanguage || 'zh'),
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
      if (context.input.agentId && !registered) throw new Error('The registered Agent does not exist. Use agent_id from list_subagent_options.registered_agents[].id to start a new child, or task_id from a subagent result to continue an existing child.');
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
      const agentName = previous?.agentName ?? registered?.definition.name ?? resolveSubagentName({
        name: context.input.name ?? profile?.name, systemPrompt: context.input.systemPrompt,
      }) ?? fallbackSubagentName(childSessionId, context.turn?.request.metadata.uiLanguage);
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
        metadata: { subagentTaskId: taskId, subagentName: agentName, subagentMode: context.input.mode, pluginBackground: background,
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
        agentName,
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
      if (background) return { ...submittedResult(tasks.get(context.sessionId, taskId)!), background: true,
        instructions: `Background task started. Continue independent work; use tasks when its result is needed.` };
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
    content: `<subagent_result task_id="${task.taskId}"${task.agentName ? ` agent_name="${task.agentName.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}"` : ''} status="${task.status}">\n${body}\n${childConversationReadHint(task.taskId)}\n</subagent_result>`,
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
    ...(task.agentProfileId ? { agentProfileId: task.agentProfileId } : {}),
    ...(task.agentName ? { agentName: task.agentName } : {}),
    taskId: task.taskId,
    status: task.status,
    ...(task.status === 'running' ? { next_step: 'Continue independent work now. The child result arrives automatically; wait only when it blocks the next step.' } : {}),
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    mode: task.inheritContext ? 'fork' : 'clean',
    inheritedMessageCount: task.inheritedMessageCount,
    ...(task.remote ? { remote: task.remote } : {}),
  };
}

function taskResult(task: ReturnType<SubagentTaskStore["finish"]>): Record<string, unknown> {
  return {
    ...(task.agentProfileId ? { agentProfileId: task.agentProfileId } : {}),
    ...(task.agentName ? { agentName: task.agentName } : {}),
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
    (key) => !['prompt', 'name', 'mode', 'system_prompt', 'allowed_tools', 'settings', 'agent_type', 'run_in_background', 'task_id', 'target_agent', 'action', 'agent_id', 'agent', 'expected_revision'].includes(key),
  );
  if (unexpected.length > 0) throw new Error(`unsupported subagent arguments: ${unexpected.join(", ")}`);
  if (object.action !== undefined && !['run', 'save', 'delete'].includes(String(object.action))) throw new Error('Invalid subagent action.');
  if (object.action === 'save' || object.action === 'delete') {
    if (!onlySubagentArguments(object, object.action) || !Number.isSafeInteger(object.expected_revision) || Number(object.expected_revision) < 0) throw new Error('Registration requires the definition/agent_id and expected_revision only.');
    if (object.action === 'save') registeredAgentSchema.parse(object.agent);
    if (object.action === 'delete' && (typeof object.agent_id !== 'string' || !object.agent_id.trim())) throw new Error('agent_id is required.');
    return { prompt: '', mode: 'clean', registration: { action: object.action, agent: object.agent, id: object.agent_id as string | undefined, revision: Number(object.expected_revision) } };
  }
  if (object.agent !== undefined || object.expected_revision !== undefined) throw new Error('agent and expected_revision require a registration action.');
  if (['agent_id', 'task_id', 'target_agent'].filter(key => object[key] !== undefined).length > 1) throw new Error('Choose one target: agent_id starts a saved employee, target_agent starts a saved remote Agent, or task_id follows up on an owned child. Do not combine these IDs.');
  const prompt = typeof object.prompt === "string" ? object.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (object.name !== undefined && (typeof object.name !== 'string' || !object.name.trim() || object.name.length > SUBAGENT_NAME_MAX_LENGTH || /[\r\n]/.test(object.name))) {
    throw new Error(`name must be a non-empty single-line label of at most ${SUBAGENT_NAME_MAX_LENGTH} characters.`);
  }
  const name = typeof object.name === 'string' ? object.name.trim() : undefined;
  if (object.agent_id !== undefined) {
    if (typeof object.agent_id !== 'string' || !object.agent_id.trim() || object.mode !== undefined && object.mode !== 'clean' ||
        !onlySubagentArguments(object, 'employee')) throw new Error('A registered employee accepts agent_id, prompt, clean mode and optional run_in_background only.');
    if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
    return { prompt, mode: 'clean', agentId: object.agent_id.trim(), runInBackground: object.run_in_background as boolean | undefined };
  }
  if (object.target_agent !== undefined) {
    if (typeof object.target_agent !== 'string' || !object.target_agent.trim()) throw new Error('target_agent must be a saved Agent connection ID.');
    if (!onlySubagentArguments(object, 'remote')) throw new Error('Remote delegation accepts prompt, target_agent and optional name only; the server owns its configuration.');
    return { prompt, name, mode: 'clean', targetAgent: object.target_agent.trim() };
  }
  if (object.task_id !== undefined) {
    if (typeof object.task_id !== 'string' || !object.task_id.trim()) throw new Error('task_id must be non-empty.');
    if (!onlySubagentArguments(object, 'followup')) throw new Error('Follow-up accepts prompt, task_id and optional run_in_background (action may be run). Remove name, mode, agent_type and configuration fields; the existing child keeps its name and configuration. This call has not started or guided any child.');
    if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
    return { prompt, mode: 'fork', taskId: object.task_id.trim(), runInBackground: object.run_in_background as boolean | undefined };
  }
  if (object.mode !== undefined && object.mode !== 'fork' && object.mode !== 'clean') throw new Error('mode must be fork or clean.');
  const mode = object.mode ?? 'fork';
  if (mode === 'fork' && (object.system_prompt !== undefined || object.allowed_tools !== undefined || object.settings !== undefined)) throw new Error('system_prompt, allowed_tools and settings require clean mode; fork preserves the parent prefix.');
  if ((object.mode === 'clean' || object.system_prompt !== undefined) && (typeof object.system_prompt !== 'string' || !object.system_prompt.trim())) throw new Error('clean mode requires a non-empty system_prompt.');
  const allowedTools = object.allowed_tools === undefined ? undefined : decodeToolOrSkillNames(object.allowed_tools, 'allowed_tools');
  const settings = object.settings === undefined ? undefined : decodeCleanAgentSettings(object.settings);
  if (object.agent_type !== undefined && (typeof object.agent_type !== 'string' || !object.agent_type.trim())) throw new Error('agent_type must be a non-empty string.');
  if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
  return { prompt, name, mode, systemPrompt: object.system_prompt as string | undefined, allowedTools, settings, agentType: object.agent_type as string | undefined, runInBackground: object.run_in_background as boolean | undefined };
}

const decodeInput = decodeSubagentInput;
