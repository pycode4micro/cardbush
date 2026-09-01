import { randomUUID } from "node:crypto";

import {
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
  type SessionSnapshot,
  type ToolResult,
} from "@cardbush/bush-protocol";

import {
  buildChildTurnRequest,
  inheritedChildMessages,
  resolveChildTurn,
  type ChildTurnRunner,
  type SubagentPermissionPolicy,
} from "./childTurn.js";
import type { SubagentTaskStore } from "./subagentTaskStore.js";
import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const SUBAGENT_TOOL = "subagent" as const;
export const AWAIT_SUBAGENTS_TOOL = "await_subagents" as const;

interface SubagentInput {
  prompt: string;
  inheritContext: boolean;
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
    createReceiptId?: () => string;
    asyncDispatch?: boolean;
    onAsyncResult?: (input: {
      parentSessionId: string;
      parentTurnId: string;
      taskId: string;
      result: Promise<{ role: "user"; name: "subagent_result"; content: string } | null>;
    }) => void;
    awaitAsyncResults?: AwaitAsyncSubagentResults;
    permissionPolicy?: SubagentPermissionPolicy;
  } = {},
): void {
  if (registry.resolve(SUBAGENT_TOOL)) return;
  const createTaskId = options.createTaskId ?? (() => `subagent_task_${randomUUID()}`);
  const createRequestId = options.createRequestId ?? (() => `subagent_request_${randomUUID()}`);
  const createSessionId = options.createSessionId ?? (() => `subagent_session_${randomUUID()}`);
  const createTurnId = options.createTurnId ?? (() => `subagent_turn_${randomUUID()}`);
  const createMessageId = options.createMessageId ?? (() => `subagent_message_${randomUUID()}`);
  const createReceiptId = options.createReceiptId ?? (() => `receipt_${randomUUID()}`);

  registry.register<SubagentInput>({
    definition: {
      name: SUBAGENT_TOOL,
      description:
        "Asynchronously dispatch exactly one substantial, bounded and independent workstream to a child Agent. The call returns a task ID immediately: continue useful independent parent work instead of polling or waiting. Dispatch multiple independent workstreams as separate subagent calls in the same response. Completed child results are delivered at safe parent-round boundaries and must be reconciled before the parent Turn can finish. Keep small, tightly coupled or sequential work with the parent. The child inherits the pre-dispatch conversation by default and cannot delegate again.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          inherit_context: { type: "boolean", default: true },
        },
      },
    },
    manifest: {
      effect_kind: "delegation",
      operation: "agent.delegate",
      risk: "low",
      owner: "runtime_subagent",
      dispatch_phase: "execution",
      dispatch_scope: "child_session",
      dispatch_side_effect: "delegated_execution",
      dispatch_mutating: true,
      dispatch_source: "registered_tool",
      stage_modes: ["execute"],
      output_kinds: ["structured_data", "user_guidance"],
      handoff_exports: ["terminal_response"],
      evidence_hints: ["subagent_task"],
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
      tasks.start({
        taskId,
        parentSessionId: context.sessionId,
        parentTurnId: context.turnId,
        childSessionId,
        childTurnId,
        prompt: context.input.prompt,
        inheritContext: context.input.inheritContext,
        inheritedMessageCount: inherited.length,
      });

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
        metadata: { subagentTaskId: taskId },
        permissionPolicy: options.permissionPolicy,
      });

      const completion = finishTask({
        runChild,
        childRequest,
        signal: context.signal,
        childTurnId,
        tasks,
        parentSessionId: context.sessionId,
        taskId,
      });
      if (options.asyncDispatch) {
        options.onAsyncResult?.({
          parentSessionId: context.sessionId,
          parentTurnId: context.turnId,
          taskId,
          result: completion.then(asyncResultMessage),
        });
        return submittedResult(context, tasks.get(context.sessionId, taskId)!, createReceiptId());
      }
      return result(context, await completion, createReceiptId());
    },
  });
  if (options.awaitAsyncResults && !registry.resolve(AWAIT_SUBAGENTS_TOOL)) {
    registerAwaitSubagentsTool(registry, options.awaitAsyncResults, createReceiptId);
  }
}

