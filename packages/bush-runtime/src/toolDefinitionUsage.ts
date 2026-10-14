import type { ToolDefinition, CacheChainObservationPayload } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

/** Record only sizes/names, never schemas, descriptions or user content. */
export function toolDefinitionUsage(registry: ToolRegistry, definitions: ToolDefinition[]): NonNullable<CacheChainObservationPayload['toolDefinitions']> {
  const sizes = definitions.map(definition => ({ name: definition.name,
    chars: JSON.stringify(definition).length, descriptionChars: definition.description.length,
    schemaChars: JSON.stringify(definition.inputSchema).length }));
  const builtins = sizes.filter(tool => {
    const registration = registry.resolve(tool.name);
    return registration && !registration.mcpHook && !registration.registrationOwner?.startsWith('extension:');
  });
  const chars = JSON.stringify(definitions).length;
  return { count: sizes.length, chars,
    descriptionChars: sizes.reduce((total, tool) => total + tool.descriptionChars, 0),
    schemaChars: sizes.reduce((total, tool) => total + tool.schemaChars, 0),
    estimatedTokens: definitions.length ? Math.ceil(chars / 4) : 0, estimateMethod: 'runtime-tool-json-chars-v1',
    builtinCount: builtins.length,
    builtinChars: builtins.length ? 2 + builtins.reduce((total, tool) => total + tool.chars, 0) + builtins.length - 1 : 2,
    largest: [...sizes].sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name)).slice(0, 5) };
}
