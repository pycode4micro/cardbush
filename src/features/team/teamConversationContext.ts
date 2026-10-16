import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';

export const TEAM_WORKSPACE_INSTRUCTIONS = `This conversation is in the Team workflow workspace. The diagram is rendered from saved team definitions and actual run snapshots. For workflow creation or changes, use the team tool to read and save structured nodes and depends_on; never substitute an illustrative diagram or a Markdown file for a real workflow. The editing-location context captures the target team, revision, selected node and viewed run at submission time. Read the current definition before modifying it and use expected_revision to preserve concurrent changes. For a new workflow, use its provided team ID. Reuse suitable registered employees; use subagent save to create or update employees when necessary. For advanced actions such as save, load the team or subagent schema with get_tool_schema, then invoke call_tool with that name and the full arguments. Common actions in the declared compact schemas remain directly callable. Name steps by their work and deliverables; choose dependencies and concurrency yourself. Preserve unrelated nodes and optional presentation notes. Editing a saved definition changes future runs; a running or historical snapshot is immutable. Run or resume only when the user requests execution; setting up a workflow alone is not a request to run it. Use real tool results to report progress and failures. Ordinary questions do not require creating a workflow. Keep final replies brief because the diagram and node results show the details.`;

/** Capture the target before queueing; browsing another workflow cannot retarget a turn. */
export function teamConversationRequest(input: UserPromptInput, target: { teamId: string; revision: number; nodeId?: string; runId?: string }): UserPromptInput {
  const prompt = readUserPrompt(input);
  return { ...prompt, context: [...prompt.context ?? [], {
    kind: 'editing-location', content: `Team workflow target (data): ${JSON.stringify(target)}`,
  }] };
}
