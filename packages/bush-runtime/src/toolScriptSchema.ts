import { z } from 'zod';
import { usageRecipeInvocationSchema, type ToolDefinition } from '@cardbush/bush-protocol';

const selection = 'Provide exactly one of code or usage.';
// Function parameters must have an object root. Keep the exclusive choice in
// the decoder: a root Zod union emits anyOf without type and is rejected by APIs.
export const toolScriptInputSchema = z.object({
  code: z.string().min(1).max(64000).optional().describe('JavaScript async function body. Omit when using a packaged method.'),
  usage: usageRecipeInvocationSchema.optional().describe('Teacher-packaged method and current inputs. Omit code when using this field.'),
}).strict().refine(input => (input.code !== undefined) !== (input.usage !== undefined), selection).describe(selection);

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Repair only the known pre-fix run_tools declaration in frozen/recovered
 * catalogs. Preserve its fields/$defs, not a newer catalog or extra capability. */
export function repairLegacyToolScriptSchema(definition: ToolDefinition): ToolDefinition {
  const schema = definition.inputSchema;
  if (definition.name !== 'run_tools' || schema.type !== undefined || !Array.isArray(schema.anyOf) || schema.anyOf.length !== 2 ||
    Object.keys(schema).some(key => !['$schema', '$defs', 'anyOf'].includes(key))) return definition;
  const properties: Record<string, unknown> = {};
  for (const branch of schema.anyOf) {
    if (!record(branch) || branch.type !== 'object' || branch.additionalProperties !== false || !record(branch.properties) ||
      !Array.isArray(branch.required) || branch.required.length !== 1 || Object.keys(branch.properties).length !== 1 ||
      Object.keys(branch).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))) return definition;
    const field = branch.required[0];
    if (typeof field !== 'string' || !['code', 'usage'].includes(field) || Object.hasOwn(properties, field)) return definition;
    const property = branch.properties[field];
    if (!record(property) || property.type !== (field === 'code' ? 'string' : 'object')) return definition;
    properties[field] = property;
  }
  const { anyOf: _legacyChoice, ...retained } = schema;
  return { ...definition, inputSchema: { ...retained, type: 'object', description: selection, properties, additionalProperties: false } };
}
