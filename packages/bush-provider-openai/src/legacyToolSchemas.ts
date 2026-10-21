import { isDeepStrictEqual } from 'node:util';
import type { ToolDefinition } from '@cardbush/bush-protocol';
import { withToolDisplayTitle } from '@cardbush/bush-runtime';

// Exact known historical action clauses. Unfamiliar unions (including MCP tools)
// must not silently lose validation through a generic schema flattening rule.
const legacyPlanChoices = [
  { properties: { action: { enum: ['get'] } }, required: ['action'],
    not: { anyOf: ['expected_revision', 'updates', 'append_nodes', 'remove_ids', 'nodes', 'explanation', 'active', 'scopeChangeReason'].map(field => ({ required: [field] })) } },
  { properties: { action: { enum: ['replace'] } }, required: ['nodes'],
    not: { anyOf: ['updates', 'append_nodes', 'remove_ids'].map(field => ({ required: [field] })) } },
  { properties: { action: { enum: ['patch'] } }, required: ['action', 'expected_revision'], not: { required: ['nodes'] } },
];

/** Wire-only compatibility for already saved contracts; never imports current tool definitions. */
export function legacyBuiltinWireSchema(tool: ToolDefinition): ToolDefinition['inputSchema'] | undefined {
  const schema = withToolDisplayTitle(tool).inputSchema;
  if (tool.name === 'update_task_plan' && schema.type === 'object' && isDeepStrictEqual(schema.anyOf, legacyPlanChoices)) {
    const { anyOf: _actionRules, ...envelope } = schema;
    return envelope;
  }
  return undefined;
}
