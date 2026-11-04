import { z } from 'zod';

const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const bridgePluginToolSchema = z.object({
  name: identifier, description: z.string().min(1).max(8000),
  inputSchema: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()).default({}),
    required: z.array(z.string()).optional(), additionalProperties: z.boolean().optional() }).passthrough(),
  fileArguments: z.array(identifier).max(8).default([]),
  readOnly: z.boolean().default(false),
}).strict().superRefine((tool, ctx) => {
  if (['source_ref', 'request_id'].some(key => key in tool.inputSchema.properties)) ctx.addIssue({ code: 'custom', message: 'Reserved host routing fields.' });
  if (new Set(tool.fileArguments).size !== tool.fileArguments.length || tool.fileArguments.some(key => !(key in tool.inputSchema.properties)))
    ctx.addIssue({ code: 'custom', message: 'File arguments must name distinct top-level schema properties.' });
});
export const bridgePluginSchema = z.object({ id: identifier, name: z.string().min(1).max(100),
  version: z.string().min(1).max(80), description: z.string().max(2000), tools: z.array(bridgePluginToolSchema).min(1).max(64),
}).strict().superRefine((plugin, ctx) => {
  if (new Set(plugin.tools.map(tool => tool.name)).size !== plugin.tools.length) ctx.addIssue({ code: 'custom', message: 'Duplicate tool names.' });
});
export const bridgePluginsSchema = z.array(bridgePluginSchema).max(16).superRefine((plugins, ctx) => {
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) ctx.addIssue({ code: 'custom', message: 'Duplicate plugin ids.' });
});
export type BridgePlugin = z.infer<typeof bridgePluginSchema>;
export type BridgePluginTool = z.infer<typeof bridgePluginToolSchema>;
export const bridgePluginCatalogSchema = z.array(z.object({ connectionId: z.string().uuid(), sessionId: z.string().min(1),
  expiresAt: z.number(), plugin: bridgePluginSchema, revision: z.string().regex(/^[a-f0-9]{64}$/),
}));
export type BridgePluginCatalog = z.infer<typeof bridgePluginCatalogSchema>;
export const bridgeToolCallSchema = z.object({ connectionId: z.string().uuid(), pluginId: identifier,
  revision: z.string().regex(/^[a-f0-9]{64}$/), tool: identifier, sourceRef: z.string().min(1).max(100),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), arguments: z.record(z.string(), z.unknown()),
}).strict();
export type BridgeToolCall = z.infer<typeof bridgeToolCallSchema>;
export function bridgeToolName(connectionId: string, pluginId: string, tool: string) {
  return `mcp__bridge_${connectionId.replaceAll('-', '')}_${pluginId}__${tool}`;
}
/** File declarations are data, never paths chosen or read by an external bridge. */
export function bridgeFilePaths(tool: BridgePluginTool, args: Record<string, unknown>): string[] {
  const paths = tool.fileArguments.flatMap(key => args[key] === undefined ? [] : Array.isArray(args[key]) ? args[key] : [args[key]]);
  if (paths.length > 8 || paths.some(path => typeof path !== 'string' || !path || path.length > 4096)) throw Error('invalid_file_arguments');
  return paths as string[];
}
