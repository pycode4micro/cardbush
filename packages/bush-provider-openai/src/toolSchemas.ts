import type { ToolDefinition } from '@cardbush/bush-protocol';
import { withToolDisplayTitle } from '@cardbush/bush-runtime';
import { legacyBuiltinWireSchema } from './legacyToolSchemas.js';

/** Final wire projection only; never replace the registry or frozen catalog. */
export function providerToolInputSchema(tool: ToolDefinition): ToolDefinition['inputSchema'] {
  return legacyBuiltinWireSchema(tool) ?? withToolDisplayTitle(tool).inputSchema;
}

export function responsesToolInputSchema(tool: ToolDefinition): ToolDefinition['inputSchema'] {
  const schema = providerToolInputSchema(tool);
  if (tool.name !== 'inject_image_input' && tool.name !== 'update_task_plan') return schema;

  // Saved versions of these built-ins omitted type on some string enums.
  // Adding the same type on the wire keeps their accepted values and stored contract intact.
  const typed = structuredClone(schema);
  declareStringEnumTypes(typed);
  return typed;
}

function declareStringEnumTypes(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) {
    const schema = value as Record<string, unknown>;
    const values = schema.enum;
    if (schema.type === undefined && Array.isArray(values) && values.some(item => typeof item === 'string') &&
      values.every(item => typeof item === 'string' || item === null)) {
      schema.type = values.includes(null) ? ['string', 'null'] : 'string';
    }
  }
  for (const child of Object.values(value)) declareStringEnumTypes(child);
}
