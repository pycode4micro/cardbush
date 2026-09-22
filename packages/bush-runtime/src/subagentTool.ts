import { randomUUID } from "node:crypto";

import {
  DEFAULT_CHILD_AGENT_DISABLED_TOOLS,
  type SessionSnapshot,
  type RemoteSubagentRequest,
  type RemoteSubagentResult,
} from "@cardbush/bush-protocol";

import {
  buildChildTurnRequest,
  inheritedChildMessages,
  resolveChildTurn,
  type ChildTurnRunner,
  type SubagentPermissionPolicy,
} from "./childTurn.js";
import type { SubagentTaskStore } from "./subagentTaskStore.js";
import type { ToolRegistry } from "./toolRegistry.js";
import { assertParentAgent, childAgentToolDenial } from './childAgentPolicy.js';
import { CLEAN_AGENT_SETTINGS_SCHEMA, decodeCleanAgentSettings, decodeToolOrSkillNames, type CleanAgentSettings, type SubagentModelCatalog } from './cleanAgentSettings.js';
import { pluginAgentTools, validateAgentSkills, type PluginAgent } from './pluginExtensions.js';

export const SUBAGENT_TOOL = "subagent" as const;
export const AWAIT_SUBAGENTS_TOOL = "await_subagents" as const;

export interface RemoteSubagentBridge {
  list(signal?: AbortSignal): Promise<Array<{ id: string; name: string; agentId?: string }>>;
  run(input: RemoteSubagentRequest, signal?: AbortSignal): Promise<RemoteSubagentResult>;
}

