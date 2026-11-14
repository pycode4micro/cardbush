import type { ToolCall } from '@cardbush/bush-protocol';
import type { ToolHandlerContext, ToolRegistration, ToolResource } from './toolRegistry.js';
import { resolveToolReferenceName } from './toolReferenceNames.js';

export const TOOL_CONCURRENCY_LIMIT = 8;
export const TOOL_SCRIPT_CALL_LIMIT = 32;

/** Final-display signals run only after the batch's other tools have settled.
 * Keep original ordinals so reordering execution never changes receipt identity. */
export function toolExecutionPhases(calls: ToolCall[], nameFor: (call: ToolCall) => string = call => call.name): number[][] {
  const work: number[] = [], summaries: number[] = [];
  calls.forEach((call, ordinal) => (nameFor(call) === 'summary_for_user' ? summaries : work).push(ordinal));
  return [work, summaries].filter(phase => phase.length);
}

/** A scheduling hint only. Invocation routes, schema authority and permissions
 * are still checked by the coordinator against the actual target. */
export function scheduledToolName(name: string, input: unknown, turn?: ToolHandlerContext['turn']): string {
  name = resolveToolReferenceName(name, turn);
  if (name === 'call_tool') {
    const target = input && typeof input === 'object' && !Array.isArray(input) ? (input as { name?: unknown }).name : undefined;
    if (typeof target === 'string') return resolveToolReferenceName(target, turn);
  }
  return name;
}

/** MCP calls share one server lease across direct, nested and background calls.
 * Transparent dispatchers take no server lease of their own. */
export function mcpSchedulingResources(registration: ToolRegistration): ToolResource[] {
  if (!registration.mcpHook) return [];
  return [{ key: `mcp-server:${registration.mcpHook.server}`, mode: registration.parallelSafe ? 'read' : 'write',
    capacity: TOOL_CONCURRENCY_LIMIT }];
}
