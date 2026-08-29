import {
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  modelMessageSchema,
  type ModelMessage,
  type RuntimeEvent,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import type { ToolHandlerContext, ToolRegistry } from "./toolRegistry.js";

export interface ChildTurnResult {
  terminal: RuntimeEvent;
  session: SessionSnapshot | undefined;
}

export type ChildTurnRunner = (
  request: RuntimeSessionTurnRequest,
  signal?: AbortSignal,
) => Promise<ChildTurnResult>;

export interface ChildTurnIds {
  requestId: string;
  sessionId: string;
  turnId: string;
  messageId: string;
}

export function inheritedChildMessages(
  context: ToolHandlerContext<unknown>,
  inheritContext: boolean,
): ModelMessage[] {
  if (!context.turn || !inheritContext) return [];
  return context.turn.contextMessages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  );
}

export function buildChildTurnRequest(input: {
  context: ToolHandlerContext<unknown>;
  registry: ToolRegistry;
  ids: ChildTurnIds;
  prompt: string;
  inherited: ModelMessage[];
  metadata: Record<string, unknown>;
  additionalPrefixMessages?: ModelMessage[];
  allowedToolNames?: string[];
  toolChoice?: "auto" | "none" | "required";
}): RuntimeSessionTurnRequest {
  if (!input.context.turn) throw new Error("Child dispatch requires the parent Turn context.");
  const parentRequest = input.context.turn.request;
  const parentVisibleNames = new Set(parentRequest.tools.map((tool) => tool.name));
  const childVisible = new Map(
    input.registry.childDefinitions().map((definition) => [definition.name, definition]),
  );
  const requestedNames = input.allowedToolNames
    ? [...new Set(input.allowedToolNames)]
    : [...childVisible.keys()].filter((name) => parentVisibleNames.has(name));
  const unavailable = input.allowedToolNames
    ? requestedNames.filter((name) => !parentVisibleNames.has(name) || !childVisible.has(name))
    : [];
  if (unavailable.length > 0) {
    throw new Error(`Child Tools are not exposed by the parent Turn: ${unavailable.join(", ")}.`);
  }
  const childTools = requestedNames.map((name) => childVisible.get(name)!);
  return {
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId: input.ids.requestId,
    sessionId: input.ids.sessionId,
    turnId: input.ids.turnId,
    model: parentRequest.model,
    providerBinding: parentRequest.providerBinding,
    prefixMessages: [
      ...childPrefixMessages(parentRequest.metadata),
      ...(input.additionalPrefixMessages ?? []),
      ...input.inherited,
    ],
    inputMessages: [{
      messageId: input.ids.messageId,
      message: { role: "user", content: input.prompt },
    }],
    tools: childTools,
    toolChoice: input.toolChoice ?? (childTools.length > 0 ? "auto" : "none"),
    maxOutputTokens: parentRequest.maxOutputTokens,
    temperature: parentRequest.temperature,
    topP: parentRequest.topP,
    reasoningEffort: parentRequest.reasoningEffort,
    metadata: {
      ...parentRequest.metadata,
      agentRole: "child",
      parentSessionId: input.context.sessionId,
      parentTurnId: input.context.turnId,
      inheritedObservationSessionId: input.context.sessionId,
      ...input.metadata,
    },
  };
}

export function resolveChildTurn(
  result: ChildTurnResult,
  childTurnId: string,
): {
  status: "completed" | "failed" | "stopped";
  finalResponse: string;
  errorMessage: string;
  usage: SessionSnapshot["turns"][number]["usage"];
} {
  if (result.terminal.kind !== "turn_terminal") {
    throw new Error("Child runner returned a non-terminal Runtime event.");
  }
  let status: "completed" | "failed" | "stopped" =
    result.terminal.payload.status === "completed"
      ? "completed"
      : result.terminal.payload.status === "stopped"
        ? "stopped"
        : "failed";
  const committed = result.session?.turns.find((turn) => turn.turnId === childTurnId);
  const usage = committed?.usage ?? {};
  const finalMessageId = result.terminal.payload.finalMessageId;
  const finalMessage = committed?.messages.find(
    (message) => message.messageId === finalMessageId,
  )?.message;
  const finalResponse = finalMessage?.role === "assistant" ? finalMessage.content : "";
  let errorMessage = status === "completed"
    ? ""
    : String(result.terminal.payload.reason || "child_turn_failed");
  if (status === "completed" && !finalResponse.trim()) {
    status = "failed";
    errorMessage = "child_turn_produced_no_terminal_response";
  }
  return { status, finalResponse, errorMessage, usage };
}

function childPrefixMessages(metadata: Record<string, unknown>): ModelMessage[] {
  const candidate = metadata.subagentChildPrefixMessages;
  if (!Array.isArray(candidate)) return [];
  return modelMessageSchema
    .array()
    .parse(candidate)
    .filter((message) => message.role === "system" || message.role === "developer");
}
