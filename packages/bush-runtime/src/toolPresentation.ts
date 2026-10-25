import type { ToolDefinition } from '@cardbush/bush-protocol';

/** Read only when binding a new model catalog. Recall never reprojects it. */
export interface ToolPresentationScope {
  hasTool(name: string): boolean;
  canRecall: boolean;
}
export type ToolDefinitionProjector = (definition: ToolDefinition, scope: ToolPresentationScope) => ToolDefinition | null;

/** Select an envelope from the authoritative definition; execution keeps the full decoder. */
export function presentTool(definition: ToolDefinition, options: {
  description?: string;
  fields?: readonly string[];
  actions?: readonly string[];
  properties?: Record<string, unknown>;
}): ToolDefinition {
  const schema = definition.inputSchema;
  const properties = Object.fromEntries(Object.entries(schema.properties as Record<string, unknown> ?? {})
    .filter(([name]) => !options.fields || options.fields.includes(name) || name === '_display_title'));
  Object.assign(properties, options.properties);
  if (options.actions && properties.action) properties.action = { ...(properties.action as object), enum: [...options.actions] };
  return { ...definition, ...(options.description ? { description: options.description } : {}), inputSchema: {
    ...schema, properties,
    ...(Array.isArray(schema.required) ? { required: schema.required.filter(name => Object.hasOwn(properties, String(name))) } : {}),
  } };
}
