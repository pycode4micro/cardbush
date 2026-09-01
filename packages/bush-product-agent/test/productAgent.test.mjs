import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductAgentTurnRequest,
  latestSessionEnvironmentLocalDate,
} from "../dist/index.js";

test("builds one stable explicit product Turn for desktop and transport callers", () => {
  const request = createProductAgentTurnRequest({
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    messageId: "message_1",
    createdAt: "2026-08-29T00:00:00Z",
    localDate: "2026-08-29",
    sessionEnvironmentLocalDate: "2026-08-29",
    userText: "完成任务",
    model: "fixture",
    tools: [],
    projectDir: "C:\\workspace",
    filesystemLocations: [
      { id: "home", name: "Home", path: "C:\\Users\\fixture" },
      { id: "desktop", name: "Desktop", path: "C:\\Users\\fixture\\Desktop" },
    ],
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
  assert.doesNotMatch(
    request.prefixMessages[0].content,
    /last-resort|prefer any purpose-built|use the direct read_file|chrome_devtools Tools as the primary route/i,
  );
  assert.match(request.prefixMessages[0].content, /LEM is advisory reasoning memory/);
  assert.match(request.prefixMessages[0].content, /User thumbs are recorded by Runtime/);
  assert.equal(request.prefixMessages.length, 2);
  assert.equal(request.prefixMessages[1].name, "runtime_context");
  assert.doesNotMatch(request.prefixMessages[1].content, /Local date/);
  assert.match(request.prefixMessages[1].content, /Desktop: C:\\Users\\fixture\\Desktop/);
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
    sessionEnvironmentLocalDate: "2026-08-30",
    userText: "继续任务",
    model: "fixture",
    tools: [],
    projectDir: "D:\\next-workspace",
    permissionMode: "task_free",
    planEnabled: true,
  });
  assert.equal(nextRequest.prefixMessages[0].content, request.prefixMessages[0].content);
  assert.equal(nextRequest.metadata.subagentPermissionRouting, "user");
  assert.match(nextRequest.prefixMessages[1].content, /Workspace: D:\\next-workspace/);
  assert.equal(nextRequest.inputMessages[0].message.content, "继续任务");
});

test("keeps the stable prefix across a date epoch transition", () => {
  const create = (createdAt, turnId, previousLocalDate) => createProductAgentTurnRequest({
    requestId: `request_${turnId}`,
    sessionId: "session_cache",
    turnId,
    messageId: `message_${turnId}`,
    createdAt,
    localDate: createdAt.slice(0, 10),
    sessionEnvironmentLocalDate: previousLocalDate,
    userText: "继续处理",
    model: "fixture",
    tools: [],
    projectDir: "C:\\workspace",
    projectInstructions: "Follow the project conventions.",
    permissionMode: "task_free",
    planEnabled: true,
  });
  const first = create("2026-08-29T23:59:59Z", "turn_before_midnight");
  const second = create(
    "2026-08-30T00:00:01Z",
    "turn_after_midnight",
    "2026-08-29",
  );
  assert.deepEqual(second.prefixMessages, first.prefixMessages);
  assert.equal(first.inputMessages[0].message.name, "session_environment");
  assert.equal(second.inputMessages[0].message.name, "session_environment_update");
});

