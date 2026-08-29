import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CoordinationJournalCorruptionError,
  CoordinationStore,
  FileCoordinationPersistence,
} from "../dist/index.js";

const NOW = "2026-08-29T00:00:00.000Z";

test("assigns stable Plan node ids and requires explicit scope change for removal", () => {
  let node = 0;
  const store = new CoordinationStore({
    now: () => NOW,
    createNodeId: () => `node_${++node}`,
  });
  const first = store.setPlan({
    sessionId: "session_1",
    expectedRevision: 0,
    plan: plan([
      { step: "read", status: "in_progress" },
      { step: "write", status: "pending" },
    ]),
  });
  assert.deepEqual(first.plan.nodes.map((item) => item.id), ["node_1", "node_2"]);

  assert.throws(
    () => store.setPlan({
      sessionId: "session_1",
      expectedRevision: 1,
      plan: plan([{ id: "node_1", step: "read", status: "completed" }], false),
    }),
    /scopeChangeReason/,
  );
  const second = store.setPlan({
    sessionId: "session_1",
    expectedRevision: 1,
    plan: plan([{ id: "node_1", step: "read", status: "completed" }], false),
    scopeChangeReason: "The requested write was explicitly removed from scope.",
  });
  assert.equal(second.revision, 2);
  assert.equal(second.plan.nodes[0].id, "node_1");
});

test("rejects stale revisions and mismatched Plan identities", () => {
  const store = new CoordinationStore({ now: () => NOW });
  store.setPlan({ sessionId: "session_1", expectedRevision: 0, plan: plan([]) });
  assert.throws(
    () => store.setPlan({ sessionId: "session_1", expectedRevision: 0, plan: plan([]) }),
    /revision conflict/,
  );
  assert.throws(
    () => store.setPlan({
      sessionId: "session_1",
      expectedRevision: 1,
      plan: { ...plan([]), session_id: "other" },
    }),
    /identity mismatch/,
  );
});

test("persists explicit Goal facts without interpreting their reason text", () => {
  const store = new CoordinationStore({ now: () => NOW });
  const created = store.createGoal({
    goalId: "goal_1",
    sessionId: "session_1",
    objective: "finish the requested work",
    linkedA2ATaskIds: [],
  });
  const updated = store.updateGoal({
    goalId: "goal_1",
    sessionId: "session_1",
    expectedRevision: created.revision,
    status: "blocked",
    statusReason: "arbitrary model-declared reason; Runtime does not classify it",
    consumedTokens: 12,
    linkedA2ATaskIds: ["a2a_1"],
  });
  assert.equal(updated.status, "blocked");
  assert.equal(updated.completedAt, NOW);
  assert.equal(store.getGoal("session_1")?.revision, 2);
  assert.throws(
    () => store.updateGoal({
      goalId: "goal_1",
      sessionId: "session_1",
      expectedRevision: 1,
      status: "active",
      statusReason: "",
      consumedTokens: 12,
      linkedA2ATaskIds: [],
    }),
    /revision conflict/,
  );
});

test("recovers Coordination facts and only truncates an incomplete final record", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileCoordinationPersistence({ root });
  deterministicStore(persistence).createGoal({
    goalId: "goal_1",
    sessionId: "session_1",
    objective: "objective",
    linkedA2ATaskIds: [],
  });
  persistence.close();
  appendFileSync(journalPath(root), '{"protocol":"broken');
  const issues = [];
  const reopened = new FileCoordinationPersistence({
    root,
    onTruncatedTail: (issue) => issues.push(issue),
  });
  assert.equal(new CoordinationStore({ persistence: reopened }).getGoal("session_1")?.goalId, "goal_1");
  assert.ok(issues[0].removedBytes > 0);
  reopened.close();
});

test("fails closed when a complete Coordination record is mutated", (t) => {
  const root = temporaryRoot(t);
  const persistence = new FileCoordinationPersistence({ root });
  deterministicStore(persistence).createGoal({
    goalId: "goal_1",
    sessionId: "session_1",
    objective: "objective",
    linkedA2ATaskIds: [],
  });
  persistence.close();
  const path = journalPath(root);
  writeFileSync(path, readFileSync(path, "utf8").replace("objective", "tampered"));
  const reopened = new FileCoordinationPersistence({ root });
  assert.throws(
    () => new CoordinationStore({ persistence: reopened }).getGoal("session_1"),
    CoordinationJournalCorruptionError,
  );
  reopened.close();
});

function deterministicStore(persistence) {
  let event = 0;
  return new CoordinationStore({
    persistence,
    createEventId: () => `event_${++event}`,
    createNodeId: () => "node_1",
    now: () => NOW,
  });
}

function plan(nodes, active = true) {
  const resolved = nodes.length > 0
    ? nodes
    : [{ id: "node_1", step: "inspect", status: "in_progress" }];
  return {
    protocol: "bush.task_plan.v1",
    plan_id: "plan_1",
    session_id: "session_1",
    nodes: resolved,
    explanation: "",
    active,
  };
}

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "cardbush-coordination-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function journalPath(root) {
  const files = readdirSync(root);
  assert.equal(files.length, 1);
  return join(root, files[0]);
}
