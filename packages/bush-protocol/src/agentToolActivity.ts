import { z } from 'zod';

/** Small presentation facts only. Definitions and prompts stay in the execution record. */
export const agentToolActivitySchema = z.object({
  kind: z.enum(['employee', 'team', 'subagent']),
  action: z.enum(['save', 'delete', 'run']),
  id: z.string().optional(),
  name: z.string().optional(),
  taskIds: z.array(z.string()).optional(),
});
export type AgentToolActivity = z.infer<typeof agentToolActivitySchema>;

export function agentToolActivity(record: {
  toolCall: { name: string; argumentsText?: string }; result?: unknown;
}): AgentToolActivity | undefined {
  const { name } = record.toolCall;
  if (!['subagent', 'team', 'team_delegate'].includes(name)) return;
  let input: Record<string, unknown> = {};
  try { input = object(JSON.parse(record.toolCall.argumentsText || '{}')); } catch { /* Invalid input has no activity. */ }
  const output = object(record.result);
  const kind = name === 'team' ? 'team' : 'employee';
  const idKey = kind === 'team' ? 'team_id' : 'agent_id';
  const definition = object(input[kind === 'team' ? 'definition' : 'agent']);
  const saved = input.action === 'save' || (typeof output.revision === 'number' && typeof output[idKey] === 'string');
  if (name !== 'team_delegate' && (saved || input.action === 'delete')) return {
    kind, action: saved ? 'save' : 'delete',
    id: text(output[idKey]) || text(definition.id) || text(input[idKey]),
    name: text(output.name) || text(definition.name),
  };
  if (name === 'team') return;
  if (input.action && input.action !== 'run') return;
  const members = Array.isArray(output.members) ? output.members.map(object) : [output];
  const taskIds = [...new Set([...members.map(item => text(item.taskId)),
    ...(Array.isArray(output.taskIds) ? output.taskIds.map(text) : [])].filter((id): id is string => !!id))];
  const profileId = text(output.agentProfileId);
  const employeeId = text(input.agent_id) || (profileId?.startsWith('registered:') ? profileId.slice('registered:'.length) : undefined);
  return { kind: employeeId ? 'employee' : 'subagent', action: 'run', id: employeeId,
    name: text(output.agentName), taskIds };
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown) { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