test("product requests record date epochs once and omit empty dynamic context", () => {
  const create = ({ turnId, localDate, previousLocalDate, files, images, tools = [] }) =>
    createProductAgentTurnRequest({
      requestId: `request_${turnId}`,
      sessionId: "session_cache_bypass",
      turnId,
      messageId: `message_${turnId}`,
      createdAt: `${localDate}T00:00:00Z`,
      localDate,
      sessionEnvironmentLocalDate: previousLocalDate,
      userText: "继续处理",
      model: "fixture",
      tools,
      projectDir: "C:\\workspace",
      projectInstructions: "Follow the project conventions.",
      images,
      files,
      filesystemLocations: [
        { id: "desktop", name: "Desktop", path: "C:\\Users\\fixture\\Desktop" },
      ],
      permissionMode: "task_free",
      planEnabled: true,
    });
  const first = create({
    turnId: "one",
    localDate: "2026-08-29",
    images: ["C:\\images\\one.png"],
    tools: [
      { name: "zeta", description: "z", inputSchema: {} },
      { name: "alpha", description: "a", inputSchema: {} },
    ],
  });
  const second = create({
    turnId: "two",
    localDate: "2026-08-29",
    previousLocalDate: "2026-08-29",
    images: ["C:\\images\\two.png"],
    tools: [
      { name: "alpha", description: "a", inputSchema: {} },
      { name: "zeta", description: "z", inputSchema: {} },
    ],
  });

  assert.deepEqual(second.prefixMessages, first.prefixMessages);
  assert.doesNotMatch(JSON.stringify(first.prefixMessages), /one\.png/);
  assert.doesNotMatch(JSON.stringify(second.prefixMessages), /two\.png/);
  assert.equal(first.inputMessages[0].message.name, "session_environment");
  assert.equal(first.inputMessages[0].message.visibility, "internal");
  assert.deepEqual(JSON.parse(first.inputMessages[0].message.content), {
    protocol: "bush.session_environment.v1",
    kind: "snapshot",
    localDate: "2026-08-29",
    effectiveAt: "2026-08-29T00:00:00Z",
  });
  assert.deepEqual(first.inputMessages[1].message.images, [
    { url: "C:\\images\\one.png" },
  ]);
  assert.equal(second.inputMessages.length, 1);
  assert.equal(second.inputMessages[0].message.name, undefined);
  assert.deepEqual(second.inputMessages[0].message.images, [
    { url: "C:\\images\\two.png" },
  ]);
  assert.equal(first.metadata.sessionEnvironmentLocalDate, "2026-08-29");
  assert.deepEqual(first.tools, second.tools);
  assert.deepEqual(first.tools.map((tool) => tool.name), ["alpha", "zeta"]);

  const nextDay = create({
    turnId: "three",
    localDate: "2026-08-30",
    previousLocalDate: "2026-08-29",
    files: ["C:\\work\\brief.md"],
  });
  assert.equal(nextDay.inputMessages[0].message.name, "session_environment_update");
  assert.deepEqual(JSON.parse(nextDay.inputMessages[0].message.content), {
    protocol: "bush.session_environment.v1",
    kind: "update",
    localDate: "2026-08-30",
    effectiveAt: "2026-08-30T00:00:00Z",
  });
  assert.equal(nextDay.inputMessages[1].message.name, "turn_runtime_context");
  assert.match(nextDay.inputMessages[1].message.content, /brief\.md/);
  assert.doesNotMatch(nextDay.inputMessages[1].message.content, /Local date/);
  assert.equal(nextDay.inputMessages[2].message.content, "继续处理");
});

test("restores only the latest valid structured session environment epoch", () => {
  const environment = (name, content) => ({
    message: {
      role: "user",
      visibility: "internal",
      name,
      content,
    },
  });
  const valid = JSON.stringify({
    protocol: "bush.session_environment.v1",
    kind: "snapshot",
    localDate: "2026-09-01",
    effectiveAt: "2026-09-01T00:00:00Z",
  });
  assert.equal(latestSessionEnvironmentLocalDate({
    turns: [{ messages: [
      environment("session_environment", valid),
      environment("session_environment_update", "not-json"),
    ] }],
  }), "2026-09-01");
  assert.equal(latestSessionEnvironmentLocalDate({
    turns: [{ messages: [{
      message: {
        role: "user",
        visibility: "visible",
        name: "session_environment",
        content: valid,
      },
    }] }],
  }), undefined);
});

test("keeps a projectless task workspace as an execution root, not a project identity", () => {
  const taskWorkspace = "C:\\Users\\fixture\\AppData\\Local\\CardBush\\task-workspaces\\stable";
  const request = createProductAgentTurnRequest({
    requestId: "request_task",
    sessionId: "session_task",
    turnId: "turn_task",
    messageId: "message_task",
    createdAt: "2026-09-01T00:00:00Z",
    localDate: "2026-09-01",
    userText: "检查临时工作区",
    model: "fixture",
    tools: [],
    workspaceDir: taskWorkspace,
    permissionMode: "task_free",
    planEnabled: false,
  });

  assert.equal(request.sessionMetadata.workspace_mode, "task");
  assert.equal(request.sessionMetadata.task_dir, taskWorkspace);
  assert.equal(request.sessionMetadata.session_workspace_dir, taskWorkspace);
  assert.equal(request.sessionMetadata.projectDir, undefined);
  assert.equal(request.metadata.projectDir, undefined);
  assert.equal(request.metadata.workspaceDir, taskWorkspace);
  assert.equal(request.metadata.sessionWorkspaceDir, taskWorkspace);
  assert.deepEqual(request.metadata.taskRoots, [taskWorkspace]);
  assert.deepEqual(request.metadata.mcpContext.filesystemRoots, [taskWorkspace]);
});
