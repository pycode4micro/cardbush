import type { ToolCall, ToolDefinition } from '@cardbush/bush-protocol';

// Host presentation metadata. Never forward this field to a tool or MCP server.
export const TOOL_DISPLAY_TITLE = '_display_title';

function acceptsDisplayTitle(definition: ToolDefinition): boolean {
  // Context maintenance uses its own strict exchange, not the tool coordinator.
  if (definition.name === 'checkpoint_context') return false;
  const schema = definition.inputSchema;
  if (schema.type !== 'object' || ['$ref', 'allOf', 'anyOf', 'oneOf', 'if', 'patternProperties'].some(key => key in schema)) return false;
  const properties = schema.properties;
  return !properties || (typeof properties === 'object' && !Array.isArray(properties) &&
    !Object.prototype.hasOwnProperty.call(properties, TOOL_DISPLAY_TITLE));
}

export function withToolDisplayTitle(definition: ToolDefinition): ToolDefinition {
  if (!acceptsDisplayTitle(definition)) return definition;
  return { ...definition, inputSchema: { ...definition.inputSchema, properties: {
    ...(definition.inputSchema.properties as Record<string, unknown> | undefined),
    [TOOL_DISPLAY_TITLE]: { type: 'string', description: 'Short action title for the user. Host display only.' },
  } } };
}

export function normalizeToolDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? Array.from(title).slice(0, 80).join('') : undefined;
}

export function toolCallDisplay(call: ToolCall, definition?: ToolDefinition): { title: string } | undefined {
  if (!definition || !acceptsDisplayTitle(definition)) return undefined;
  try {
    const value = JSON.parse(call.argumentsText);
    const title = normalizeToolDisplayTitle(value?.[TOOL_DISPLAY_TITLE]);
    return title ? { title } : undefined;
  } catch { return undefined; }
}

export function stripToolDisplayTitle(input: unknown, definition: ToolDefinition): unknown {
  if (!acceptsDisplayTitle(definition) || !input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.prototype.hasOwnProperty.call(input, TOOL_DISPLAY_TITLE)) return input;
  const { [TOOL_DISPLAY_TITLE]: _title, ...argumentsOnly } = input as Record<string, unknown>;
  return argumentsOnly;
}
