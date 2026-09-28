import type { ToolCall, ToolDefinition, ToolDisplay } from '@cardbush/bush-protocol';

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

export function normalizeToolDisplayTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return title ? Array.from(title).slice(0, 80).join('') : undefined;
}

export function toolCallDisplay(call: ToolCall, definition?: ToolDefinition): ToolDisplay | undefined {
  if (!definition || !acceptsDisplayTitle(definition)) return undefined;
  try {
    const value = JSON.parse(call.argumentsText);
    const supplied = value?.[TOOL_DISPLAY_TITLE];
    if (supplied && typeof supplied === 'object' && !Array.isArray(supplied)) {
      const zh = normalizeToolDisplayTitle(supplied.zh);
      const en = normalizeToolDisplayTitle(supplied.en);
      if (zh || en) return { title: en || zh!, titles: { ...(zh ? { zh } : {}), ...(en ? { en } : {}) } };
    }
    // Old models and persisted calls may still supply a single-language string.
    const title = normalizeToolDisplayTitle(supplied);
    return title ? { title } : undefined;
  } catch { return undefined; }
}

export function stripToolDisplayTitle(input: unknown, definition: ToolDefinition): unknown {
  if (!acceptsDisplayTitle(definition) || !input || typeof input !== 'object' || Array.isArray(input) ||
      !Object.prototype.hasOwnProperty.call(input, TOOL_DISPLAY_TITLE)) return input;
  const { [TOOL_DISPLAY_TITLE]: _title, ...argumentsOnly } = input as Record<string, unknown>;
  return argumentsOnly;
}
