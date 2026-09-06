import { modelMessageSchema, type ModelMessage, type SessionSnapshot } from "@cardbush/bush-protocol";
import type { LogicMemoryStore } from "./logicMemory.js";

export const LOGIC_REMINDER_NAME = "lem_consult_reminder";
// Only trusted, fixed reminder text enters developer priority. Never interpolate lessons,
// user text, matched terms or file content into this instruction.
export const LOGIC_REMINDER_CONTENT = "Memory assistant note: Local lexical matching of this conversation found possible overlap with stored reasoning lessons. Consider consult_logic to check current assumptions, even if confident. This is an optional reminder, not a relevance guarantee or a required Tool call. Decide whether it is useful and ignore inapplicable lessons.";

function isUserInstruction(message: ModelMessage): boolean {
  return message.role === "user" && message.visibility !== "internal";
}

function isFinalReply(message: ModelMessage | undefined): boolean {
  return message?.role === "assistant" && message.toolCalls.length === 0;
}

/** Original facts, not context summaries, private reasoning, Tools or internal notices. */
export function collectLogicReminderTexts(input: {
  session?: SessionSnapshot;
  turnId: string;
  currentMessages: ModelMessage[];
  supersededMessageIds?: string[];
}): string[] {
  const texts: string[] = [];
  if (input.session) {
    const superseded = new Set([
      ...input.session.supersededMessageIds, ...(input.supersededMessageIds ?? []),
    ]);
    for (const turn of input.session.turns) {
      if (turn.turnId === input.turnId) continue;
      let final: { messageId: string; message: ModelMessage } | undefined;
      for (const entry of turn.messages) {
        if (!superseded.has(entry.messageId) && isUserInstruction(entry.message)) texts.push(entry.message.content);
        if (entry.message.role === "assistant") final = entry;
      }
      // Removing the final reply must not promote an earlier progress message to "final".
      if (turn.status === "completed" && final && !superseded.has(final.messageId) && isFinalReply(final.message)) {
        texts.push(final.message.content);
      }
    }
    for (const message of input.currentMessages) {
      if (isUserInstruction(message)) texts.push(message.content);
    }
  } else {
    // Raw/child model requests have no committed-Turn status. Only take the last
    // assistant reply before the next actual user request, never an ongoing partial.
    let previousAssistant: ModelMessage | undefined;
    for (const message of input.currentMessages) {
      if (isUserInstruction(message)) {
        if (isFinalReply(previousAssistant)) texts.push(previousAssistant!.content);
        texts.push(message.content);
        previousAssistant = undefined;
      } else if (message.role === "assistant") previousAssistant = message;
    }
  }
  return [...new Set(texts.filter((text) => text.trim()))];
}

function isReminder(message: ModelMessage | undefined): boolean {
  return message?.role === "developer" && message.name === LOGIC_REMINDER_NAME;
}

export async function prepareLogicReminder(input: {
  memory: Pick<LogicMemoryStore, "hasConversationMatch">;
  enabled: boolean;
  nextRound: number;
  turnId: string;
  session?: SessionSnapshot;
  currentMessages: ModelMessage[];
  generatedMessages: ModelMessage[];
  messages: ModelMessage[];
  supersededMessageIds?: string[];
}): Promise<ModelMessage | undefined> {
  if (!input.enabled || input.nextRound !== 1 ||
      input.generatedMessages.some(isReminder) || isReminder(input.messages.at(-1))) return;
  try {
    const texts = collectLogicReminderTexts(input);
    if (await input.memory.hasConversationMatch(texts)) {
      // Match durable schema field ordering so the next Turn/recovery keeps the exact digest.
      return modelMessageSchema.parse({ role: "developer", name: LOGIC_REMINDER_NAME, content: LOGIC_REMINDER_CONTENT });
    }
  } catch {
    // Advisory memory must never block the user's Turn. Explicit consult still reports
    // store errors through its normal Tool result; no fabricated fallback hint is emitted.
  }
  return undefined;
}
