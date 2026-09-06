import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { decodeLogicLearnInput, LogicMemoryStore, registerExtendedBuiltins, ToolRegistry } from "../dist/index.js";

test("LEM learns, retrieves, and applies idempotent message feedback", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-lem-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new LogicMemoryStore(join(root, "logic.json"));

  const learned = await store.learn({
    scenario: "修改代码后准备宣布任务完成",
    bias: "只确认修改存在，没有运行验证",
    correction: "宣布完成前运行与风险相称的测试并核对结果",
    conditions: ["code_edit", "before_final"],
    evidence_state: "verified",
  });
  assert.equal(learned.status, "learned");
  assert.match(learned.logic_id, /^logic_/);

  const consulted = await store.consult({ query: "代码修改完成前应该如何验证" });
  assert.equal(consulted.status, "ok");
  assert.equal(consulted.matched_logic[0].logic_id, learned.logic_id);

  const sourceId = "assistant:session:turn:message";
  await store.recordFeedbackForLogicIds([learned.logic_id], "up", { sourceId });
  await store.recordFeedbackForLogicIds([learned.logic_id], "up", { sourceId });
  let record = JSON.parse(await readFile(store.path, "utf8"))[0];
  assert.equal(record.positive_feedback_count, 1);
  assert.equal(record.negative_feedback_count, 0);
  assert.equal(record.reward_score, 1);

  await store.recordFeedbackForLogicIds([learned.logic_id], "down", { sourceId });
  record = JSON.parse(await readFile(store.path, "utf8"))[0];
  assert.equal(record.positive_feedback_count, 0);
  assert.equal(record.negative_feedback_count, 1);
  assert.equal(record.reward_score, -1);
  assert.ok(record.suppression_score > 0);

  await store.recordFeedbackForLogicIds([learned.logic_id], null, { sourceId });
  record = JSON.parse(await readFile(store.path, "utf8"))[0];
  assert.equal(record.positive_feedback_count, 0);
  assert.equal(record.negative_feedback_count, 0);
  assert.equal(record.reward_score, 0);
});

