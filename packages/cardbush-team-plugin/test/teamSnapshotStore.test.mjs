import assert from "node:assert/strict";
import test from "node:test";

import { TeamSnapshotStore } from "../dist/index.js";

test("applies product Team snapshots idempotently and rejects revision conflicts", () => {
  const store = new TeamSnapshotStore();
  const first = snapshot(1, "one");
  assert.equal(store.apply(first).memberCount, 1);
  assert.deepEqual(store.apply(first), store.result());
  assert.throws(() => store.apply(snapshot(1, "changed")), /different content/);
  assert.equal(store.apply(snapshot(2, "two")).revision, 2);
  assert.throws(() => store.apply(first), /move backwards/);
});

test("refuses Team configuration changes while a Runtime Turn is active", () => {
  const store = new TeamSnapshotStore({ canApply: () => false });
  assert.throws(() => store.apply(snapshot(1, "one")), /Turn is active/);
});

test("content receipts survive revision changes while preserving all effective constraints", () => {
  const store = new TeamSnapshotStore();
  const first = snapshot(1, "one");
  const result = store.apply(first);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(store.apply({ ...first, revision: 2 }).contentHash, result.contentHash);
  const changed = snapshot(3, "one");
  changed.teams[0].members[0].toolNames = ["read_file"];
  assert.notEqual(store.apply(changed).contentHash, result.contentHash);
  result.contentHash = "a".repeat(64);
  assert.notEqual(store.result().contentHash, result.contentHash, "returned receipts cannot mutate Runtime facts");
  assert.throws(() => store.apply({ ...first, revision: 3 }), /different content/);
});

function snapshot(revision, instructions) {
  return {
    protocol: "bush.team_snapshot.v1",
    snapshotId: "teams",
    revision,
    teams: [{
      teamId: "team",
      name: "Team",
      instructions,
      members: [{
        memberId: "member",
        name: "Member",
        role: "worker",
        instructions: "",
        toolNames: [],
        agentProfileId: "member",
        fallback: true,
        skills: [],
        hooks: [],
        guards: [],
        promptInstructions: "",
      }],
    }],
  };
}
