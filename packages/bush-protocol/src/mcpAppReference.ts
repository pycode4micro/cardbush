export const MCP_APP_REFERENCE_SCHEME = 'cardbush-app:';
export type McpAppReferenceIdentity = { sessionId: string; turnId: string; toolCallId: string };

const encodePart = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g,
  character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

/** A reference identifies a recorded result, never an arbitrary URL or resource. */
export function mcpAppReference(identity: McpAppReferenceIdentity): string {
  return MCP_APP_REFERENCE_SCHEME + [identity.sessionId, identity.turnId, identity.toolCallId].map(encodePart).join('/');
}

export function parseMcpAppReference(value: string): McpAppReferenceIdentity | undefined {
  if (!value.startsWith(MCP_APP_REFERENCE_SCHEME) || value.length > 4096) return undefined;
  try {
    const parts = value.slice(MCP_APP_REFERENCE_SCHEME.length).split('/').map(decodeURIComponent);
    if (parts.length !== 3 || parts.some(part => !part.trim() || /[\x00-\x1f\x7f]/.test(part))) return undefined;
    const identity = { sessionId: parts[0]!, turnId: parts[1]!, toolCallId: parts[2]! };
    return mcpAppReference(identity) === value ? identity : undefined;
  } catch { return undefined; }
}

export function mcpAppReferenceMarkdown(title: string, reference: string): string {
  return `[${title.replace(/[\r\n]+/g, ' ').replace(/[\\\[\]]/g, '\\$&')}](${reference})`;
}
