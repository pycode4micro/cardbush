import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DefinitionReceipt, UsageRecipe, UsageRecipeIdentity, UsageRecipeInvocation, UsageSession } from '@cardbush/bush-protocol';
import type { ToolHandlerContext, ToolRegistry } from './toolRegistry.js';
import { usageAvailableTools } from './usageCapabilities.js';
import { mcpToolWasDiscovered } from './mcpToolDiscovery.js';

export const usageDefinitionHash = (definition: UsageSession['usage']) => {
  // Empty plan is a new default, not a change to legacy method semantics.
  // Preserve the identity of completions already journaled before this field existed.
  const { plan, ...legacy } = definition;
  return createHash('sha256').update(JSON.stringify(plan?.length ? definition : legacy)).digest('hex');
};
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

export function usageRecipeInfo(recipe: UsageRecipe, revision: number) {
  return { id: recipe.id, name: recipe.name, description: recipe.description, parameters: recipe.parameters, requires: recipe.requires,
    parameters_schema: { type: 'object', additionalProperties: false, required: recipe.parameters.filter(item => item.required).map(item => item.name),
      properties: Object.fromEntries(recipe.parameters.map(item => [item.name, { type: item.type, description: item.description }])) },
    invocation: { tool: 'run_tools', arguments: { usage: { recipe_id: recipe.id, expected_revision: revision } },
      supply: 'Add parameters matching parameters_schema, and bindings mapping each required capability ID to the selected local tool name.' },
    note: 'The saved implementation runs in the existing tool-script sandbox. Inspect recommendations/current schemas; import or review never runs this method. Business parameters and local bindings are not exported into teaching requirements.' };
}

/** Prepare only. The existing run_tools job owns execution, journal and lifecycle. */
export function prepareUsageRecipe(receipt: DefinitionReceipt<UsageSession>, input: UsageRecipeInvocation,
  context: ToolHandlerContext<unknown>, registry: ToolRegistry) {
  if (receipt.revision !== input.expected_revision) throw failure('usage_revision_conflict', 'The usage definition changed. Read the method again before running it.');
  const recipe = receipt.definition.usage.recipes.find(item => item.id === input.recipe_id);
  if (!recipe) throw failure('usage_recipe_not_found', 'This method does not belong to the current usage pack.');
  const types = { string: z.string(), number: z.number(), integer: z.number().int(), boolean: z.boolean(), object: z.record(z.string(), z.json()), array: z.array(z.json()) };
  const shape = Object.fromEntries(recipe.parameters.map(item => [item.name, item.required ? types[item.type] : types[item.type].optional()]));
  const parameters = z.object(shape).strict().parse(input.parameters);
  if (Object.keys(input.bindings).some(id => !recipe.requires.includes(id)) || recipe.requires.some(id => !input.bindings[id])) {
    throw failure('usage_recipe_bindings_required', 'Provide one local tool binding for each required capability, and no others. Use usage recommend to find candidates; nothing was executed.');
  }
  const available = new Set(usageAvailableTools(registry, context.turn?.request).map(item => item.name));
  for (const id of recipe.requires) {
    const name = input.bindings[id]!;
    if (!available.has(name) || registry.resolve(name)?.nestedCallable === false) {
      throw failure('usage_recipe_binding_unavailable', `The implementation selected for ${id} is unavailable for composition. Discover a compatible tool in the current environment.`);
    }
    if (registry.resolve(name)?.mcpHook && context.turn && !mcpToolWasDiscovered(registry, context.turn.request, name)) {
      throw failure('mcp_discovery_required', `Load the current schema for the implementation of ${id} before running the method. No tool was executed.`);
    }
  }
  const identity: UsageRecipeIdentity = { usage_id: receipt.definition.usage.id, recipe_id: recipe.id, definition_sha256: usageDefinitionHash(receipt.definition.usage) };
  const code = `const bindings = JSON.parse(${JSON.stringify(JSON.stringify(input.bindings))});
const input = JSON.parse(${JSON.stringify(JSON.stringify(parameters))});
const caps = Object.freeze(Object.fromEntries(Object.entries(bindings).map(([id, name]) => [id, args => tools.call(name, args)])));
return await (async (caps, input) => { ${recipe.code}\n})(caps, input);`;
  return { code, allowedTools: Object.values(input.bindings), identity };
}
