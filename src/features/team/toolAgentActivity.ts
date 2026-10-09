import { agentToolActivity, agentToolActivitySchema, type AgentToolActivity } from '@cardbush/bush-protocol';
import type { ChatMessage, ChatToolExecution } from '../../types';
import { parseToolOutputJson } from '../tools/toolPayload';

export function toolAgentActivity(execution: ChatToolExecution): AgentToolActivity | undefined {
  if (!['subagent', 'team', 'team_delegate'].includes(execution.name)) return;
  const fact = agentToolActivitySchema.safeParse(execution.metadata.agentActivity);
  if (fact.success) return fact.data;
  if (!execution.metadata.nativeResult && !execution.output) return;
  return agentToolActivity({ toolCall: { name: execution.name },
    result: execution.metadata.nativeResult ?? parseToolOutputJson(execution.output) });
}

export type DefinitionActivity = AgentToolActivity & { kind: 'employee' | 'team'; action: 'save'; id: string };
export function isDefinitionActivity(activity?: AgentToolActivity): activity is DefinitionActivity {
  return !!activity?.id && activity.action === 'save' && activity.kind !== 'subagent';
}

/** Conversation receipts only; browsing the summary never enumerates the global registry. */
export function conversationRegistrations(messages: ChatMessage[]) {
  const definitions = new Map<string, DefinitionActivity>();
  for (const message of messages) for (const execution of message.toolExecutions ?? []) {
    if (execution.state !== 'completed' || !execution.success) continue;
    const activity = toolAgentActivity(execution);
    if (!activity?.id) continue;
    const key = `${activity.kind}:${activity.id}`;
    if (activity.action === 'delete') definitions.delete(key);
    if (isDefinitionActivity(activity)) definitions.set(key, activity);
  }
  return [...definitions.values()];
}
