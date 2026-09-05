import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  bindContextCheckpointInput,
  ContextCheckpointInputError,
  contextCheckpointFailure,
  contextPressureNotice,
  registerContextCompactionTool,
} from "../dist/contextCompaction.js";
import { ToolRegistry } from "../dist/toolRegistry.js";

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

const authorization = () => ({
  revision: 3, totalTurns: 2, unsummarizedTurnIds: ["prior_a", "prior_b"],
  activeTurn: { turnId: "current_turn", throughMessageId: "msg_tool_current_71_0_long_runtime_boundary" },
});
const draft = () => ({ summaries: ["Prior A facts.", "Prior B facts."], active_summary: "Tool completed. Verify next; do not repeat it." });
const legacyDraft = () => ({
  session_revision: 3,
  summaries: [{ turn_id: "prior_a", summary: "Prior A facts." }, { turn_id: "prior_b", summary: "Prior B facts." }],
  active_turn: { turn_id: "current_turn", through_message_id: "msg_tool_current_71_0_long_runtime_boundary", summary: "Tool completed." },
});

test("binds summary text to runtime-owned revision, Turn order and active boundary", () => {
  const state = authorization(), input = draft();
  const before = structuredClone({ state, input });
  const bound = bindContextCheckpointInput(input, state);
  assert.deepEqual(bound, {
    sessionRevision: 3,
    summaries: [{ turnId: "prior_a", summary: input.summaries[0] }, { turnId: "prior_b", summary: input.summaries[1] }],
    activeTurn: { ...state.activeTurn, summary: input.active_summary },
  });
  assert.deepEqual({ state, input }, before, "binding cannot mutate source facts or its authorization");
  bound.activeTurn.summary = "changed result";
  assert.deepEqual(state, before.state);
});

test("supports preceding-only and active-only summaries without fabricated segments", () => {
  const preceding = { ...authorization(), activeTurn: undefined };
  assert.equal(bindContextCheckpointInput({ summaries: draft().summaries, active_summary: "" }, preceding).activeTurn, undefined);
  const active = { ...authorization(), unsummarizedTurnIds: [] };
  const bound = bindContextCheckpointInput({ summaries: [], active_summary: "Keep the cumulative verified state." }, active);
  assert.deepEqual(bound.summaries, []);
  assert.equal(bound.activeTurn.throughMessageId, active.activeTurn.throughMessageId);
  assert.throws(() => bindContextCheckpointInput(draft(), preceding), { field: "active_summary" });
});

test("rejects missing, wrong-type, oversized and miscounted summaries with exact field diagnostics", () => {
  const cases = [
    [null, "input"], [[], "input"],
    [{ ...draft(), summaries: [] }, "summaries"],
    [{ ...draft(), summaries: ["one"] }, "summaries"],
    [{ ...draft(), summaries: [...draft().summaries, "extra"] }, "summaries"],
    [{ ...draft(), summaries: ["valid", { summary: "not a string" }] }, "summaries[1]"],
    [{ ...draft(), summaries: ["valid", " "] }, "summaries[1]"],
    [{ ...draft(), active_summary: undefined }, "active_summary"],
    [{ ...draft(), active_summary: null }, "active_summary"],
    [{ ...draft(), active_summary: [] }, "active_summary"],
    [{ ...draft(), active_summary: { summary: "do not stringify objects" } }, "active_summary"],
    [{ ...draft(), active_summary: "x".repeat(6001) }, "active_summary"],
    [{ ...draft(), session_revision: 99 }, "input"],
    [{ ...draft(), active_turn: legacyDraft().active_turn }, "input"],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => bindContextCheckpointInput(input, authorization()), error =>
      error instanceof ContextCheckpointInputError && error.field === field && error.message.includes(field));
  }
});

test("old saved catalogs remain compatible but stale identity claims are never overwritten", () => {
  assert.equal(bindContextCheckpointInput(legacyDraft(), authorization()).sessionRevision, 3);
  const cases = [
    [{ ...legacyDraft(), session_revision: 2 }, "session_revision"],
    [{ ...legacyDraft(), summaries: legacyDraft().summaries.toReversed() }, "summaries[0].turn_id"],
    [{ ...legacyDraft(), active_turn: null }, "active_turn"],
    [{ ...legacyDraft(), active_turn: undefined }, "active_turn"],
    [{ ...legacyDraft(), active_turn: { ...legacyDraft().active_turn, turn_id: "other_turn" } }, "active_turn.turn_id"],
    [{ ...legacyDraft(), active_turn: { ...legacyDraft().active_turn, through_message_id: "stale" } }, "active_turn.through_message_id"],
    [{ ...legacyDraft(), active_turn: { ...legacyDraft().active_turn, summary: { text: "wrong shape" } } }, "active_turn.summary"],
  ];
  for (const [input, field] of cases) {
    assert.throws(() => bindContextCheckpointInput(input, authorization()), { field });
  }
});

test("checkpoint catalog stays static while notices bind different runtime states", () => {
  const registry = new ToolRegistry();
  registerContextCompactionTool(registry, () => { throw new Error("catalog inspection cannot execute"); });
  const before = registry.definitions();
  const schema = before[0].inputSchema;
  assert.deepEqual(Object.keys(schema.properties), ["summaries", "active_summary"]);
  assert.equal(schema.properties.summaries.items.type, "string");
  assert.equal(schema.properties.active_summary.type, "string");
  const notice = contextPressureNotice(authorization(), pressure());
  assert.match(notice.content, /exactly 2 plain summary strings/);
  assert.match(notice.content, /Runtime binds them/);
  assert.match(contextPressureNotice({ revision: 4, unsummarizedTurnIds: [], totalTurns: 2 }, pressure()).content, /active_summary to an empty string/);
  const legacy = contextPressureNotice(authorization(), pressure(), true);
  assert.match(legacy.content, /provide active_turn/);
  assert.doesNotMatch(legacy.content, /active_summary/);
  assert.deepEqual(registry.definitions(), before, "no dynamic IDs or schema changes in the cache prefix");
});

test("diagnostics persist field/type/count and a fingerprint, never duplicate raw summary text", () => {
  const input = { ...draft(), active_summary: { sensitive: "PRIVATE_SUMMARY_CONTENT" } };
  const args = JSON.stringify(input);
  let failure;
  try { bindContextCheckpointInput(input, authorization()); }
  catch (error) { failure = contextCheckpointFailure(error, args); }
  assert.equal(failure.diagnostics.field, "active_summary");
  assert.equal(failure.diagnostics.received, "object");
  assert.equal(failure.diagnostics.argumentsChars, args.length);
  assert.equal(failure.diagnostics.argumentsSha256, createHash("sha256").update(args).digest("hex"));
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_SUMMARY_CONTENT|Prior A facts/);
  const malformed = '{"active_summary":"PRIVATE_SUMMARY_CONTENT';
  try { JSON.parse(malformed); } catch (error) {
    const invalid = contextCheckpointFailure(error, malformed);
    assert.equal(invalid.diagnostics.code, "checkpoint_json_invalid");
    assert.doesNotMatch(JSON.stringify(invalid), /PRIVATE_SUMMARY_CONTENT/);
  }
});
