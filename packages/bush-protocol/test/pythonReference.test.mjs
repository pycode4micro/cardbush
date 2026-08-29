import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  executionFactSchema,
  taskPlanSchema,
} from "../dist/index.js";

const fixturePath = new URL(
  "../reference-fixtures/python-reference-2026-08-29.json",
  import.meta.url,
);

test("parses contracts exported by the frozen Python reference", async () => {
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.equal(fixture.reference_commit, "a1e2f2b4");
  assert.equal(executionFactSchema.parse(fixture.execution_fact).receipt_id, "receipt_1");
  assert.equal(taskPlanSchema.parse(fixture.task_plan).nodes.length, 2);
  assert.equal(fixture.outcome_finalizer.protocol, "bush.outcome_finalizer.v1");
});
