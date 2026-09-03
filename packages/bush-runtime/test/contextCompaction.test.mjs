import assert from "node:assert/strict";
import test from "node:test";

import {
  contextToolIngressTokenBudget,
  projectContextCompactionMaintenanceMessages,
  requiresContextCompactionBeforeRound,
  resolveContextOutputTokens,
} from "../dist/index.js";

test("uses one enforced output limit for pressure and Provider dispatch", () => {
  assert.equal(resolveContextOutputTokens(256_000), 8_192);
  assert.equal(resolveContextOutputTokens(1_000_000), 8_192);
  assert.equal(resolveContextOutputTokens(256_000, 12_000), 12_000);
  assert.throws(() => resolveContextOutputTokens(4_000, 4_000), /must be less/);
});

test("reserves the next checkpoint before a response can cross the hard boundary", () => {
  const safe = pressure({ estimatedPromptTokens: 185_000 });
  const lastSafeBoundary = pressure({
    estimatedPromptTokens: 191_000,
    reservedOutputTokens: 32_000,
    usableInputTokens: 224_000,
    ratio: 191_000 / 224_000,
  });

  assert.equal(requiresContextCompactionBeforeRound(safe), false);
  assert.equal(
    requiresContextCompactionBeforeRound(lastSafeBoundary),
    true,
    "a large configured response must trigger before the nominal 95% line",
  );
  assert.equal(contextToolIngressTokenBudget({
    pressure: safe,
    actualInputTokens: 185_000,
    actualOutputTokens: 1_684,
  }), 59_076);
});

test("applies the same checkpoint invariant to a one-million-token window", () => {
  const usableInputTokens = 1_000_000 - 8_192;
  const belowThreshold = pressure({
    estimatedPromptTokens: 940_000,
    usableInputTokens,
    ratio: 940_000 / usableInputTokens,
  });
  const mandatory = pressure({
    estimatedPromptTokens: 943_000,
    usableInputTokens,
    ratio: 943_000 / usableInputTokens,
  });

  assert.equal(requiresContextCompactionBeforeRound(belowThreshold), false);
  assert.equal(requiresContextCompactionBeforeRound(mandatory), true);
  assert.equal(contextToolIngressTokenBudget({
    pressure: belowThreshold,
    actualInputTokens: 940_000,
    actualOutputTokens: 8_000,
  }), 41_760);
});

test("slims only an emergency checkpoint request without mutating legacy history", () => {
  const archivedResult = (id) => JSON.stringify({
    archived: true,
    locator: `tool-result://session/turn/${id}`,
    originalChars: 48_000,
    preview: "x".repeat(15_000),
  });
  const messages = [{
    role: "assistant",
    content: "completed reasoning and called tools",
    reasoningContent: "r".repeat(50_000),
    toolCalls: [0, 1, 2].map((index) => ({
      id: `call_${index}`,
      name: "fixture",
      argumentsText: "{}",
    })),
  }, ...[0, 1, 2].map((index) => ({
    role: "tool",
    toolCallId: `call_${index}`,
    content: archivedResult(`call_${index}`),
  }))];
  const canonical = structuredClone(messages);

  const projection = projectContextCompactionMaintenanceMessages({
    messages,
    sessionId: "session",
    turnId: "turn",
    pressure: {
      estimatedPromptTokens: 120_000,
      measurement: "provider",
      fallbackPromptTokens: 100_000,
      fallbackScale: 1,
      reservedOutputTokens: 8_000,
      usableInputTokens: 100_000,
      ratio: 1.2,
    },
  });

  assert.deepEqual(messages, canonical, "the append-only source must remain exact");
  assert.equal(projection.omittedReasoningMessages, 1);
  assert.ok(projection.compactedToolResults > 0);
  assert.equal(projection.messages[0].reasoningContent, undefined);
  const receipts = projection.messages
    .filter((message) => message.role === "tool")
    .map((message) => JSON.parse(message.content))
    .filter((result) => result.contextCheckpointProjection === true);
  assert.ok(receipts.length > 0);
  assert.ok(receipts.every((result) =>
    result.archived === true && result.locator.startsWith("tool-result://session/turn/")));
});

function pressure(overrides = {}) {
  const usableInputTokens = 247_808;
  const estimatedPromptTokens = overrides.estimatedPromptTokens ?? 185_000;
  return {
    estimatedPromptTokens,
    measurement: "provider",
    fallbackPromptTokens: estimatedPromptTokens,
    fallbackScale: 1,
    reservedOutputTokens: 8_192,
    usableInputTokens,
    ratio: estimatedPromptTokens / usableInputTokens,
    ...overrides,
  };
}
