import type { ChatMessage, ChatToolExecution } from '../../types';

/**
 * The Runtime persists one assistant message per model/tool round. While a
 * Turn is live, adjacent tool-only rounds are shown as one group beneath the
 * preceding narration. Rebuild that renderer-only grouping for a stopped
 * Turn so Stop does not visually explode it into one history card per tool.
 * The persisted append-only transcript remains untouched.
 */
export function coalesceStoppedAssistantTranscript(
  messages: ChatMessage[],
): ChatMessage[] {
  const compact: ChatMessage[] = [];
  for (const message of messages) {
    const previous = compact.at(-1);
    if (!previous || !isMergeableToolOnlyRound(previous, message)) {
      compact.push(message);
      continue;
    }
    compact[compact.length - 1] = {
      ...previous,
      taskPlan: message.taskPlan ?? previous.taskPlan,
      toolExecutions: mergePresentationExecutions(previous, message),
    };
  }
  return compact;
}

function isMergeableToolOnlyRound(
  previous: ChatMessage,
  message: ChatMessage,
) {
  return (
    previous.role === 'assistant' &&
    message.role === 'assistant' &&
    sameTurn(previous, message) &&
    !message.content.trim() &&
    (message.attachments?.length ?? 0) === 0 &&
    (message.toolExecutions?.length ?? 0) > 0
  );
}

function sameTurn(left: ChatMessage, right: ChatMessage) {
  const leftTurn = left.turnId?.trim() ?? '';
  const rightTurn = right.turnId?.trim() ?? '';
  return Boolean(leftTurn && leftTurn === rightTurn);
}

function mergePresentationExecutions(
  previous: ChatMessage,
  message: ChatMessage,
) {
  const anchor = presentationToolAnchor(previous);
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of previous.toolExecutions ?? []) {
    byId.set(execution.id, execution);
  }
  for (const execution of message.toolExecutions ?? []) {
    if (byId.has(execution.id)) continue;
    byId.set(execution.id, {
      ...execution,
      // A tool-only persisted message has offset 0 because its own assistant
      // text is empty. Once folded into the preceding narration it must share
      // that narration's trailing tool boundary.
      contentOffset: anchor,
    });
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
