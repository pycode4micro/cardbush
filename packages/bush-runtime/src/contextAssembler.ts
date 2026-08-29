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
  const committed = input.session.turns
    .filter((turn) => turn.turnSequence <= through)
    .flatMap((turn) => turn.messages)
    .filter((message) => !superseded.has(message.messageId));
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
  });
}
