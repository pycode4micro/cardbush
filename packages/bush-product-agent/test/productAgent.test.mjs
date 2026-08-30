import assert from "node:assert/strict";
import test from "node:test";

import { createProductAgentTurnRequest } from "../dist/index.js";

test("builds the same explicit product Turn for desktop and transport callers", () => {
  const request = createProductAgentTurnRequest({
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    messageId: "message_1",
    createdAt: "2026-08-29T00:00:00Z",
    localDate: "2026-08-29",
    userText: "完成任务",
    model: "fixture",
    tools: [],
    projectDir: "C:\\workspace",
    permissionMode: "task_free",
    subagentPermissionRouting: "user",
    childAgentPolicy: {
      permissionRouting: "user",
      childPermissionMode: "task_free",
      model: { mode: "inherit" },
      disabledTools: ["subagent"],
    },
    planEnabled: true,
  });
  assert.equal(request.prefixMessages[0].role, "system");
  assert.match(request.prefixMessages[0].content, /subagent dispatch is asynchronous/);
  assert.match(request.prefixMessages[0].content, /call await_subagents once; do not poll/);
  assert.equal(request.prefixMessages.length, 2);
  assert.equal(request.prefixMessages[1].name, "runtime_context");
  assert.match(
    request.prefixMessages[1].content,
    /Local date: 2026-08-29\n<\/runtime_context>$/,
  );
  assert.deepEqual(request.metadata.mcpContext.filesystemRoots, ["C:\\workspace"]);
  assert.equal(request.inputMessages[0].message.content, "完成任务");
  assert.equal(request.metadata.subagentPermissionRouting, "user");
  assert.deepEqual(request.metadata.childAgentPolicy.disabledTools, ["subagent"]);

  const nextRequest = createProductAgentTurnRequest({
    requestId: "request_2",
    sessionId: "session_1",
    turnId: "turn_2",
    messageId: "message_2",
    createdAt: "2026-08-30T00:00:00Z",
    localDate: "2026-08-30",
    userText: "继续任务",
    model: "fixture",
    tools: [],
    projectDir: "D:\\next-workspace",
    permissionMode: "task_free",
    planEnabled: true,
  });
  assert.equal(nextRequest.prefixMessages[0].content, request.prefixMessages[0].content);
  assert.equal(nextRequest.metadata.subagentPermissionRouting, "user");
  assert.match(
    nextRequest.prefixMessages[1].content,
    /Local date: 2026-08-30\n<\/runtime_context>$/,
  );
  assert.equal(nextRequest.inputMessages[0].message.content, "继续任务");
});

test("keeps the stable system prefix ahead of the final runtime date field", () => {
  const create = (createdAt, turnId) => createProductAgentTurnRequest({
    requestId: `request_${turnId}`,
    sessionId: "session_cache",
    turnId,
    messageId: `message_${turnId}`,
    createdAt,
    localDate: createdAt.slice(0, 10),
    userText: "继续处理",
    model: "fixture",
    tools: [],
    projectDir: "C:\\workspace",
    projectInstructions: "Follow the project conventions.",
    permissionMode: "task_free",
    planEnabled: true,
  });
  const first = create("2026-08-29T23:59:59Z", "turn_before_midnight");
  const second = create("2026-08-30T00:00:01Z", "turn_after_midnight");
  assert.equal(second.prefixMessages[0].content, first.prefixMessages[0].content);
  assert.notEqual(second.prefixMessages[1].content, first.prefixMessages[1].content);
});
