import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import type { JsonSchemaType, JsonSchemaValidator, Tool } from '@modelcontextprotocol/client';

/** Validate without coercion, defaults or dropping fields, before admission or dispatch. */
export function mcpInputDecoder(name: string, schema: Tool['inputSchema']) {
  // Keep validators local to a definition: servers may reuse $id across revisions.
  let validate: JsonSchemaValidator<Record<string, unknown>> | undefined;
  return (input: unknown): Record<string, unknown> => {
    const properties = schema.properties ?? {};
    const fields = Object.keys(properties);
    const object = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown> : undefined;
    const wrapped = object && object.name === name && 'arguments' in object &&
      !('name' in properties) && !('arguments' in properties) && fields.length > 0;
    const details = { toolName: name, inputDispatched: false,
      expectedFields: fields.slice(0, 40), requiredFields: schema.required ?? [],
      recovery: { action: 'correct_arguments', load: { name: 'mcp_search', arguments: { action: 'load', query: name } } } };
    const fail = (message: string): never => {
      throw Object.assign(new Error(`${message} No tool was executed. Correct the arguments before retrying.`), {
        code: 'tool_arguments_schema_invalid', details,
      });
    };
    if (!object) return fail(`Arguments for ${name} must be an object.`);
    try { validate ??= new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(schema as JsonSchemaType); }
    catch {
      throw Object.assign(new Error(`The published input schema for ${name} cannot be validated. Refresh the MCP service's tool definition before retrying.`), {
        code: 'mcp_input_schema_invalid', details: { ...details, recovery: { action: 'refresh_tool_definition' } },
      });
    }
    const result = validate(object);
    if (!result.valid) {
      if (wrapped) return fail(`Arguments for ${name} contain an mcp_call envelope. A direct call takes the tool's fields at the top level; only mcp_call takes {name, arguments}.`);
      return fail(`Invalid arguments for ${name}: ${result.errorMessage.slice(0, 1500)}.`);
    }
    return object;
  };
}
