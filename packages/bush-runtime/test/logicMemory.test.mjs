import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { LogicMemoryStore } from "../dist/index.js";

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
