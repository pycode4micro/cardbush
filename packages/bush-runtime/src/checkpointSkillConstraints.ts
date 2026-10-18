import type { ModelMessage } from '@cardbush/bush-protocol';

// Maintenance-only guidance: never added to the system prompt or Tool catalog.
export const CHECKPOINT_SKILL_CONSTRAINT_GUIDANCE =
  'In each source summary, retain applicable Skill requirements in one <skill_constraints>...</skill_constraints> block within the existing budget. ' +
  'Review the previous checkpoint block against user corrections and verified progress. Keep critical wording, task scope/future trigger and exact source locator (read path/section or archived receipt; keep existing hash/version). ' +
  'Continuous constraints remain after being followed once; completed one-time steps belong in completed facts, not pending rules. ' +
  'Follow the Skill source index when supplied; otherwise if all retire use <skill_constraints>none: reason</skill_constraints>. Sources without Skill requirements need no block. ' +
  'The model judges applicability/completion; Skills do not override user instructions or grant permission. In consolidation, use only indexed source summaries and preserve future requirements. ' +
  'Do not create a remember file or reread all Skills; use existing references for details or uncertainty.';

const opening = '<skill_constraints>';
const closing = '</skill_constraints>';

/** This is a small handoff section inside model-authored text, not a second
 * memory store or a semantic rule evaluator. Never extract instructions from
 * arbitrary user text, file contents or rejected checkpoint drafts. */
export function checkpointSkillConstraintsIssue(summary: string, required = false): string | undefined {
  const start = summary.indexOf(opening), end = summary.indexOf(closing);
  if (start < 0 && end < 0) return required
    ? 'Retain and review the previous <skill_constraints> block for this source, including requirement scopes/triggers and source locators. If none remain, state none: with a brief reason in the block.'
    : undefined;
  if (start < 0 || end < start || summary.indexOf(opening, start + opening.length) >= 0 ||
    summary.indexOf(closing, end + closing.length) >= 0) {
    return 'Use exactly one complete <skill_constraints>...</skill_constraints> block inside the existing summary string.';
  }
  const body = summary.slice(start + opening.length, end).trim();
  if (!body || /^none\s*:?[\s]*$/i.test(body)) {
    return 'The Skill constraints block must contain scoped requirements with source locators, or none: followed by a brief reason.';
  }
  return undefined;
}

export function hasActiveCheckpointSkillConstraints(summary: string): boolean {
  if (checkpointSkillConstraintsIssue(summary)) return false;
  const start = summary.indexOf(opening);
  return start >= 0 && !/^none:\s*\S/i.test(summary.slice(start + opening.length, summary.indexOf(closing)).trim());
}

/** Genuine successful checkpoint exchanges already hold the authored summaries.
 * Read those facts in place; do not copy them into another persistence format.
 * An incremental complete receipt is authoritative even when its last call
 * submitted only one source. Rejected entries never create carry obligations. */
export function hasInheritedCheckpointSkillConstraints(messages: ModelMessage[]): boolean {
  for (let index = 0; index < messages.length - 1; index++) {
    const message = messages[index]!, receipt = messages[index + 1]!;
    if (message.role !== 'assistant' || message.toolCalls.length !== 1 ||
      message.toolCalls[0]!.name !== 'checkpoint_context' || receipt.role !== 'tool' ||
      receipt.toolCallId !== message.toolCalls[0]!.id) continue;
    try {
      const result = JSON.parse(receipt.content);
      if ((result.complete === true || Array.isArray(result.summarized_turns)) && Array.isArray(result.skill_evidence)) {
        if (result.skill_evidence.some((item: { excerpts?: unknown[] }) => item.excerpts?.length)) return true;
        continue;
      }
      if (result.complete === true && Array.isArray(result.summaries)) {
        if (result.summaries.some((item: { summary?: unknown }) => typeof item?.summary === 'string' &&
          hasActiveCheckpointSkillConstraints(item.summary))) return true;
      } else if (Array.isArray(result.summarized_turns)) {
        const args = JSON.parse(message.toolCalls[0]!.argumentsText);
        const summaries = Array.isArray(args.summaries) ? args.summaries.map((item: unknown) =>
          typeof item === 'string' ? item : (item as { summary?: unknown } | null)?.summary) : [];
        summaries.push(args.active_summary, args.active_turn?.summary);
        if (summaries.some((summary: unknown) => typeof summary === 'string' && hasActiveCheckpointSkillConstraints(summary))) return true;
      }
    } catch { /* Non-checkpoint Tool data is not a source of constraints. */ }
  }
  return false;
}
