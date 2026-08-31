import {
  BUSH_SESSION_TURN_REQUEST_PROTOCOL,
  DEFAULT_CHILD_AGENT_DISABLED_TOOLS,
  modelMessageSchema,
  runtimeProviderBindingRefSchema,
  type ModelMessage,
  type RuntimeEvent,
  type RuntimePermissionMode,
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

export interface SubagentPermissionPolicy {
  permissionRouting: "user" | "parent";
  childPermissionMode: RuntimePermissionMode;
  model?: { mode: "inherit" };
  disabledTools?: string[];
}

export const DEFAULT_SUBAGENT_DISABLED_TOOLS = DEFAULT_CHILD_AGENT_DISABLED_TOOLS;

export const DEFAULT_SUBAGENT_PERMISSION_POLICY: SubagentPermissionPolicy = {
  permissionRouting: "user",
  childPermissionMode: "task_free",
  model: { mode: "inherit" },
  disabledTools: [...DEFAULT_SUBAGENT_DISABLED_TOOLS],
};

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
  permissionPolicy?: SubagentPermissionPolicy;
}): RuntimeSessionTurnRequest {
  if (!input.context.turn) throw new Error("Child dispatch requires the parent Turn context.");
  const parentRequest = input.context.turn.request;
  const parentVisibleNames = new Set(parentRequest.tools.map((tool) => tool.name));
  const childVisible = new Map(
    input.registry.childDefinitions().map((definition) => [definition.name, definition]),
  );
  const configuredPolicy = input.permissionPolicy ?? DEFAULT_SUBAGENT_PERMISSION_POLICY;
  const turnPolicy = childAgentPolicy(parentRequest.metadata.childAgentPolicy);
  const disabledTools = new Set(
    turnPolicy.disabledTools ??
      configuredPolicy.disabledTools ??
      DEFAULT_SUBAGENT_DISABLED_TOOLS,
  );
  const unfilteredRequestedNames = input.allowedToolNames
    ? [...new Set(input.allowedToolNames)]
    : [...childVisible.keys()].filter((name) => parentVisibleNames.has(name));
  const unavailable = input.allowedToolNames
    ? unfilteredRequestedNames.filter(
        (name) => !disabledTools.has(name) &&
          (!parentVisibleNames.has(name) || !childVisible.has(name)),
      )
    : [];
  if (unavailable.length > 0) {
    throw new Error(`Child Tools are not exposed by the parent Turn: ${unavailable.join(", ")}.`);
  }
  const requestedNames = unfilteredRequestedNames.filter((name) => !disabledTools.has(name));
  const childTools = requestedNames.map((name) => childVisible.get(name)!);
  const requestedPermissionRouting = parentRequest.metadata.subagentPermissionRouting;
  const permissionRouting = requestedPermissionRouting === "user" || requestedPermissionRouting === "parent"
    ? requestedPermissionRouting
    : turnPolicy.permissionRouting ?? configuredPolicy.permissionRouting;
  const permissionMode = permissionRouting === "user"
    ? parentRequest.permissionMode
    : turnPolicy.childPermissionMode ?? configuredPolicy.childPermissionMode;
  const permissionScopeSessionId = permissionRouting === "user"
    ? input.context.sessionId
    : input.ids.sessionId;
  const subagentTaskId = String(
    input.metadata.subagentTaskId ?? input.metadata.teamTaskId ?? "",
  ).trim();
  const modelPolicy = resolvedChildModel(turnPolicy.model);
  return {
    protocol: BUSH_SESSION_TURN_REQUEST_PROTOCOL,
    requestId: input.ids.requestId,
    sessionId: input.ids.sessionId,
    turnId: input.ids.turnId,
    model: modelPolicy?.model ?? parentRequest.model,
    providerBinding: modelPolicy?.providerBinding ?? parentRequest.providerBinding,
    prefixMessages: [
      ...childPrefixMessages(parentRequest.metadata),
      ...(input.additionalPrefixMessages ?? []),
      ...input.inherited,
    ],
    inputMessages: [{
      messageId: input.ids.messageId,
      message: { role: "user", content: input.prompt },
    }],
    sessionMetadata: {
      parentSessionId: input.context.sessionId,
      parentTurnId: input.context.turnId,
      agentRole: "child",
    },
    tools: childTools,
    maxOutputTokens: modelPolicy?.maxOutputTokens ?? parentRequest.maxOutputTokens,
    temperature: parentRequest.temperature,
    topP: parentRequest.topP,
    reasoningEffort: parentRequest.reasoningEffort,
    requestCapabilities: {
      vision: parentRequest.requestCapabilities?.vision ?? false,
      interactiveRequests: false,
      userChoice: false,
    },
    permissionMode,
    metadata: {
      ...parentRequest.metadata,
      ...input.metadata,
      agentRole: "child",
      parentSessionId: input.context.sessionId,
      parentTurnId: input.context.turnId,
      inheritedObservationSessionId: input.context.sessionId,
      permissionRouting,
      childAgentModelMode: modelPolicy ? "fixed" : "inherit",
      childAgentModelId: modelPolicy?.modelId ?? "",
      contextWindowTokens:
        modelPolicy?.maxContextTokens ?? parentRequest.metadata.contextWindowTokens,
      disabledTools: [...disabledTools],
      permissionScopeSessionId,
      permissionEventRequestId: parentRequest.requestId,
      permissionEventSessionId: input.context.sessionId,
      permissionEventTurnId: input.context.turnId,
      ...(subagentTaskId ? { subagentTaskId } : {}),
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

interface MetadataChildAgentPolicy {
  permissionRouting?: "user" | "parent";
  childPermissionMode?: RuntimePermissionMode;
  model?: unknown;
  disabledTools?: string[];
}

function childAgentPolicy(input: unknown): MetadataChildAgentPolicy {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Child Agent policy must be an object.");
  }
  const value = input as Record<string, unknown>;
  const unexpected = Object.keys(value).filter((key) =>
    !["permissionRouting", "childPermissionMode", "model", "disabledTools"].includes(key)
  );
  if (unexpected.length > 0) {
    throw new Error(`Unsupported Child Agent policy fields: ${unexpected.join(", ")}.`);
  }
  if (
    value.permissionRouting !== undefined &&
    value.permissionRouting !== "user" &&
    value.permissionRouting !== "parent"
  ) {
    throw new Error("Child Agent permissionRouting must be user or parent.");
  }
  if (
    value.childPermissionMode !== undefined &&
    !["task_free", "user_free", "all_free"].includes(String(value.childPermissionMode))
  ) {
    throw new Error("Child Agent childPermissionMode is invalid.");
  }
  const permissionRouting = value.permissionRouting as "user" | "parent" | undefined;
  const childPermissionMode = value.childPermissionMode as RuntimePermissionMode | undefined;
  const disabledTools = value.disabledTools === undefined
    ? undefined
    : parseDisabledTools(value.disabledTools);
  return { permissionRouting, childPermissionMode, model: value.model, disabledTools };
}

function parseDisabledTools(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error("Child Agent disabledTools must be an array.");
  const tools = input.map((item) => typeof item === "string" ? item.trim() : "");
  if (tools.some((item) => !item)) {
    throw new Error("Child Agent disabledTools must contain non-empty tool names.");
  }
  return [...new Set(tools)];
}

function resolvedChildModel(input: unknown): {
  modelId: string;
  model: string;
  providerBinding: NonNullable<RuntimeSessionTurnRequest["providerBinding"]>;
  maxContextTokens?: number;
  maxOutputTokens?: number;
} | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Child Agent model policy must be an object.");
  }
  const value = input as Record<string, unknown>;
  if (value.mode === "inherit") return undefined;
  if (value.mode !== "fixed") {
    throw new Error("Child Agent model mode must be inherit or fixed.");
  }
  const modelId = String(value.modelId ?? "").trim();
  const model = String(value.model ?? "").trim();
  const binding = runtimeProviderBindingRefSchema.safeParse(value.providerBinding);
  if (!modelId || !model || !binding.success) {
    throw new Error("Fixed Subagent model policy is missing modelId, model, or providerBinding.");
  }
  const maxOutputTokens = Number(value.maxOutputTokens);
  const maxContextTokens = Number(value.maxContextTokens);
  return {
    modelId,
    model,
    providerBinding: binding.data,
    ...(Number.isInteger(maxContextTokens) && maxContextTokens > 0 ? { maxContextTokens } : {}),
    ...(Number.isInteger(maxOutputTokens) && maxOutputTokens > 0 ? { maxOutputTokens } : {}),
  };
}
