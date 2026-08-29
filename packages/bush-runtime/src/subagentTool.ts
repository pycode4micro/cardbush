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
} from "./childTurn.js";
import type { SubagentTaskStore } from "./subagentTaskStore.js";
import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export const SUBAGENT_TOOL = "subagent" as const;

interface SubagentInput {
  prompt: string;
  inheritContext: boolean;
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
    createReceiptId?: () => string;
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
        "Dispatch one substantial, bounded and independent workstream to a child Agent when parallel execution or context isolation outweighs delegation cost. Keep small, tightly coupled or sequential work with the parent. The child inherits the pre-dispatch conversation by default, cannot delegate again, and returns its terminal response as user guidance for parent reconciliation.",
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
    visibleToChild: false,
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
      });

      let status: "completed" | "failed" | "stopped" = "failed";
      let finalResponse = "";
      let errorMessage = "";
      let usage: SessionSnapshot["turns"][number]["usage"] = {};
      try {
        const result = await runChild(childRequest, context.signal);
        ({ status, finalResponse, errorMessage, usage } = resolveChildTurn(
          result,
          childTurnId,
        ));
      } catch (error) {
        status = context.signal?.aborted ? "stopped" : "failed";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
      const task = tasks.finish({
        parentSessionId: context.sessionId,
        taskId,
        status,
        finalResponse,
        errorMessage,
        usage,
      });
      return result(context, task, createReceiptId());
    },
  });
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
