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

function snapshot(revision, instructions) {
  return {
    protocol: "bush.team_snapshot.v1",
    snapshotId: "teams",
    revision,
    teams: [{
      teamId: "team",
      name: "Team",
      instructions,
      conference: { enabled: false, instructions: "" },
      members: [{
        memberId: "member",
        name: "Member",
        role: "worker",
        instructions: "",
        toolNames: [],
      }],
    }],
  };
}
