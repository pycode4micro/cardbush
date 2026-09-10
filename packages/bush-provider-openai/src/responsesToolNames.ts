import { createHash } from 'node:crypto';
import { toolDefinitionSchema, type ModelRequest } from '@cardbush/bush-protocol';
import { mcpDiscoveryResults } from '@cardbush/bush-runtime';

/** Responses function names have a 64-character limit; Runtime identities do not. */
export function responseToolName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith('cb_mcp_')) return name;
  return `cb_mcp_${createHash('sha256').update(name).digest('hex').slice(0, 56)}`;
}

/** Resolve only names present in the actual request, never a second persisted catalog. */
export function responseToolAliases(request: ModelRequest): Map<string, string> {
  const aliases = new Map<string, string>();
  const remember = (name: string) => {
    const alias = responseToolName(name), previous = aliases.get(alias);
    if (previous !== undefined && previous !== name) throw new Error('Conflicting Responses tool aliases.');
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
