import type { ChatMessage, ChatToolExecution } from '../../types';
import { chatMessageTurnId, isGuidanceSealedAssistantSegment } from './transcript/messageFacts';
import { mergeToolExecutionUpdate } from './transcript/toolExecutionMerge';

/**
 * Runtime message ownership and visual grouping are separate facts. Fold
 * adjacent tool-only rounds beneath the latest narration for live, stopped
 * and historical transcripts, without changing the source messages or Tools.
 * New narration, attachments, guidance and Turn boundaries end a group.
 */
export function coalesceAssistantTranscript(
  messages: ChatMessage[],
): ChatMessage[] {
  const compact: ChatMessage[] = [];
  for (const message of messages) {
    const previous = compact.at(-1);
    if (!previous || !canShareExecutionGroup(previous, message)) {
      compact.push(message);
      continue;
    }
    // Explicit offset-zero executions occurred before this message's text.
    // Keep them in the preceding package if that text arrives after the Tools;
    // the new narration only separates the executions that follow it.
    const executions = message.toolExecutions ?? [];
    const leadingExecutions = message.content.trim()
      ? executions.filter(execution => execution.contentOffsetExplicit && execution.contentOffset === 0)
      : executions;
    if (leadingExecutions.length === 0) {
      compact.push(message);
      continue;
    }
    compact[compact.length - 1] = {
      ...previous,
      taskPlan: message.taskPlan ?? previous.taskPlan,
      toolExecutions: mergePresentationExecutions(previous, leadingExecutions),
    };
    if (message.content.trim()) {
      const leadingIds = new Set(leadingExecutions.map(execution => execution.id));
      compact.push({ ...message, toolExecutions: executions.filter(execution => !leadingIds.has(execution.id)) });
    }
  }
  return compact;
}

function canShareExecutionGroup(
  previous: ChatMessage,
  message: ChatMessage,
) {
  return (
    previous.role === 'assistant' &&
    message.role === 'assistant' &&
    sameTurn(previous, message) &&
    !isGuidanceSealedAssistantSegment(previous) &&
    !isGuidanceSealedAssistantSegment(message) &&
    (message.attachments?.length ?? 0) === 0 &&
    (message.toolExecutions?.length ?? 0) > 0
  );
}

function sameTurn(left: ChatMessage, right: ChatMessage) {
  const leftTurn = chatMessageTurnId(left);
  const rightTurn = chatMessageTurnId(right);
  return Boolean(leftTurn && leftTurn === rightTurn);
}

function mergePresentationExecutions(
  previous: ChatMessage,
  executions: ChatToolExecution[],
) {
  const anchor = presentationToolAnchor(previous);
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of previous.toolExecutions ?? []) {
    byId.set(execution.id, execution);
  }
  for (const execution of executions) {
    const existing = byId.get(execution.id);
    const presented = {
      ...execution,
      // A tool-only persisted message has offset 0 because its own assistant
      // text is empty. Once folded into the preceding narration it must share
      // that narration's trailing tool boundary.
      contentOffset: existing?.contentOffset ?? anchor,
      contentOffsetExplicit: true,
    };
    byId.set(execution.id, existing ? mergeToolExecutionUpdate(existing, presented) : presented);
  }
  return [...byId.values()];
}

function presentationToolAnchor(message: ChatMessage) {
  return Math.max(
    message.content.length,
    0,
    ...(message.toolExecutions ?? []).map((execution) =>
      Number.isFinite(execution.contentOffset)
        ? Math.max(0, execution.contentOffset)
        : 0),
  );
}