interface SubagentInput {
  prompt: string;
  mode: 'fork' | 'clean';
  systemPrompt?: string;
  allowedTools?: string[];
  settings?: CleanAgentSettings;
  agentType?: string;
  runInBackground?: boolean;
  resumeTaskId?: string;
  targetAgent?: string;
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
    loadPluginAgents?: () => Promise<PluginAgent[]>;
    runBackground?: <T>(session: string, turn: string, taskId: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
    saveChildRequest?: (request: Parameters<SubagentChildRunner>[0]) => Promise<void>;
    loadChildRequest?: (sessionId: string) => Promise<Parameters<SubagentChildRunner>[0] | undefined>;
  } = {},
): void {
  if (options.loadPluginAgents && !registry.resolve('list_plugin_agents')) registry.register({
    definition: { name: 'list_plugin_agents', description: 'List enabled plugin Agent roles. Use the exact id as subagent.agent_type to apply its instructions and tool restrictions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    manifest: { effect_kind: 'observation', operation: 'agent.list_profiles', risk: 'low', owner: 'runtime_subagent', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: () => ({}), parallelSafe: true,
    execute: async () => (await options.loadPluginAgents!()).map(({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode, mcpServers }) => ({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode, mcpServers: mcpServers?.flatMap(server => typeof server === 'string' ? [server] : Object.keys(server)), model: 'inherit' })),
  });
  if (registry.resolve(SUBAGENT_TOOL)) return;
  if (!registry.resolve('list_subagent_options')) registry.register({
    definition: { name: 'list_subagent_options', description: 'Inspect available settings before a user-requested clean subagent: configured models, generation settings, permission ceiling, tool/Skill scope and plugin Agent roles. Normal delegation uses fork and does not need this setup step.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    manifest: { effect_kind: 'observation', operation: 'agent.options', risk: 'low', owner: 'runtime_subagent', dispatch_scope: 'parent_session', mutating: false },
    parallelSafe: true, decodeInput: () => ({}),
    execute: async context => {
      if (!context.turn) throw new Error('Subagent options require the current Turn context.');
      const request = context.turn.request;
      const policy = request.metadata.childAgentPolicy as Record<string, unknown> | undefined;
      const configured = options.permissionPolicy;
      const route = request.metadata.subagentPermissionRouting ?? policy?.permissionRouting ?? configured?.permissionRouting ?? 'user';
      const disabledTools = policy?.disabledTools ?? configured?.disabledTools ?? [...DEFAULT_CHILD_AGENT_DISABLED_TOOLS];
      const modelPolicy = policy?.model && typeof policy.model === 'object' ? policy.model as Record<string, unknown> : {};
      const childRequest = { ...request, metadata: { ...request.metadata, agentRole: 'child', disabledTools } };
      const result = {
        default_mode: 'fork', clean_usage: 'Use clean only when the user explicitly requests independent configuration; choose all applicable settings yourself.',
        models: (await options.models?.list(context.signal) ?? []).map(({ id, model, maxContextTokens, maxOutputTokens }) => ({ id, model, maxContextTokens, maxOutputTokens })),
        defaults: {
          model: modelPolicy.mode === 'fixed' ? { mode: 'fixed', id: modelPolicy.modelId, model: modelPolicy.model } : { mode: 'inherit' }, parent_model: request.model,
          reasoning_effort: request.reasoningEffort, max_output_tokens: modelPolicy.maxOutputTokens ?? request.maxOutputTokens,
          max_context_tokens: modelPolicy.maxContextTokens ?? request.metadata.contextWindowTokens, temperature: request.temperature, top_p: request.topP,
          permission_routing: route,
          permission_ceiling: request.permissionMode === 'all_free' || route === 'user' ? request.permissionMode : policy?.childPermissionMode ?? configured?.childPermissionMode ?? 'task_free',
          disabled_tools: disabledTools,
          allowed_skills: request.metadata.allowedSkills, disabled_skills: request.metadata.disabledSkills ?? [],
        },
        tools: request.tools.map(tool => {
          const registration = registry.resolve(tool.name);
          const restriction = registration ? childAgentToolDenial(childRequest, registration) : { message: 'Tool is no longer registered.' };
          return { name: tool.name, child_available: !restriction, ...(restriction ? { restriction: restriction.message } : {}) };
        }),
        skill_discovery: 'Use search_skills to find installed Skills; select exact values from defaults.allowed_skills when that scope is present.',
        settings: CLEAN_AGENT_SETTINGS_SCHEMA,
        remote_agents: await options.remoteAgents?.list(context.signal) ?? [],
        agent_roles: (await options.loadPluginAgents?.() ?? []).map(({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode }) => ({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode })),
      };
      // Omit unavailable optional defaults; native tool results must be JSON values.
      return JSON.parse(JSON.stringify(result));
    },
  });
  const createTaskId = options.createTaskId ?? (() => `subagent_task_${randomUUID()}`);
  const createRequestId = options.createRequestId ?? (() => `subagent_request_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? (() => `subagent_session_${randomUUID()}`);
  const createTurnId = options.createTurnId ?? (() => `subagent_turn_${randomUUID()}`);
  const createMessageId = options.createMessageId ?? (() => `subagent_message_${randomUUID()}`);

  registry.register<SubagentInput>({
    definition: {
      name: SUBAGENT_TOOL,
      description:
        "Asynchronously dispatch useful parallel work. Normally use fork (default): inherit the complete pre-dispatch conversation and shared system/tool prefix, then guide the child with prompt as a new user message. Use clean only when the user explicitly requests independent configuration; do not choose clean merely because a task looks self-contained. For clean, inspect list_subagent_options and configure the child yourself: write system_prompt and the user-role prompt, select applicable settings, allowed_tools, optional agent_type and background execution. No parent conversation or inherited system prompt is copied. Include the user's communication language, necessary facts and expected output. In either mode explain the child's work, your concurrent next steps and pending handoffs. The call returns a task ID: continue useful parent work and reconcile the result. Background work may outlive this Turn; manage_plugin_agents lists, waits for or stops it. Host permissions and child-state restrictions remain enforced; children cannot dispatch again.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1, description: "Describe the child's assignment, your concurrent next steps, expected dependencies and how the results will be reconciled. Distinguish pending inputs from established facts." },
          ...(options.remoteAgents ? { target_agent: { type: 'string', description: 'Delegate to a saved HTTP Agent ID from list_subagent_options.remote_agents. Supply prompt and target_agent only. It uses its own server workspace, model, tools and instructions; no parent history, credentials or local paths are copied. Results participate in await_subagents. Resume with resume_task_id.' } } : {}),
          ...(options.loadChildRequest ? { resume_task_id: { type: 'string', minLength: 1, description: 'Continue a finished subagent task from this parent conversation in its original child session, with its own history and identity. Supply only this ID and a new prompt. A running child cannot be resumed concurrently.' } } : {}),
          mode: { type: 'string', enum: ['fork', 'clean'], default: 'fork', description: 'Normally use fork and append prompt to the inherited conversation. Use clean only at the user’s explicit request for independent configuration, then choose its settings yourself.' },
          system_prompt: { type: 'string', minLength: 1, description: 'Required in clean mode; unavailable in fork mode. Sets the actual system message for the child. Define its role, behavior, communication language and output requirements. Host permissions cannot be overridden.' },
          allowed_tools: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Clean mode only. Exact tool names from your exposed catalog; omitted keeps the parent catalog, [] permits no tools. Intersects with any plugin Agent role and host restrictions. Enforced at execution, not just a prompt suggestion.' },
          settings: CLEAN_AGENT_SETTINGS_SCHEMA,
          ...(options.runBackground ? { run_in_background: { type: 'boolean', default: false } } : {}),
          ...(options.loadPluginAgents ? { agent_type: { type: 'string', description: 'Optional exact plugin Agent id from list_plugin_agents. Its role and tool restrictions apply to the child.' } } : {}),
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
    execute: async (context) => {
      if (!context.turn) throw new Error("Subagent dispatch requires the parent Turn context.");
      assertParentAgent(context.turn.request);
      const taskId = createTaskId();
      const previous = context.input.resumeTaskId ? tasks.get(context.sessionId, context.input.resumeTaskId) : undefined;
      if (context.input.resumeTaskId && (!previous || previous.origin !== 'subagent')) throw new Error('Only a subagent task owned by this parent conversation can be resumed.');
      if (previous && tasks.list(context.sessionId).some(task => task.childSessionId === previous.childSessionId && task.status === 'running')) throw new Error('This child session is still running. Await its result before resuming.');
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
        if (options.asyncDispatch) {
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
      const inheritContext = previous?.inheritContext ?? context.input.mode === 'fork';
      const inherited = previous ? [] : inheritedChildMessages(context, inheritContext);
      const agentType = previous?.agentProfileId ?? context.input.agentType;
      const profile = agentType ? (await options.loadPluginAgents?.())?.find(agent => agent.id === agentType) : undefined;
      const background = previous?.background === true || context.input.runInBackground === true || profile?.background === true;
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
        metadata: { subagentTaskId: taskId, subagentMode: context.input.mode, pluginBackground: background, ...(profile ? { pluginAgentId: profile.id, pluginAgentMaxTurns: profile.maxTurns } : {}) },
        ...(profile ? {
          additionalPrefixMessages: [{ role: 'developer' as const, name: 'plugin_agent_role', content: `Plugin Agent: ${profile.id}\nPlugin directory: ${profile.root}\n${profile.prompt}\n${(profile.skills ?? []).map(skill => `\nPreloaded Skill ${skill.name} (${skill.path}):\n${skill.prompt}`).join('\n')}\n\nUse CardBush tool names; CardBush's configured child model and permission policies apply.` }],
          allowedToolNames: pluginAgentTools(profile, context.turn.request.tools.map(tool => tool.name).filter(name => registry.childDefinitions().some(tool => tool.name === name))),
        } : {}),
        permissionPolicy: options.permissionPolicy,
      });
      if (saved) {
        if (saved.metadata.workspaceDir !== childRequest.metadata.workspaceDir || saved.metadata.projectDir !== childRequest.metadata.projectDir)
          throw new Error('The parent workspace changed. Start a new child for that workspace instead of moving an existing child implicitly.');
        const originalTools = new Set(saved.tools.map(tool => tool.name));
        const levels = ['task_free', 'user_free', 'all_free'];
        const routing = saved.metadata.permissionRouting === 'parent' ? 'parent' : childRequest.metadata.permissionRouting;
        const disabled = [...new Set([...(saved.metadata.disabledTools as string[] ?? []), ...(childRequest.metadata.disabledTools as string[] ?? [])])];
        const turnLimits = [saved.metadata.pluginAgentMaxTurns, childRequest.metadata.pluginAgentMaxTurns]
          .filter((value): value is number => typeof value === 'number');
        childRequest = { ...saved, requestId: childRequest.requestId, turnId: childTurnId,
          inputMessages: childRequest.inputMessages, sessionMetadata: childRequest.sessionMetadata,
          tools: childRequest.tools.filter(tool => originalTools.has(tool.name)),
          permissionMode: levels[Math.min(levels.indexOf(saved.permissionMode), levels.indexOf(childRequest.permissionMode))] as typeof saved.permissionMode,
          metadata: { ...saved.metadata, ...childRequest.metadata, disabledTools: disabled,
            // Model configuration belongs to the original child, even if the parent changed models.
            contextWindowTokens: saved.metadata.contextWindowTokens,
            childAgentModelMode: saved.metadata.childAgentModelMode,
            childAgentModelId: saved.metadata.childAgentModelId,
            ...(turnLimits.length ? { pluginAgentMaxTurns: Math.min(...turnLimits) } : {}),
            permissionRouting: routing, permissionScopeSessionId: routing === 'parent' ? childSessionId : context.sessionId,
            childToolAllowlist: childRequest.tools.filter(tool => originalTools.has(tool.name)).map(tool => tool.name),
            ...(saved.metadata.allowedSkills ? { allowedSkills: (saved.metadata.allowedSkills as string[]).filter(name => !Array.isArray(childRequest.metadata.allowedSkills) || childRequest.metadata.allowedSkills.includes(name)) } : {}),
            disabledSkills: [...new Set([...(saved.metadata.disabledSkills as string[] ?? []), ...(childRequest.metadata.disabledSkills as string[] ?? [])])],
          } };
      }
      // Host adapters validate dependencies after acquiring Agent-local MCP connections.
      if (!profile?.mcpServers?.some(server => typeof server !== 'string')) validateAgentSkills(profile, childRequest, registry);

      if (previous && tasks.list(context.sessionId).some(task => task.childSessionId === previous.childSessionId && task.status === 'running')) throw new Error('This child session is still running.');

      tasks.start({ taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId,
        childSessionId, childTurnId, background, agentProfileId: profile?.id, prompt: context.input.prompt, inheritContext, inheritedMessageCount: saved?.prefixMessages.length ?? inherited.length,
        ...(previous ? { resumedFromTaskId: previous.taskId } : {}) });

      const run = (signal = context.signal) => finishTask({
        runChild: async (request, childSignal) => { if (!saved) await options.saveChildRequest?.(request); return runChild(request, childSignal); },
        childRequest,
        signal,
        childTurnId,
        tasks,
        parentSessionId: context.sessionId,
        taskId,
      });
      const completion = background ? options.runBackground!(context.sessionId, context.turnId, taskId, run) : run();
      if (background) return { ...submittedResult(tasks.get(context.sessionId, taskId)!), background: true, instructions: 'Background task started. Its result is pending; use manage_plugin_agents when needed.' };
      if (options.asyncDispatch) {
        options.onAsyncResult?.({
          parentSessionId: context.sessionId,
          parentTurnId: context.turnId,
          taskId,
          result: completion.then(asyncResultMessage),
        });
        return submittedResult(tasks.get(context.sessionId, taskId)!);
      }
      return taskResult(await completion);
    },
  });
  if (options.awaitAsyncResults && !registry.resolve(AWAIT_SUBAGENTS_TOOL)) {
    registerAwaitSubagentsTool(registry, options.awaitAsyncResults);
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
        "Wait for selected Subagent tasks, or outstanding tasks from this parent Turn when task_ids is omitted. mode=any (default) returns as soon as one selected task finishes; mode=all joins every selected task. Other tasks keep running. Use this when progress depends on a selected result or no useful independent work remains. Completed results are returned for reconciliation without polling.",
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
    content: `<subagent_result task_id="${task.taskId}" status="${task.status}">\n${body}\n</subagent_result>`,
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

function decodeInput(input: unknown): SubagentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("subagent input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter(
    (key) => !['prompt', 'mode', 'system_prompt', 'allowed_tools', 'settings', 'inherit_context', 'agent_type', 'run_in_background', 'resume_task_id', 'target_agent'].includes(key),
  );
  if (unexpected.length > 0) throw new Error(`unsupported subagent arguments: ${unexpected.join(", ")}`);
  const prompt = typeof object.prompt === "string" ? object.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (object.target_agent !== undefined) {
    if (typeof object.target_agent !== 'string' || !object.target_agent.trim()) throw new Error('target_agent must be a saved Agent connection ID.');
    if (Object.keys(object).some(key => !['prompt', 'target_agent'].includes(key))) throw new Error('Remote delegation accepts prompt and target_agent only; the server owns its configuration.');
    return { prompt, mode: 'clean', targetAgent: object.target_agent.trim() };
  }
  if (object.resume_task_id !== undefined) {
    if (typeof object.resume_task_id !== 'string' || !object.resume_task_id.trim()) throw new Error('resume_task_id must be non-empty.');
    if (Object.keys(object).some(key => !['prompt', 'resume_task_id'].includes(key))) throw new Error('Resume accepts only prompt and resume_task_id; the original configuration is preserved.');
    return { prompt, mode: 'fork', resumeTaskId: object.resume_task_id.trim() };
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
