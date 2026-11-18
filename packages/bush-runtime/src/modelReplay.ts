import { createHash } from "node:crypto";
import type { ModelMessage, ModelRequest } from "@cardbush/bush-protocol";

type AssistantProjection = Pick<Extract<ModelMessage, { role: "assistant" }>,
  "content" | "reasoningContent" | "toolCalls">;

/** Bind opaque provider output to the exact, unmodified message it represents. */
export function modelReplayMessageHash(message: AssistantProjection): string {
  return createHash("sha256").update(JSON.stringify([
    message.content,
    message.reasoningContent ?? "",
    message.toolCalls.map((call) => [call.id, call.name, call.argumentsText]),
  ])).digest("hex");
}

export function modelReplayMatches(
  message: Extract<ModelMessage, { role: "assistant" }>,
  request: Pick<ModelRequest, "model" | "providerBinding">,
): boolean {
  const replay = message.providerReplay;
  return Boolean(replay && replay.model === request.model &&
    replay.providerBinding?.bindingId === request.providerBinding?.bindingId &&
    replay.providerBinding?.revision === request.providerBinding?.revision &&
    replay.messageHash === modelReplayMessageHash(message));
}

export function modelToolCallIds(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap(message => message.role === 'assistant' ? message.toolCalls.map(call => call.id) : []);
}

/** Native reply IDs are transport facts. Canonical history uses Runtime IDs. */
export function providerToolCallId(replay: Extract<ModelMessage, { role: 'assistant' }>['providerReplay'], id: string): string {
  return replay?.toolCallIds && Object.hasOwn(replay.toolCallIds, id) ? replay.toolCallIds[id]! : id;
}
