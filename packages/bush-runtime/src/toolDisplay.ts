import type { ToolCall, ToolDefinition, ToolDisplay } from '@cardbush/bush-protocol';
import { normalizeToolDisplay } from '@cardbush/bush-protocol';
export { normalizeToolDisplayTitle } from '@cardbush/bush-protocol';

// Host presentation metadata. Never forward this field to a tool or MCP server.
export const TOOL_DISPLAY_TITLE = '_display_title';

function acceptsDisplayTitle(definition: ToolDefinition): boolean {
  // Context maintenance uses its own strict exchange, not the tool coordinator.
  if (definition.name === 'checkpoint_context' || definition.name === 'summary_for_user') return false;
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
    [TOOL_DISPLAY_TITLE]: {
      type: 'object',
      description: 'Specific action purpose for the UI, independent of reply language. Omit status, reasoning, counters, secrets and success claims. Reuse for repeated checks; for batches, supply only on the outer call, never inside third-party arguments.',
      properties: {
        zh: { type: 'string', description: 'Simplified Chinese action description, normally 6–16 characters.' },
        en: { type: 'string', description: 'Equivalent English action description, normally 2–8 words.' },
      },
      required: ['zh', 'en'],
      additionalProperties: false,
    },
  }, required: [...(Array.isArray(definition.inputSchema.required) ? definition.inputSchema.required : []), TOOL_DISPLAY_TITLE] } };
}

export function toolCallDisplay(call: ToolCall, definition?: ToolDefinition): ToolDisplay | undefined {
  if (!definition || !acceptsDisplayTitle(definition)) return undefined;
  try {
    const value = JSON.parse(call.argumentsText);
    return normalizeToolDisplay(value?.[TOOL_DISPLAY_TITLE]);
  } catch { return undefined; }
}

export function stripToolDisplayTitle(input: unknown, definition: ToolDefinition): unknown {
  if (!acceptsDisplayTitle(definition) || !input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.prototype.hasOwnProperty.call(input, TOOL_DISPLAY_TITLE)) return input;
  const { [TOOL_DISPLAY_TITLE]: _title, ...argumentsOnly } = input as Record<string, unknown>;
  return argumentsOnly;
}
