import { randomUUID } from "node:crypto";

import {
  type SessionSnapshot,
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
import { pluginAgentTools, validateAgentSkills, type PluginAgent } from './pluginExtensions.js';

export const SUBAGENT_TOOL = "subagent" as const;
export const AWAIT_SUBAGENTS_TOOL = "await_subagents" as const;

interface SubagentInput {
  prompt: string;
  inheritContext: boolean;
  agentType?: string;
  runInBackground?: boolean;
}

interface AwaitSubagentsInput {
  taskIds: string[];
}

export interface JoinedSubagentResult {
  taskId: string;
  message: { role: "user"; name: "subagent_result"; content: string };
}

type AwaitAsyncSubagentResults = (input: {
  parentSessionId: string;
  parentTurnId: string;
  taskIds: string[];
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
    loadPluginAgents?: () => Promise<PluginAgent[]>;
    runBackground?: <T>(session: string, turn: string, taskId: string, run: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  } = {},
): void {
  if (options.loadPluginAgents && !registry.resolve('list_plugin_agents')) registry.register({
    definition: { name: 'list_plugin_agents', description: 'List enabled plugin Agent roles. Use the exact id as subagent.agent_type to apply its instructions and tool restrictions.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    manifest: { effect_kind: 'observation', operation: 'agent.list_profiles', risk: 'low', owner: 'runtime_subagent', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: () => ({}), parallelSafe: true,
    execute: async () => (await options.loadPluginAgents!()).map(({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode, mcpServers }) => ({ id, description, tools, disallowedTools, maxTurns, background, memory, isolation, permissionMode, mcpServers: mcpServers?.flatMap(server => typeof server === 'string' ? [server] : Object.keys(server)), model: 'inherit' })),
  });
  if (registry.resolve(SUBAGENT_TOOL)) return;
  const createTaskId = options.createTaskId ?? (() => `subagent_task_${randomUUID()}`);
  const createRequestId = options.createRequestId ?? (() => `subagent_request_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? (() => `subagent_session_${randomUUID()}`);
  const createTurnId = options.createTurnId ?? (() => `subagent_turn_${randomUUID()}`);
  const createMessageId = options.createMessageId ?? (() => `subagent_message_${randomUUID()}`);

  registry.register<SubagentInput>({
    definition: {
      name: SUBAGENT_TOOL,
      description:
        "Asynchronously dispatch one substantial, bounded independent workstream to a child Agent. The call returns a task ID: continue useful parent work. Normally child results join before the parent Turn finishes. With run_in_background or a background plugin Agent, work may outlive this Turn; manage_plugin_agents lists, waits for or stops these tasks, and results enter the next parent Turn. Keep small or tightly coupled work with the parent. The child inherits pre-dispatch context by default and cannot delegate again.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          inherit_context: { type: "boolean", default: true },
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
      const taskId = createTaskId();
      const childSessionId = createSessionId();
      const childTurnId = createTurnId();
      const inherited = inheritedChildMessages(context, context.input.inheritContext);
      const profile = context.input.agentType ? (await options.loadPluginAgents?.())?.find(agent => agent.id === context.input.agentType) : undefined;
      const background = context.input.runInBackground === true || profile?.background === true;
      if (background && !options.runBackground) throw new Error('Background Agent execution is unavailable in this host.');
      if (context.input.agentType && !profile) throw new Error('The requested plugin Agent is not installed and enabled.');

      const childRequest = buildChildTurnRequest({
        context,
        registry,
        ids: {
          requestId: createRequestId(),
          sessionId: childSessionId,
          turnId: childTurnId,
          messageId: createMessageId(),
        },
        prompt: context.input.prompt,
        inherited,
        metadata: { subagentTaskId: taskId, pluginBackground: background, ...(profile ? { pluginAgentId: profile.id, pluginAgentMaxTurns: profile.maxTurns } : {}) },
        ...(profile ? {
          additionalPrefixMessages: [{ role: 'developer' as const, name: 'plugin_agent_role', content: `Plugin Agent: ${profile.id}\nPlugin directory: ${profile.root}\n${profile.prompt}\n${(profile.skills ?? []).map(skill => `\nPreloaded Skill ${skill.name} (${skill.path}):\n${skill.prompt}`).join('\n')}\n\nUse CardBush tool names; CardBush's configured child model and permission policies apply.` }],
          allowedToolNames: pluginAgentTools(profile, context.turn.request.tools.map(tool => tool.name).filter(name => registry.childDefinitions().some(tool => tool.name === name))),
        } : {}),
        permissionPolicy: options.permissionPolicy,
      });
      // Host adapters validate dependencies after acquiring Agent-local MCP connections.
      if (!profile?.mcpServers?.some(server => typeof server !== 'string')) validateAgentSkills(profile, childRequest, registry);

      tasks.start({ taskId, parentSessionId: context.sessionId, parentTurnId: context.turnId,
        childSessionId, childTurnId, background, agentProfileId: profile?.id, prompt: context.input.prompt, inheritContext: context.input.inheritContext, inheritedMessageCount: inherited.length });

      const run = (signal = context.signal) => finishTask({
        runChild,
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
        "Wait for explicitly selected outstanding Subagent tasks, or all outstanding tasks from this parent Turn when task_ids is omitted. Use this only when no useful independent parent work remains. This is a join operation, not polling. Completed results are returned as subagent_result guidance for reconciliation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
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
      const joined = await awaitAsyncResults({
        parentSessionId: context.sessionId,
        parentTurnId: context.turnId,
        taskIds: context.input.taskIds,
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

function asyncResultMessage(
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
    inheritedMessageCount: task.inheritedMessageCount,
  };
}

function taskResult(task: ReturnType<SubagentTaskStore["finish"]>): Record<string, unknown> {
  return {
    taskId: task.taskId,
    status: task.status,
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    inheritedMessageCount: task.inheritedMessageCount,
    finalResponse: task.finalResponse,
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
    (key) => key !== "prompt" && key !== "inherit_context" && key !== 'agent_type' && key !== 'run_in_background',
  );
  if (unexpected.length > 0) throw new Error(`unsupported subagent arguments: ${unexpected.join(", ")}`);
  const prompt = typeof object.prompt === "string" ? object.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (object.inherit_context !== undefined && typeof object.inherit_context !== "boolean") {
    throw new Error("inherit_context must be a boolean.");
  }
  if (object.agent_type !== undefined && (typeof object.agent_type !== 'string' || !object.agent_type.trim())) throw new Error('agent_type must be a non-empty string.');
  if (object.run_in_background !== undefined && typeof object.run_in_background !== 'boolean') throw new Error('run_in_background must be a boolean.');
  return { prompt, inheritContext: object.inherit_context !== false, agentType: object.agent_type as string | undefined, runInBackground: object.run_in_background as boolean | undefined };
}

function decodeAwaitInput(input: unknown): AwaitSubagentsInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("await_subagents input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter((key) => key !== "task_ids");
  if (unexpected.length > 0) {
    throw new Error(`unsupported await_subagents arguments: ${unexpected.join(", ")}`);
  }
  if (object.task_ids === undefined) return { taskIds: [] };
  if (!Array.isArray(object.task_ids) || object.task_ids.length === 0) {
    throw new Error("task_ids must be a non-empty array when provided.");
  }
  const taskIds = object.task_ids.map((value) =>
    typeof value === "string" ? value.trim() : ""
  );
  if (taskIds.some((value) => !value)) throw new Error("task_ids must contain non-empty strings.");
  if (new Set(taskIds).size !== taskIds.length) throw new Error("task_ids must be unique.");
  return { taskIds };
}
