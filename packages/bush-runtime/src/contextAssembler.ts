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
  coveredTurnIds?: string[];
}

export interface ContextTurnSource {
  turnId: string;
  messages: ModelMessage[];
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
  if (input.checkpoint.projectionVersion === "exchange_v1") {
    const [assistantId, receiptId] = input.checkpoint.exchangeMessageIds;
    const assistantIndex = input.generatedMessages.findIndex(item => item.messageId === assistantId);
    const assistant = input.generatedMessages[assistantIndex]?.message;
    const receipt = input.generatedMessages[assistantIndex + 1];
    if (assistantIndex < 0 || assistantIndex + 1 !== boundaryIndex ||
      assistant?.role !== "assistant" || assistant.toolCalls.length !== 1 ||
      assistant.toolCalls[0]!.name !== "checkpoint_context" ||
      receipt?.messageId !== receiptId || receipt.message.role !== "tool" ||
      receipt.message.toolCallId !== assistant.toolCalls[0]!.id) {
      throw new Error("Context checkpoint must reference its complete canonical assistant/tool exchange.");
    }
    return [...inputs, assistant, receipt.message,
      ...input.generatedMessages.slice(boundaryIndex + 1).map(item => item.message)];
  }
  const projected: ModelMessage[] = [
    ...inputs,
    activeTurnCheckpointMessage(input.turnId, input.checkpoint),
  ];
  // Legacy checkpoints already sent this message. Keep it at the same position
  // in committed history and after recovery; new checkpoints use stable rules.
  if (input.checkpoint.projectionVersion !== "stable_v1") projected.push(activeTurnResumeMessage());
  projected.push(
    ...input.generatedMessages.slice(boundaryIndex + 1).map((item) => item.message),
  );
  return projected;
}

export function activeTurnCheckpointMessage(
  turnId: string,
  checkpoint: Exclude<TurnContextCheckpoint, { projectionVersion: "exchange_v1" }>,
): ModelMessage {
  return {
    // Legacy journals contain summary text without the original model output.
    // This explicit compatibility view cannot reconstruct missing reasoning;
    // new checkpoints exclusively reference their genuine call and receipt.
    role: "user",
    name: ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME,
    visibility: "internal",
    content: `<${ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME} turn_id="${escapeAttribute(turnId)}" through_message_id="${escapeAttribute(checkpoint.throughMessageId)}">\n${checkpoint.summary}\n</${ACTIVE_TURN_CHECKPOINT_MESSAGE_NAME}>`,
  };
}

export function activeTurnResumeMessage(): ModelMessage {
  return {
    role: "developer",
    name: ACTIVE_TURN_RESUME_MESSAGE_NAME,
    content: "The preceding checkpoint is an intermediate factual summary for the active Turn, not a final answer. Continue the original user request from its unresolved work and exact next action. Do not repeat completed writes, Tool operations, or external side effects. If the requested work is already complete, return the final user-facing answer.",
  };
}

export function assembleContext(input: AssembleContextInput): ContextSnapshot {
  return assembleContextProjection(input).context;
}

/** Derive source ownership from the same projection used for normal requests. */
export function assembleContextProjection(input: AssembleContextInput): {
  context: ContextSnapshot;
  turns: ContextTurnSource[];
} {
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
  const covered = new Set(input.coveredTurnIds ?? []);
  for (const { turn, source } of eligibleTurns) {
    if (source.length === turn.messages.length &&
      turn.contextCheckpoint?.projectionVersion === "exchange_v1") {
      for (const id of turn.contextCheckpoint.coveredTurnIds) covered.add(id);
    }
  }
  const summarized = eligibleTurns.filter(({ turn, source }) =>
    !covered.has(turn.turnId) && turn.contextSummary && source.length === turn.messages.length,
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
    if (!source.length || covered.has(turn.turnId)) return [];
    if (turn.contextSummary && source.length === turn.messages.length) {
      if (!visibleSummaryIds.has(turn.turnId)) return [];
      return [{
        turnId: turn.turnId,
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
        turnId: turn.turnId,
        source,
        messages: projectActiveTurnContext({
          turnId: turn.turnId,
          inputMessages: turn.messages.slice(0, turn.contextCheckpoint.inputMessageCount),
          generatedMessages: turn.messages.slice(turn.contextCheckpoint.inputMessageCount),
          checkpoint: turn.contextCheckpoint,
        }),
      }];
    }
    return [{ turnId: turn.turnId, source, messages: source.map((message) => message.message) }];
  }).map(({ turnId, source, messages }) => ({
    turnId,
    source,
    // Retired automatic LEM prompts stay in the journal for audit, but must not
    // keep directing new Turns. Match only the old Runtime message identity.
    messages: messages.filter((message) =>
      !(message.role === "developer" && message.name === "lem_consult_reminder")
    ),
  }));
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
  const committed = selectedTurns.flatMap(({ messages }) => messages);
  const sourceMessages = selectedTurns.flatMap((turn) => turn.source);
  const messages = [
    ...prefix,
    ...committed,
    ...current,
  ];
  validateConversation(messages);
  const context = contextSnapshotSchema.parse({
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
  return { context, turns: selectedTurns.map(({ turnId, messages }) => ({ turnId, messages })) };
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function messageChars(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}
