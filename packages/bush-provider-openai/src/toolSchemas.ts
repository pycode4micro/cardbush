import type { ToolDefinition } from '@cardbush/bush-protocol';
import { withToolDisplayTitle } from '@cardbush/bush-runtime';
import { legacyBuiltinWireSchema } from './legacyToolSchemas.js';

/** Final wire projection only; never replace the registry or frozen catalog. */
export function providerToolInputSchema(tool: ToolDefinition): ToolDefinition['inputSchema'] {
  return legacyBuiltinWireSchema(tool) ?? withToolDisplayTitle(tool).inputSchema;
}
