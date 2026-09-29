import { createHash } from 'node:crypto';
import { toolDefinitionSchema, type ModelRequest } from '@cardbush/bush-protocol';
import { mcpDiscoveryResults } from '@cardbush/bush-runtime';

/** Use a portable wire name; canonical Runtime/MCP identities remain unchanged. */
export function providerToolName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith('cb_mcp_')) return name;
  return `cb_mcp_${createHash('sha256').update(name).digest('hex').slice(0, 56)}`;
}

/** Resolve only names present in the actual request, never a second persisted catalog. */
export function providerToolAliases(request: ModelRequest): Map<string, string> {
  const aliases = new Map<string, string>();
  const remember = (name: string) => {
    const alias = providerToolName(name), previous = aliases.get(alias);
    if (previous !== undefined && previous !== name) throw new Error('Conflicting provider tool aliases.');
    aliases.set(alias, name);
  };
  for (const tool of request.tools) remember(tool.name);
  for (const { output } of mcpDiscoveryResults(request.messages, request.sessionId)) {
    for (const match of output.matches) {
      const tool = toolDefinitionSchema.safeParse(match);
      if (tool.success) remember(tool.data.name);
    }
  }
  return aliases;
}
