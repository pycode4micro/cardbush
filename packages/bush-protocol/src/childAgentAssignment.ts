import { renderPromptTemplate } from '@cardbush/platform/prompts';

export const CHILD_AGENT_ASSIGNMENT_PREFIX = renderPromptTemplate('child-agent-assignment-prefix');
/** Extract authored text for display without changing the stored/model message. */
export function childAgentAssignmentText(content: string): string | undefined {
  return content.startsWith(CHILD_AGENT_ASSIGNMENT_PREFIX + '\n')
    ? content.slice(CHILD_AGENT_ASSIGNMENT_PREFIX.length).trimStart() : undefined;
}
