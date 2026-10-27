/** Action-specific fields shared by the public contract and execution checks.
 * Keep a portable object schema: providers do not consistently accept root
 * unions/conditionals. Cross-field rules are explicit in the field descriptions
 * and enforced by the decoder, before any child is started or guided. */
export const SUBAGENT_ARGUMENTS = {
  followup: ['action', 'prompt', 'task_id', 'run_in_background'],
  employee: ['action', 'prompt', 'agent_id', 'mode', 'run_in_background'],
  remote: ['action', 'prompt', 'target_agent', 'name'],
  save: ['action', 'agent', 'expected_revision'],
  delete: ['action', 'agent_id', 'expected_revision'],
} as const;
export function onlySubagentArguments(input: Record<string, unknown>, kind: keyof typeof SUBAGENT_ARGUMENTS) {
  return Object.keys(input).every(key => (SUBAGENT_ARGUMENTS[kind] as readonly string[]).includes(key));
}

export function subagentInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, Record<string, unknown>>) };
  for (const key of ['prompt', 'name', 'system_prompt', 'agent_id', 'task_id', 'target_agent', 'agent_type']) {
    if (properties[key]) properties[key] = { ...properties[key], pattern: key === 'name' ? '^[^\\r\\n]*\\S[^\\r\\n]*$' : '\\S' };
  }
  if (properties.task_id) properties.task_id = { ...properties.task_id,
    description: `${properties.task_id.description} Follow-up accepts only: ${SUBAGENT_ARGUMENTS.followup.filter(key => key in properties).join(', ')}. Omit name, mode, agent_type and all configuration; these belong to new children.`,
  };
  return { ...schema, properties };
}
