import type { FunctionTool, ResponseInputItem, Tool } from "openai/resources/responses/responses";
import { toolDefinitionSchema, type ModelRequest, type ToolDefinition } from "@cardbush/bush-protocol";
import { mcpDiscoveryResults } from "@cardbush/bush-runtime";
import { replayToolSearchMode, type ResponsesToolSearchMode } from "./responsesReplay.js";
import { responseToolName } from "./responsesToolNames.js";

export const TOOL_SEARCH_CAPABILITY = "client_tool_search";

export function hasMcpDiscovery(request: ModelRequest): boolean {
  return request.metadata.mcpToolDiscovery === true &&
    request.tools.some(tool => tool.name === "mcp_search") &&
    request.tools.some(tool => tool.name === "mcp_call");
}

/** A capability observation may expire; the protocol of visible history must not. */
export function historicalToolSearchMode(request: ModelRequest): ResponsesToolSearchMode | undefined {
  for (const message of request.messages) {
    if (message.role !== "assistant") continue;
    // Older conversations and another provider's output keep the portable projection.
    return replayToolSearchMode(message, request) ?? "function";
  }
  return undefined;
}

export function responseFunctionTool(tool: ToolDefinition): FunctionTool {
  return { type: "function", name: responseToolName(tool.name), description: tool.description,
    parameters: tool.inputSchema, strict: false };
}

export function responseTools(request: ModelRequest, mode: ResponsesToolSearchMode): Tool[] | undefined {
  if (!request.tools.length) return undefined;
  return request.tools.flatMap((tool): Tool[] => {
    if (mode === "native" && tool.name === "mcp_search") return [{
      type: "tool_search", execution: "client", parameters: tool.inputSchema,
      description: "Discover MCP tools progressively. action=search (default) returns names and short descriptions without loading schemas. action=load with query set to an exact name reads one full schema. Only then can the tool be called directly and reused across turns. Load again if its definition changes or leaves context. Use server to narrow searches and next_offset to page. Neither action executes the discovered tool or grants permission.",
    }];
    if (mode === "native" && tool.name === "mcp_call") return [];
    return [responseFunctionTool(tool)];
  });
}

/** A derived view of the very same discovery results used by the Runtime. */
export function discoveryInputProjection(request: ModelRequest) {
  const results = new Map([...mcpDiscoveryResults(request.messages, request.sessionId)]
    .map(result => [result.messageIndex, result]));
  const nativeCalls = new Set<string>();
  const pendingCalls = new Set<string>();
  const supplementalItems: ResponseInputItem[] = [];
  return (messageIndex: number, items: ResponseInputItem[]): ResponseInputItem[] => {
    for (const item of items) {
      if ((item.type === "function_call" || item.type === "tool_search_call") && item.call_id) {
        pendingCalls.add(item.call_id);
      }
      if (item.type === "tool_search_call" && item.call_id) nativeCalls.add(item.call_id);
    }
    const message = request.messages[messageIndex];
    if (message.role !== "tool") return items;
    pendingCalls.delete(message.toolCallId);
    const result = results.get(messageIndex);
    const tools = result?.output.matches.flatMap(match => {
      const definition = toolDefinitionSchema.safeParse(match);
      return definition.success ? [{ ...responseFunctionTool(definition.data), defer_loading: true }] : [];
    }) ?? [];
    if (nativeCalls.has(message.toolCallId)) {
      // Keep compact references, paging and errors visible without duplicating schemas.
      const receipt = result ? JSON.stringify({ ...result.output, matches: result.output.matches.map(match => {
        if (!match || typeof match !== "object") return match;
        // Summary names must remain the Runtime's exact lookup identities,
        // including names too long for native function declarations.
        if ((result.output as { action?: string }).action === 'search') return match;
        const { description: _description, inputSchema: _schema, ...reference } = match as Record<string, unknown>;
        return { ...reference, ...(typeof reference.name === "string" ? { name: responseToolName(reference.name) } : {}) };
      }) }) : message.content;
      items = [{ type: "tool_search_output", call_id: message.toolCallId,
        execution: "client", status: "completed", tools }];
      supplementalItems.push({ type: "message", role: "user",
        content: `[tool_search_result data]\ncall_id: ${JSON.stringify(message.toolCallId)}\n${receipt}` });
    } else if (result && nativeCalls.has(result.searchCallId) && tools.length) {
      // An archived search is loaded only after the exact complete result is read.
      supplementalItems.push({ type: "additional_tools", role: "developer", tools });
    }
    // A user message or additional_tools item can close the provider's result
    // batch. Emit every pending call's output first, including parallel local
    // calls. Keep this state while walking skipped history for response chaining.
    return pendingCalls.size ? items : [...items, ...supplementalItems.splice(0)];
  };
}

/** Recognize a protocol rejection, never infer capability from authentication or outages. */
export function isToolSearchUnsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; error?: unknown; code?: unknown; param?: unknown; message?: unknown };
  if (value.status !== 400 && value.status !== 422) return false;
  const body = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : value;
  const code = String(body.code ?? value.code ?? "");
  const param = String(body.param ?? value.param ?? "");
  const message = String(body.message ?? value.message ?? "").toLowerCase();
  if (!message.includes("tool_search")) return false;
  if (param && !/^(?:tools(?:\[\d+\]|\.\d+)?(?:\.(?:type|execution))?|tool_search)$/.test(param)) return false;
  if (code && !["unsupported_value", "unsupported_parameter", "unsupported_tool", "unsupported_tool_type", "invalid_value", "invalid_request_error", "not_supported"].includes(code)) return false;
  return /not supported|does not support|unsupported|unknown tool (?:type|kind)|invalid tool (?:type|kind)|supported (?:values|types|tools) (?:are|include)/.test(message);
}