function registerAwaitSubagentsTool(
  registry: ToolRegistry,
  awaitAsyncResults: AwaitAsyncSubagentResults,
  createReceiptId: () => string,
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
      dispatch_phase: "execution",
      dispatch_scope: "child_session",
      dispatch_side_effect: "none",
      dispatch_mutating: false,
      dispatch_source: "registered_tool",
      stage_modes: ["execute"],
      output_kinds: ["structured_data", "user_guidance"],
      handoff_exports: ["terminal_response"],
      evidence_hints: ["subagent_task"],
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
        protocol: BUSH_TOOL_RESULT_PROTOCOL,
        tool_call_id: context.toolCall.id,
        success: true,
        output: {
          status: "joined",
          taskIds: joined.map((result) => result.taskId),
          count: joined.length,
        },
        facts: [{
          protocol: BUSH_EXECUTION_FACT_PROTOCOL,
          receipt_id: createReceiptId(),
          action_manifest_id: context.actionManifest.manifest_id,
          status: "succeeded",
          operation: context.actionManifest.operation,
          effect_kind: context.actionManifest.effect_kind,
          owner: context.actionManifest.owner,
          dispatch_scope: context.actionManifest.dispatch_scope,
          categories: ["subagent_task"],
          paths: [],
          execution_success: true,
          semantic_success: true,
          verification_state: "verified",
          error_code: "",
        }],
        artifacts: [],
        workspace_changes: [],
        guidance: joined.map((result) => result.message),
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

function submittedResult(
  context: ToolHandlerContext<SubagentInput>,
  task: ReturnType<SubagentTaskStore["start"]>,
  receiptId: string,
): ToolResult {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: true,
    output: {
      taskId: task.taskId,
      status: task.status,
      childSessionId: task.childSessionId,
      childTurnId: task.childTurnId,
      inheritedMessageCount: task.inheritedMessageCount,
    },
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: "submitted",
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["subagent_task"],
      paths: [],
      execution_success: true,
      semantic_success: true,
      verification_state: "verified",
      error_code: "",
    }],
    artifacts: [], workspace_changes: [], guidance: [],
  };
}

function result(
  context: ToolHandlerContext<SubagentInput>,
  task: ReturnType<SubagentTaskStore["finish"]>,
  receiptId: string,
): ToolResult {
  const completed = task.status === "completed";
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: context.toolCall.id,
    success: completed,
    output: {
      taskId: task.taskId,
      status: task.status,
      childSessionId: task.childSessionId,
      childTurnId: task.childTurnId,
      inheritedMessageCount: task.inheritedMessageCount,
      errorMessage: task.errorMessage,
      usage: task.usage,
    },
    facts: [{
      protocol: BUSH_EXECUTION_FACT_PROTOCOL,
      receipt_id: receiptId,
      action_manifest_id: context.actionManifest.manifest_id,
      status: completed ? "succeeded" : task.status,
      operation: context.actionManifest.operation,
      effect_kind: context.actionManifest.effect_kind,
      owner: context.actionManifest.owner,
      dispatch_scope: context.actionManifest.dispatch_scope,
      categories: ["subagent_task"],
      paths: [],
      execution_success: true,
      semantic_success: completed,
      verification_state: completed ? "verified" : "failed",
      error_code: completed ? "" : task.errorMessage || "subagent_failed",
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: task.finalResponse
      ? [{ role: "user", name: "subagent_result", content: task.finalResponse }]
      : [],
    ...(completed
      ? {}
      : {
          error: {
            kind: task.status === "stopped" ? "cancelled" : "tool",
            code: task.status === "stopped" ? "subagent_stopped" : "subagent_failed",
            message: task.errorMessage,
            details: { taskId: task.taskId },
          },
        }),
  };
}

function decodeInput(input: unknown): SubagentInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("subagent input must be an object.");
  }
  const object = input as Record<string, unknown>;
  const unexpected = Object.keys(object).filter(
    (key) => key !== "prompt" && key !== "inherit_context",
  );
  if (unexpected.length > 0) throw new Error(`unsupported subagent arguments: ${unexpected.join(", ")}`);
  const prompt = typeof object.prompt === "string" ? object.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required.");
  if (object.inherit_context !== undefined && typeof object.inherit_context !== "boolean") {
    throw new Error("inherit_context must be a boolean.");
  }
  return { prompt, inheritContext: object.inherit_context !== false };
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
