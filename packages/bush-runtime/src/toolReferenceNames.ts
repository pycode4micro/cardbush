import { createHash } from 'node:crypto';
import { toolDefinitionSchema, type ModelRequest } from '@cardbush/bush-protocol';
import { toolSchemaReceipts, TOOL_SCHEMA_PROTOCOL } from './toolSchemaReceipts.js';
import { withToolFailureFacts } from './toolFailureFacts.js';

/** Wire encoding only. Registry identities and recorded arguments stay unchanged. */
export function portableToolName(name: string): string {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith('cb_mcp_')) return name;
  return `cb_mcp_${createHash('sha256').update(name).digest('hex').slice(0, 56)}`;
}

/** Derived from the exact model request, never from a second live or persisted catalog. */
export function visibleToolAliases(request: ModelRequest): Map<string, string> {
  const aliases = new Map<string, string>();
  const remember = (name: string) => {
    const alias = portableToolName(name), previous = aliases.get(alias);
    if (previous !== undefined && previous !== name) throw new Error('Conflicting provider tool aliases.');
    aliases.set(alias, name);
  };
  for (const tool of request.tools) remember(tool.name);
  for (const [tool, protocol] of [['get_tool_schema', TOOL_SCHEMA_PROTOCOL]] as const) {
    for (const { output } of toolSchemaReceipts(request.messages, request.sessionId, tool, protocol)) {
      for (const match of output.matches) {
        const definition = toolDefinitionSchema.safeParse(match);
        if (definition.success) remember(definition.data.name);
      }
    }
  }
  return aliases;
}

export interface ToolNameScope {
  sessionId: string;
  turnId: string;
  aliases: ReadonlyMap<string, string>;
}

export function createToolNameScope(request: ModelRequest): ToolNameScope {
  return { sessionId: request.sessionId, turnId: request.turnId, aliases: visibleToolAliases(request) };
}

/** Resolve an explicit tool reference at dispatch, never strings inside user data or code. */
export function resolveToolReferenceName(name: string, turn?: { request: ModelRequest; toolNameScope?: ToolNameScope }): string {
  const scope = turn?.toolNameScope;
  return turn && scope && scope.sessionId === turn.request.sessionId && scope.turnId === turn.request.turnId
    ? scope.aliases.get(name) ?? name : name;
}

export function unknownToolReferenceError(name: string, domain: 'native' | 'mcp') {
  return withToolFailureFacts(Object.assign(new Error(`Unknown or no-longer-loaded tool name/alias: ${name}. ${domain === 'mcp'
    ? 'Use mcp_search to find the exact name, then load the schema with get_tool_schema and invoke through call_tool.'
    : 'Use get_tool_schema with an exact tool name from the current catalog. Use mcp_search to find MCP tools, then invoke the loaded target with call_tool.'} No tool was executed.`), {
    code: 'tool_not_found', details: { toolName: name },
  }), { effects: 'none', result: 'known' });
}

export function wrongToolRouteError(name: string, domain: 'native' | 'mcp') {
  const load = { name: 'get_tool_schema', arguments: { name } };
  const invoke = 'call_tool';
  return withToolFailureFacts(Object.assign(new Error(`This is ${domain === 'mcp' ? 'an MCP' : 'a native'} tool. Use ${load.name} to load its schema, wait for the result, then use ${invoke} with the exact name and arguments. No tool was executed.`), {
    code: 'tool_route_mismatch', details: { toolName: name, load, invoke },
  }), { dispatch: 'not_started', effects: 'none', result: 'known' });
}
