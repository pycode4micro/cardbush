import { mcpAppReference, mcpAppReferenceMarkdown, parseMcpAppReference, type McpAppReferenceIdentity } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Host-issued link metadata is appended to the new result, never to old context. */
export function modelMcpAppReference(registry: ToolRegistry, name: string, result: unknown, identity: McpAppReferenceIdentity): string | undefined {
  const wrapped = name === 'mcp_call';
  const source = wrapped ? object(object(result).mcp).name : name;
  if (typeof source !== 'string') return undefined;
  const registration = registry.resolve(source);
  const native = wrapped ? object(result).result : result;
  if (!registration?.mcpHook || !registration.mcpApp || object(native).isError === true ||
    registration.sessionScope && registration.sessionScope !== identity.sessionId) return undefined;
  const reference = mcpAppReference(identity);
  if (!parseMcpAppReference(reference)) return undefined;
  const title = (registration.mcpApp.title || registration.mcpApp.serverTitle || registration.mcpHook.tool).slice(0, 120);
  return JSON.stringify({ runtime_app_reference: {
    reference, title, markdown: mcpAppReferenceMarkdown(title, reference),
    usage: 'This reference is ready to use: copy markdown exactly into your final reply where it fits the explanation. Do not reconstruct identifiers or call archive readers, App status, or the generating tool merely to obtain or validate this link. The App opens only when the user clicks after the turn ends. Its UI has not been loaded or checked; describe only facts in the tool result.',
  } });
}
