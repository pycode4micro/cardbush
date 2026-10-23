import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { summaryForUserInputSchema, type CommittedTurn, type TurnToolHandoff, type ModelMessage } from '@cardbush/bush-protocol';
import { collectCheckpointSkillExcerpts, validateCheckpointSkillEvidence, checkpointSkillReceiptEvidence,
  mergeCheckpointSkillExcerpts, packCheckpointSkillEvidence, checkpointSkillContractNotice } from './checkpointSkillEvidence.js';
import { checkpointSkillConstraintsIssue } from './checkpointSkillConstraints.js';

const digest = (summary: string) => createHash('sha256').update(summary).digest('hex');

/** The receipt binds preparation to the exact model-authored text. It does not
 * assert semantic correctness, completion of business work or user approval. */
export function preparedToolHandoffReceipt(summary?: string, messages: ModelMessage[] = []) {
  if (!summary) return {};
  const excerpts = collectCheckpointSkillExcerpts(messages);
  const validated = validateCheckpointSkillEvidence(summary, { excerpts });
  const issue = checkpointSkillConstraintsIssue(summary, excerpts.length > 0) ?? validated.issue;
  if (issue) return { context_handoff: { version: 1, status: 'not_reusable', reason: issue,
    source_index: checkpointSkillContractNotice(new Map([[0, { excerpts }]])),
    next: 'You may correct the summary once, or finish normally; unavailable preparation falls back to on-demand compaction.' } };
  return { context_handoff: { version: 1, status: 'prepared', summary_sha256: digest(summary) },
    ...(excerpts.length ? { skill_evidence: packCheckpointSkillEvidence([{ source: 0, excerpts: validated.excerpts }]) } : {}) };
}

/** Only a successful, standalone final-display call followed by final prose is
 * reusable. Any later tool work/guidance requires a fresh handoff. Legacy calls,
 * incomplete Turns and edited/superseded facts fall back to normal compaction. */
export function findPreparedToolHandoff(turn: CommittedTurn): TurnToolHandoff | undefined {
  if (turn.status !== 'completed') return;
  const facts = turn.messages;
  for (let index = facts.length - 3; index >= 0; index--) {
    const message = facts[index]!.message, receipt = facts[index + 1]!;
    if (message.role !== 'assistant' || message.toolCalls.length !== 1 || message.toolCalls[0]!.name !== 'summary_for_user') continue;
    const call = message.toolCalls[0]!;
    if (receipt.message.role !== 'tool' || receipt.message.toolCallId !== call.id) continue;
    let summary: string | undefined, savedEvidence: ReturnType<typeof checkpointSkillReceiptEvidence> = [];
    try {
      summary = summaryForUserInputSchema.parse(JSON.parse(call.argumentsText)).tool_summary;
      const value = JSON.parse(receipt.message.content);
      if (!summary || value.status !== 'ok' || value.final_response !== true ||
        value.context_handoff?.version !== 1 || value.context_handoff.status !== 'prepared' ||
        value.context_handoff.summary_sha256 !== digest(summary)) continue;
      savedEvidence = checkpointSkillReceiptEvidence(receipt.message);
    } catch { continue; }
    const following = facts.slice(index + 2);
    const finals = following.filter(item => item.message.role === 'assistant' && item.message.content.trim());
    if (!finals.length || following.some(({ message }) =>
      !(message.role === 'assistant' && message.toolCalls.length === 0) &&
      !(message.role === 'user' && message.visibility === 'internal' && message.name === 'memory_state_updates'))) continue;
    if (!facts.slice(0, index).some(item => item.message.role === 'tool')) continue;
    // A prior checkpoint is preserved separately in the projected context.
    // Validate source references only for the additional raw exchanges removed.
    const excerpts = mergeCheckpointSkillExcerpts([handoffSources(turn, index), savedEvidence.flatMap(item => item.excerpts)]);
    if (checkpointSkillConstraintsIssue(summary, excerpts.length > 0) ||
      validateCheckpointSkillEvidence(summary, { excerpts }).issue) continue;
    return { summaryMessageId: facts[index]!.messageId, receiptMessageId: receipt.messageId,
      finalMessageIds: finals.map(item => item.messageId) };
  }
}

function handoffSources(turn: CommittedTurn, index: number) {
  const checkpoint = turn.contextCheckpoint;
  const boundary = checkpoint ? turn.messages.findIndex(item => item.messageId === checkpoint.throughMessageId) : -1;
  const retained = new Set(checkpoint?.projectionVersion === 'exchange_v1' ? checkpoint.retainedMessageIds : []);
  return collectCheckpointSkillExcerpts(turn.messages.slice(0, index)
    .filter((item, position) => position > boundary || retained.has(item.messageId)).map(item => item.message));
}

/** Re-derive verified references from canonical receipts, never from prose alone.
 * Keep them outside model messages; later checkpoint transactions reuse the
 * existing version/range validator without resending source paragraphs. */
export function preparedToolHandoffEvidence(turn: CommittedTurn, handoff: TurnToolHandoff) {
  validatePreparedToolHandoff(turn, handoff);
  const index = turn.messages.findIndex(item => item.messageId === handoff.summaryMessageId);
  const message = turn.messages[index]!.message;
  if (message.role !== 'assistant') return [];
  const summary = summaryForUserInputSchema.parse(JSON.parse(message.toolCalls[0]!.argumentsText)).tool_summary!;
  const saved = checkpointSkillReceiptEvidence(turn.messages[index + 1]!.message).flatMap(item => item.excerpts);
  return validateCheckpointSkillEvidence(summary, { excerpts: mergeCheckpointSkillExcerpts([handoffSources(turn, index), saved]) }).excerpts;
}

export function validatePreparedToolHandoff(turn: CommittedTurn, handoff: TurnToolHandoff): void {
  if (!isDeepStrictEqual(findPreparedToolHandoff(turn), handoff)) {
    throw new Error('Prepared tool handoff must reference a successful, current summary and its final assistant response.');
  }
}

export function preparedToolHandoffText(turn: CommittedTurn, handoff: TurnToolHandoff): string {
  validatePreparedToolHandoff(turn, handoff);
  const message = turn.messages.find(item => item.messageId === handoff.summaryMessageId)!.message;
  if (message.role !== 'assistant') throw new Error('Prepared handoff has no assistant call.');
  const summary = summaryForUserInputSchema.parse(JSON.parse(message.toolCalls[0]!.argumentsText)).tool_summary!;
  const final = handoff.finalMessageIds.map(id => turn.messages.find(item => item.messageId === id)!.message.content).join('\n\n');
  return `<tool_summary turn_id=${JSON.stringify(turn.turnId)}>\n${summary}\n</tool_summary>\n\n${final}`;
}
