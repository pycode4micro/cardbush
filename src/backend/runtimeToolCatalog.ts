import type { ToolDefinition } from '@cardbush/bush-protocol';

/** Approval policy is intentionally absent: changing it must not reshape tools. */
export function selectRuntimeToolDefinitions(
  catalog: Array<{ definition: ToolDefinition; manifest: { operation: string } }>,
  options: {
    allowedTools?: string[]; disabledTools?: string[];
    interactiveRequests: boolean; vision: boolean; goalAvailable: boolean;
    referencePlanMode?: string; teamModeEnabled?: boolean;
  },
): ToolDefinition[] {
  const disabled = new Set(options.disabledTools ?? []);
  return catalog.filter(entry =>
    (!options.allowedTools || options.allowedTools.includes(entry.definition.name)) &&
    (!disabled.has(entry.definition.name) || entry.definition.name === 'checkpoint_context') &&
    (entry.definition.name !== 'request_permission' || options.interactiveRequests) &&
    (entry.definition.name !== 'solution_selection' || options.interactiveRequests) &&
    (entry.definition.name !== 'inject_image_input' || options.vision) &&
    (entry.definition.name !== 'update_goal' || options.goalAvailable) &&
    (options.referencePlanMode !== 'off' || entry.manifest.operation !== 'plan.update') &&
    (options.teamModeEnabled === true || entry.manifest.operation !== 'agent.team_delegate'),
  ).map(entry => entry.definition);
}