test("LEM feedback reports missing records without inventing memory", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-lem-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const store = new LogicMemoryStore(join(root, "logic.json"));
  const result = await store.recordFeedbackForLogicIds(["logic_missing"], "down", {
    sourceId: "assistant:missing",
  });
  assert.deepEqual(result.updatedLogicIds, []);
  assert.deepEqual(result.missingLogicIds, ["logic_missing"]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cardbush-lem-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new LogicMemoryStore(join(root, "logic.json"));
}

const lesson = {
  scenario: "Verify file encoding before decoding text", bias: "Assumed UTF-8 without checking bytes",
  correction: "Check encoding evidence before decoding", conditions: ["text_preview", "file_read"],
  evidence: "A UTF-16 fixture decoded correctly after checking its BOM", outcome: "Fixture matched expected text",
  evidence_state: "verified", confidence: 0.8,
};

test("first learning starts at one; repeated/reordered submissions preserve ID, evidence and confidence", async t => {
  const store = await fixture(t);
  const first = await store.learn(lesson);
  assert.equal(first.reinforcement_count, 1);
  const repeat = await store.learn({ ...lesson, conditions: [...lesson.conditions].reverse(), confidence: 0.98 });
  assert.equal(repeat.logic_id, first.logic_id);
  assert.equal(repeat.reinforcement_count, 1);
  assert.equal(repeat.confidence, first.confidence);
  await store.learn({ scenario: lesson.scenario, bias: lesson.bias, correction: lesson.correction, conditions: lesson.conditions });
  const records = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(records[0].evidence, lesson.evidence);
  assert.equal(records[0].outcome, lesson.outcome);
  assert.equal(records[0].evidence_state, "verified");
  assert.equal(records[0].learning_count, 1);
});

test("recognizes reordered legacy identities without rewriting the ID or inventing historical counts", async t => {
  const store = await fixture(t);
  await writeFile(store.path, JSON.stringify([{ ...lesson, logic_id: "legacy_id", schema_version: 2,
    base_confidence: 0.8, learning_count: 2, feedback_events: [] }]));
  const r = await store.learn({ ...lesson, conditions: [...lesson.conditions].reverse() });
  assert.equal(r.logic_id, "legacy_id");
  assert.equal(r.reinforcement_count, 2);
  assert.equal(JSON.parse(await readFile(store.path, "utf8")).length, 1);
});

test("new evidence may update a lesson, without an automatic confidence bonus", async t => {
  const store = await fixture(t);
  await store.learn(lesson);
  const updated = await store.learn({ ...lesson, evidence: "Independent UTF-16 big-endian fixture also passed" });
  assert.equal(updated.confidence, lesson.confidence);
  assert.equal(updated.reinforcement_count, 2);
});

test("returns evidence once, without echoed inputs or categorical relevance claims", async t => {
  const store = await fixture(t);
  await store.learn(lesson);
  const before = await readFile(store.path, "utf8");
  const r = await store.consult({ query: "file encoding decoding" });
  assert.equal(r.retrieval_method, "bm25");
  assert.equal(r.matched_count, 1);
  for (const name of ["query", "scenario_conditions", "cognitive_patterns", "reflection_questions", "bias_warnings", "match_quality"]) {
    assert.equal(name in r, false, name);
  }
  assert.equal(r.matched_logic[0].evidence, lesson.evidence);
  assert.equal(r.matched_logic[0].outcome, lesson.outcome);
  assert.equal(r.matched_logic[0].evidence_state, "verified");
  assert.equal(await readFile(store.path, "utf8"), before);
});

test("inventory pages independently of search and does not expose retrieved/adopted IDs", async t => {
  const store = await fixture(t);
  assert.equal((await store.consult({ mode: "list" })).status, "empty");
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await store.learn({ ...lesson, scenario: `${lesson.scenario} (${i})` })).logic_id);
  const before = await readFile(store.path, "utf8");
  const collected = [];
  let offset = 0;
  do {
    const page = await store.consult({ mode: "list", offset, max_results: 2 });
    assert.equal(page.mode, "inventory");
    assert.equal(page.total_count, 5);
    assert.equal("matched_logic" in page, false);
    collected.push(...page.records.map(r => r.logic_id));
    offset = page.next_offset;
  } while (offset !== null);
  assert.deepEqual(collected, ids);
  assert.deepEqual((await store.consult({ mode: "list", offset: 100 })).records, []);
  assert.equal((await store.consult({ query: "file encoding" })).matched_count, 3);
  await store.recordFeedbackForLogicIds([], "up", { sourceId: "unrelated_turn", scope: "turn" });
  assert.equal(await readFile(store.path, "utf8"), before);
});

test("Turn feedback is idempotent, reversible and cannot evict or reinforce explicit lesson feedback", async t => {
  const store = await fixture(t);
  const r = await store.learn(lesson);
  await store.recordFeedbackForLogicIds([r.logic_id], "up", { sourceId: "direct", source: "explicit_evaluation" });
  const baseline = JSON.parse(await readFile(store.path, "utf8"))[0];
  for (let i = 0; i < 45; i++) {
    await store.recordFeedbackForLogicIds([r.logic_id], "down", { sourceId: `turn_${i}`, source: "user_thumb", scope: "turn" });
  }
  await store.recordFeedbackForLogicIds([r.logic_id], "down", { sourceId: "turn_44", source: "user_thumb", scope: "turn" });
  let current = JSON.parse(await readFile(store.path, "utf8"))[0];
  assert.equal(current.confidence, baseline.confidence);
  assert.equal(current.reward_score, 1);
  assert.equal(current.positive_feedback_count, 1);
  assert.equal(current.negative_feedback_count, 0);
  assert.equal(current.turn_negative_feedback_count, 40);
  await store.recordFeedbackForLogicIds([r.logic_id], null, { sourceId: "turn_44", source: "user_thumb", scope: "turn" });
  current = JSON.parse(await readFile(store.path, "utf8"))[0];
  assert.equal(current.turn_negative_feedback_count, 39);
  assert.equal(current.reward_score, 1);
});

