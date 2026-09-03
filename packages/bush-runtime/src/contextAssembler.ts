import {
  BUSH_CONTEXT_SNAPSHOT_PROTOCOL,
  contextSnapshotSchema,
  modelMessageSchema,
  type ContextSnapshot,
  type ModelMessage,
  type SessionSnapshot,
  type TurnContextCheckpoint,
} from "@cardbush/bush-protocol";

import { validateConversation } from "./sessionStore.js";

export interface AssembleContextInput {
  session: SessionSnapshot;
  prefix?: ModelMessage[];
  current?: ModelMessage[];
  throughTurnSequence?: number;
  maxChars?: number;
  maxSummaryTurns?: number;
}

export const ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME = "active_turn_checkpoint" as const;
export const ACTIVE_TURN_RESUME_MESSAGE_NAME = "context_checkpoint_resume" as const;

interface CheckpointMessageFact {
  messageId: string;
  message: ModelMessage;
}

export function projectActiveTurnContext(input: {
  turnId: string;
  inputMessages: CheckpointMessageFact[];
  generatedMessages: CheckpointMessageFact[];
  checkpoint?: TurnContextCheckpoint;
  includeResumeInstruction?: boolean;
}): ModelMessage[] {
  const inputs = input.inputMessages.map((item) => item.message);
  if (!input.checkpoint) {
    return [...inputs, ...input.generatedMessages.map((item) => item.message)];
  }
  if (input.checkpoint.inputMessageCount !== input.inputMessages.length) {
    throw new Error("Active Turn checkpoint input boundary does not match the Turn inputs.");
  }
  const boundaryIndex = input.generatedMessages.findIndex((item) =>
    item.messageId === input.checkpoint!.throughMessageId
  );
  if (boundaryIndex < 0) {
    throw new Error(
      `Active Turn checkpoint boundary ${input.checkpoint.throughMessageId} does not exist.`,
    );
  }
  const projected: ModelMessage[] = [
    ...inputs,
    activeTurnCheckpointMessage(input.turnId, input.checkpoint),
  ];
  if (input.includeResumeInstruction) projected.push(activeTurnResumeMessage());
  projected.push(
    ...input.generatedMessages.slice(boundaryIndex + 1).map((item) => item.message),
  );
  return projected;
}

export function activeTurnCheckpointMessage(
  turnId: string,
  checkpoint: TurnContextCheckpoint,
): ModelMessage {
  return {
    role: "assistant",
    content: `<${ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME} turn_id="${escapeAttribute(turnId)}" through_message_id="${escapeAttribute(checkpoint.throughMessageId)}">\n${checkpoint.summary}\n</${ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME}>`,
    toolCalls: [],
  };
}

export function activeTurnResumeMessage(): ModelMessage {
  return {
    role: "developer",
    name: ACTIVE_TURN_RESUME_MESSAGE_NAME,
    content: "The preceding assistant message is an intermediate factual checkpoint for the active Turn, not a final answer. Continue the original user request from its unresolved work and exact next action. Do not repeat completed writes, Tool operations, or external side effects. If the requested work is already complete, return the final user-facing answer.",
  };
}

export function assembleContext(input: AssembleContextInput): ContextSnapshot {
  const prefix = (input.prefix ?? []).map((message) => modelMessageSchema.parse(message));
  const current = (input.current ?? []).map((message) => modelMessageSchema.parse(message));
  const lastSequence = input.session.turns.at(-1)?.turnSequence ?? 0;
  const through = input.throughTurnSequence ?? lastSequence;
  if (!Number.isInteger(through) || through < 0 || through > lastSequence) {
    throw new Error(`throughTurnSequence must be between 0 and ${lastSequence}.`);
  }
  const superseded = new Set(input.session.supersededMessageIds);
  const eligibleTurns = input.session.turns
    .filter((turn) => turn.turnSequence <= through)
    .map((turn) => ({
      turn,
      source: turn.messages.filter((message) => !superseded.has(message.messageId)),
    }));
  const summarized = eligibleTurns.filter(({ turn, source }) =>
    turn.contextSummary && source.length === turn.messages.length,
  );
  const visibleSummaryIds = input.maxSummaryTurns === undefined
    ? new Set(summarized.map(({ turn }) => turn.turnId))
    : new Set(
        input.maxSummaryTurns === 0
          ? []
          : summarized.slice(-input.maxSummaryTurns).map(({ turn }) => turn.turnId),
      );
  const omittedSummaryCount = summarized.length - visibleSummaryIds.size;
  const committedTurns = eligibleTurns.flatMap(({ turn, source }) => {
    if (turn.contextSummary && source.length === turn.messages.length) {
      if (!visibleSummaryIds.has(turn.turnId)) return [];
      return [{
        source,
        messages: [{
          role: "user" as const,
          name: "turn_context_summary",
          visibility: "internal" as const,
          content: `<turn_context_summary turn_id="${escapeAttribute(turn.turnId)}" turn_sequence="${turn.turnSequence}">\n${turn.contextSummary}\n</turn_context_summary>`,
        }],
      }];
    }
    if (turn.contextCheckpoint && source.length === turn.messages.length) {
      return [{
        source,
        messages: projectActiveTurnContext({
          turnId: turn.turnId,
          inputMessages: turn.messages.slice(0, turn.contextCheckpoint.inputMessageCount),
          generatedMessages: turn.messages.slice(turn.contextCheckpoint.inputMessageCount),
          checkpoint: turn.contextCheckpoint,
        }),
      }];
    }
    return [{ source, messages: source.map((message) => message.message) }];
  });
  const fixedChars = messageChars([...prefix, ...current]);
  const budget = Math.max(0, (input.maxChars ?? Number.MAX_SAFE_INTEGER) - fixedChars);
  const selectedTurns: typeof committedTurns = [];
  let selectedChars = 0;
  for (let index = committedTurns.length - 1; index >= 0; index -= 1) {
    const turn = committedTurns[index]!;
    const chars = messageChars(turn.messages);
    if (selectedTurns.length > 0 && selectedChars + chars > budget) break;
    selectedTurns.unshift(turn);
    selectedChars += chars;
  }
  const committed = selectedTurns.flatMap((turn) => turn.messages);
  const sourceMessages = selectedTurns.flatMap((turn) => turn.source);
  const messages = [
    ...prefix,
    ...committed,
    ...current,
  ];
  validateConversation(messages);
  return contextSnapshotSchema.parse({
    protocol: BUSH_CONTEXT_SNAPSHOT_PROTOCOL,
    sessionId: input.session.sessionId,
    sessionRevision: input.session.revision,
    throughTurnSequence: through,
    sourceMessageIds: sourceMessages.map((message) => message.messageId),
    messages,
    estimatedTokens: Math.ceil(messageChars(messages) / 4),
    truncated:
      omittedSummaryCount > 0 || selectedTurns.length < committedTurns.length,
  });
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function messageChars(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}
