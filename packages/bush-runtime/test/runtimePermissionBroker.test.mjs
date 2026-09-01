import assert from "node:assert/strict";
import test from "node:test";

import { RuntimePermissionBroker } from "../dist/index.js";

test("coalesces simultaneous identical capability requests into one user decision", async () => {
  const requested = [];
  let permissionIndex = 0;
  const broker = new RuntimePermissionBroker({
    createPermissionId: () => `permission_${++permissionIndex}`,
    onRequested: (request) => requested.push(request),
  });
  const common = {
    reason: "read requires access outside the task roots.",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\workspace" }],
    capabilityIds: ["capability_read_workspace"],
  };
  const first = broker.request({ ...common, toolCallId: "call_1" });
  const second = broker.request({ ...common, toolCallId: "call_2" });

  assert.equal(requested.length, 1);
  assert.deepEqual(broker.pendingIds(), ["permission_1"]);
  broker.answer({
    protocol: "bush.runtime_permission_answer.v1",
    permissionId: "permission_1",
    answerId: "answer_1",
    decision: "allow_once",
    grantedCapabilityIds: ["capability_read_workspace"],
  });

  assert.equal((await first).answerId, "answer_1");
  assert.equal((await second).answerId, "answer_1");
  assert.deepEqual(broker.pendingIds(), []);
});

test("keeps distinct capabilities as distinct permission requests", () => {
  const requested = [];
  let permissionIndex = 0;
  const broker = new RuntimePermissionBroker({
    createPermissionId: () => `permission_${++permissionIndex}`,
    onRequested: (request) => requested.push(request),
  });
  void broker.request({
    reason: "read one",
    toolCallId: "call_1",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\one" }],
    capabilityIds: ["capability_one"],
  });
  void broker.request({
    reason: "read two",
    toolCallId: "call_2",
    actions: ["read"],
    targets: [{ kind: "filesystem_path", value: "C:\\two" }],
    capabilityIds: ["capability_two"],
  });
  assert.equal(requested.length, 2);
  assert.deepEqual(broker.pendingIds(), ["permission_1", "permission_2"]);
});
