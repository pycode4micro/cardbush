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
    planEnabled: true,
  });
  assert.equal(request.prefixMessages[0].role, "system");
  assert.equal(request.prefixMessages.length, 1);
  assert.equal(request.inputMessages[0].message.name, "runtime_context");
  assert.match(request.inputMessages[0].message.content, /Local date: 2026-08-29/);
  assert.deepEqual(request.metadata.mcpContext.filesystemRoots, ["C:\\workspace"]);
  assert.equal(request.inputMessages[1].message.content, "完成任务");

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
  assert.deepEqual(nextRequest.prefixMessages, request.prefixMessages);
  assert.match(nextRequest.inputMessages[0].message.content, /Local date: 2026-08-30/);
});
