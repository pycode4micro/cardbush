import { renderPromptTemplate } from '@cardbush/platform/prompts';

export const CHILD_AGENT_ASSIGNMENT_PREFIX = renderPromptTemplate('child-agent-assignment-prefix');
// Exact historical envelope only. This is not language detection or semantic filtering.
const assignmentPrefixes = [CHILD_AGENT_ASSIGNMENT_PREFIX, '你当前处于子agent状态'];

/** Extract authored text for display without changing the stored/model message. */
export function childAgentAssignmentText(content: string): string | undefined {
  const prefix = assignmentPrefixes.find(value => content.startsWith(value + '\n'));
  return prefix === undefined ? undefined : content.slice(prefix.length).trimStart();
}