test("legacy answer thumbs remain facts but are not represented as evidence for a lesson", async t => {
  const store = await fixture(t);
  await writeFile(store.path, JSON.stringify([{ ...lesson, logic_id: "legacy", base_confidence: 0.8,
    confidence: 0.88, reward_score: 1, learning_count: 1,
    feedback_events: [{ source_id: "assistant:old", source: "user_thumb", rating: "up", reward: 1 }] }]));
  const before = await readFile(store.path, "utf8");
  const record = (await store.consult({ query: "file encoding" })).matched_logic[0];
  assert.equal(record.confidence, 0.8);
  assert.equal(record.reward_score, 0);
  assert.equal(await readFile(store.path, "utf8"), before);
});

test("learn/feedback parameter branches agree with runtime dispatch, including legacy implicit feedback", async t => {
  const store = await fixture(t);
  const learned = await store.learn(lesson);
  for (const input of [
    { action: "feedback", logic_id: learned.logic_id, feedback: "helpful" },
    { logic_id: learned.logic_id, reward: -1 },
    { logic_id: learned.logic_id, rating: 5 },
  ]) {
    assert.equal(decodeLogicLearnInput(input).action, "feedback");
    assert.equal((await store.learn({ ...input, source_id: "stable_feedback" })).status, "feedback_recorded");
  }
  for (const input of [
    { scenario: "scenario only" }, { scenario: " ", correction: "x" },
    { action: "learn", logic_id: learned.logic_id, scenario: "x", correction: "y" },
    { action: "feedback", scenario: "mixed", logic_id: learned.logic_id, feedback: "helpful" },
    { action: "feedback", logic_id: learned.logic_id },
    { logic_id: learned.logic_id, reward: 0 }, { logic_id: learned.logic_id, reward: 2 },
    { logic_id: learned.logic_id, feedback: "unknown" },
  ]) assert.throws(() => decodeLogicLearnInput(input));
});

test("Tool feedback defaults to a stable Turn source and tool definitions stay independent of inventory", async t => {
  const store = await fixture(t);
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { logicMemory: store });
  const definitions = JSON.stringify(registry.definitions());
  const learned = await store.learn(lesson);
  const tool = registry.resolve("learn_logic");
  const input = tool.decodeInput({ logic_id: learned.logic_id, feedback: "helpful" });
  for (let i = 0; i < 2; i++) await tool.execute({ input, sessionId: "session", turnId: "turn",
    toolCall: { id: `call_${i}`, name: "learn_logic" } });
  assert.equal(JSON.parse(await readFile(store.path, "utf8"))[0].positive_feedback_count, 1);
  assert.equal(JSON.stringify(registry.definitions()), definitions);
  const listTool = registry.resolve("consult_logic");
  assert.doesNotThrow(() => listTool.decodeInput({ mode: "list" }));
  assert.throws(() => listTool.decodeInput({ query: "" }));
  assert.throws(() => listTool.decodeInput({ mode: "unsupported" }));
});

test("invalid store roots fail closed without overwriting existing data", async t => {
  const store = await fixture(t);
  for (const invalid of ['{"unexpected":"root"}', '[null,12]']) {
    await writeFile(store.path, invalid);
    await assert.rejects(store.learn(lesson), /Invalid LEM store/);
    assert.equal(await readFile(store.path, "utf8"), invalid);
  }
});

test("concurrent duplicate learning stays one record without reinforcing the same evidence", async t => {
  const store = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => store.learn({
    ...lesson, conditions: index % 2 ? [...lesson.conditions].reverse() : lesson.conditions,
  })));
  assert.equal(new Set(results.map(r => r.logic_id)).size, 1);
  const records = JSON.parse(await readFile(store.path, "utf8"));
  assert.equal(records.length, 1);
  assert.equal(records[0].learning_count, 1);
  assert.equal(records[0].confidence, lesson.confidence);
});
