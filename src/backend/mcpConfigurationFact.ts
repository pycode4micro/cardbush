/** Keep only the configuration identity; never project command args or credentials. */
export function configuredMcpServerId(toolCall: { name: string; argumentsText?: string }): string | undefined {
  if (toolCall.name !== 'mcp__cardbush_management__configure_mcp_server' || !toolCall.argumentsText) return undefined;
  try {
    const input = JSON.parse(toolCall.argumentsText);
    return input.enabled !== false && typeof input.id === 'string' && input.id.trim() ? input.id : undefined;
  } catch { return undefined; }
}
