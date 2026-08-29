import {
  BUSH_CONTEXT_SNAPSHOT_PROTOCOL,
  contextSnapshotSchema,
  modelMessageSchema,
  type ContextSnapshot,
  type ModelMessage,
  type SessionSnapshot,
} from "@cardbush/bush-protocol";

import { validateConversation } from "./sessionStore.js";

export interface AssembleContextInput {
  session: SessionSnapshot;
  prefix?: ModelMessage[];
  current?: ModelMessage[];
  throughTurnSequence?: number;
  maxChars?: number;
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
  const committedTurns = input.session.turns
    .filter((turn) => turn.turnSequence <= through)
    .map((turn) => turn.messages.filter((message) => !superseded.has(message.messageId)));
  const fixedChars = messageChars([...prefix, ...current]);
  const budget = Math.max(0, (input.maxChars ?? Number.MAX_SAFE_INTEGER) - fixedChars);
  const selectedTurns: typeof committedTurns = [];
  let selectedChars = 0;
  for (let index = committedTurns.length - 1; index >= 0; index -= 1) {
    const turn = committedTurns[index]!;
    const chars = messageChars(turn.map((message) => message.message));
    if (selectedTurns.length > 0 && selectedChars + chars > budget) break;
    selectedTurns.unshift(turn);
    selectedChars += chars;
  }
  const committed = selectedTurns.flat();
  const messages = [
    ...prefix,
    ...committed.map((message) => message.message),
    ...current,
  ];
  validateConversation(messages);
  return contextSnapshotSchema.parse({
    protocol: BUSH_CONTEXT_SNAPSHOT_PROTOCOL,
    sessionId: input.session.sessionId,
    sessionRevision: input.session.revision,
    throughTurnSequence: through,
    sourceMessageIds: committed.map((message) => message.messageId),
    messages,
    estimatedTokens: Math.ceil(messageChars(messages) / 4),
    truncated: selectedTurns.length < committedTurns.length,
  });
}

function messageChars(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify(message).length, 0);
}
