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
  return createAssistantTranscriptProjector()(messages);
}

type TranscriptContinuation = {
  source: ChatMessage;
  executions: ChatToolExecution[];
  remainder?: ChatMessage;
};
type TranscriptGroup = { head: ChatMessage; continuations: TranscriptContinuation[] };

/** One mounted transcript retains only its last groups. Identity follows the
 * immutable source records, so late results invalidate their original group. */
export function createAssistantTranscriptProjector() {
  const prepared = new WeakMap<ChatMessage, TranscriptContinuation>();
  let previous = new Map<ChatMessage, { continuations: TranscriptContinuation[]; result: ChatMessage }>();
  return (messages: ChatMessage[]): ChatMessage[] => {
    const groups: TranscriptGroup[] = [];
    for (const message of messages) {
      const group = groups.at(-1);
      if (!group || !canShareExecutionGroup(group.head, message)) {
        groups.push({ head: message, continuations: [] });
        continue;
      }
      let part = prepared.get(message);
      if (!part) {
        const executions = message.toolExecutions ?? [];
        // Tools at offset zero precede newly streamed narration; keep those
        // in the preceding group and start the new text at its original ID.
        const leading = message.content.trim()
          ? executions.filter(execution => execution.contentOffsetExplicit && execution.contentOffset === 0)
          : executions;
        const leadingIds = new Set(leading.map(execution => execution.id));
        part = { source: message, executions: leading,
          remainder: message.content.trim()
            ? { ...message, toolExecutions: executions.filter(execution => !leadingIds.has(execution.id)) }
            : undefined };
        prepared.set(message, part);
      }
      if (!part.executions.length) groups.push({ head: message, continuations: [] });
      else {
        group.continuations.push(part);
        if (part.remainder) groups.push({ head: part.remainder, continuations: [] });
      }
    }
    const next = new Map<ChatMessage, { continuations: TranscriptContinuation[]; result: ChatMessage }>();
    const result = groups.map(group => {
      const cached = previous.get(group.head);
      const unchanged = cached && cached.continuations.length === group.continuations.length &&
        cached.continuations.every((part, index) => part === group.continuations[index]);
      const entry = unchanged ? cached : { continuations: group.continuations,
        result: group.continuations.length ? mergePresentationGroup(group) : group.head };
      next.set(group.head, entry);
      return entry.result;
    });
    previous = next;
    return result;
  };
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

function mergePresentationGroup({ head, continuations }: TranscriptGroup): ChatMessage {
  const anchor = presentationToolAnchor(head);
  const byId = new Map<string, ChatToolExecution>();
  for (const execution of head.toolExecutions ?? []) {
    byId.set(execution.id, execution);
  }
  let taskPlan = head.taskPlan;
  // Build the Tool list once per changed group instead of copying its growing
  // prefix once for every tool-only round (quadratic for long loops).
  for (const part of continuations) {
    taskPlan = part.source.taskPlan ?? taskPlan;
    for (const execution of part.executions) {
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
  }
  return { ...head, taskPlan, toolExecutions: [...byId.values()] };
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
