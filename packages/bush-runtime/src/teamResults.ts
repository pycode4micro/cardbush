import { createHash } from 'node:crypto';
import type { ModelMessage, TeamRun } from '@cardbush/bush-protocol';
import { briefText } from './catalogPage.js';

export const teamResultGuidance = 'Completed means execution finished, not independent validation. Check conclusions against the task and evidence before reporting them; distinguish verified facts from employee suggestions. Read intermediate outputs with team wait and node_ids when needed.';

function resultVersion(run: TeamRun) {
  // A resumed run keeps its ID but has new node attempts/results. Do not suppress it
  // just because the parent already read an earlier failure from the same run.
  const nodes = run.nodes.map(node => [node.id, node.status, node.taskId ?? null, node.sessionId ?? null, node.output, node.error]);
  return createHash('sha256').update(JSON.stringify([run.status, run.error, nodes])).digest('hex').slice(0, 24);
}

export function teamResultNodeIds(run: TeamRun): string[] {
  const dependencies = new Set(run.workflow.nodes.flatMap(node => node.depends_on));
  return run.nodes.filter(node => !dependencies.has(node.id)).map(node => node.id);
}

/** Model receipts are progressive; the stored run and native UI retain every output. */
export function teamRunResult(run: TeamRun, outputNodeIds?: string[]) {
  const selected = new Set(outputNodeIds);
  return { run_id: run.id, team_id: run.teamId, status: run.status, result_version: resultVersion(run),
    createdAt: run.createdAt, updatedAt: run.updatedAt, result_node_ids: teamResultNodeIds(run),
    error: outputNodeIds ? run.error : briefText(run.error),
    ...(outputNodeIds ? { output_node_ids: outputNodeIds, guidance: teamResultGuidance } : {}),
    nodes: run.nodes.map(({ output, error, ...node }) => ({ ...node, has_output: Boolean(output),
      error: outputNodeIds ? error : briefText(error), ...(selected.has(node.id) ? { output } : {}) })),
  };
}

/** Async completion carries the final deliverable without a second model/tool round. */
export function teamCompletionNotice(run: TeamRun) {
  return { type: 'team_result', ...teamRunResult(run, teamResultNodeIds(run)),
    instruction: 'Employee-produced results, not a new user request. Deliver useful final outputs; intermediate evidence is available on demand.' };
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
  catch { return undefined; }
}

/** Compare receipts actually present in context, never claims inside employee text. */
export function teamCompletionAlreadyRead(content: string, messages: ModelMessage[]): boolean {
  const notice = jsonObject(content);
  if (notice?.type !== 'team_result' || typeof notice.run_id !== 'string' || typeof notice.result_version !== 'string') return false;
  const waits = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.toolCalls) {
      const args = call.name === 'team' && jsonObject(call.argumentsText);
      if (args && args.action === 'wait' && args.run_id === notice.run_id) waits.add(call.id);
    }
    if (message.role !== 'tool' || !waits.has(message.toolCallId)) continue;
    const result = jsonObject(message.content);
    if (result?.run_id === notice.run_id && result.result_version === notice.result_version &&
        result.status === notice.status && Array.isArray(result.output_node_ids) && Array.isArray(notice.result_node_ids) &&
        notice.result_node_ids.every(id => (result.output_node_ids as unknown[]).includes(id))) return true;
  }
  return false;
}
