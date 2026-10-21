import { z } from 'zod';

export function legacyPlanDefinition(definition) {
  const tool = structuredClone(definition);
  delete tool.inputSchema.properties._display_title;
  tool.inputSchema.properties.action = { enum: ['get', 'replace', 'patch'], default: 'replace' };
  tool.inputSchema.anyOf = [
    { properties: { action: { enum: ['get'] } }, required: ['action'],
      not: { anyOf: ['expected_revision', 'updates', 'append_nodes', 'remove_ids', 'nodes', 'explanation', 'active', 'scopeChangeReason'].map(field => ({ required: [field] })) } },
    { properties: { action: { enum: ['replace'] } }, required: ['nodes'],
      not: { anyOf: ['updates', 'append_nodes', 'remove_ids'].map(field => ({ required: [field] })) } },
    { properties: { action: { enum: ['patch'] } }, required: ['action', 'expected_revision'], not: { required: ['nodes'] } },
  ];
  return tool;
}

export const legacyRunToolsDefinition = () => ({ name: 'run_tools', description: 'Saved method declaration', inputSchema: z.toJSONSchema(z.union([
  z.object({ code: z.string().min(1).max(64000) }).strict(), z.object({ script_id: z.string() }).strict(),
])) });
