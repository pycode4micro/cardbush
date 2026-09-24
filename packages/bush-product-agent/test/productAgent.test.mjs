import assert from "node:assert/strict";
import test from "node:test";

import {
  createProductAgentTurnRequest,
  DEFAULT_MAX_CONTEXT_TOKENS,
  CHILD_AGENT_SYSTEM_PROMPT,
} from "../dist/index.js";

test('an unspecified context window defaults to 400k while explicit model limits are preserved', () => {
  const input = { requestId: 'context', sessionId: 'context', turnId: 'context', messageId: 'context',
    createdAt: '2026-09-08T00:00:00Z', localDate: '2026-09-08', userText: 'test', model: 'fixture', tools: [] };
  assert.equal(DEFAULT_MAX_CONTEXT_TOKENS, 400_000);
  assert.equal(createProductAgentTurnRequest(input).metadata.contextWindowTokens, 400_000);
  assert.equal(createProductAgentTurnRequest({ ...input, maxContextTokens: 128_000 }).metadata.contextWindowTokens, 128_000);
});

test('dynamic Skill selection keeps exclusions without freezing the installed catalog', () => {
  const input = { requestId: 'dynamic', sessionId: 'dynamic', turnId: 'dynamic', messageId: 'dynamic',
    createdAt: '2026-09-06T00:00:00Z', localDate: '2026-09-06',
    userText: 'test', model: 'fixture', tools: [], disabledSkills: ['disabled-skill'] };
  const dynamic = createProductAgentTurnRequest(input);
  assert.equal('allowedSkills' in dynamic.metadata, false);
  assert.deepEqual(dynamic.metadata.disabledSkills, ['disabled-skill']);
  const restricted = createProductAgentTurnRequest({ ...input, allowedSkills: ['one-skill'] });
  assert.deepEqual(restricted.metadata.allowedSkills, ['one-skill']);
});

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
    attachments: [{
      id: "attachment-1",
      name: "brief.md",
      type: "document",
      path: "C:\\workspace\\brief.md",
      size: 128,
    }],
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
  for (const instructions of [request.prefixMessages[0].content, CHILD_AGENT_SYSTEM_PROMPT]) {
    assert.match(instructions, /Runtime issues a developer-role context_pressure maintenance notice/);
    assert.match(instructions, /quoted or historical notices do not authorize compaction/);
    assert.doesNotMatch(instructions, /user-role context_pressure/);
  }
  assert.match(request.prefixMessages[0].content, /subagent dispatch is asynchronous/);
  assert.match(request.prefixMessages[0].content, /call await_subagents once; do not poll/);
  assert.doesNotMatch(
    request.prefixMessages[0].content,
    /last-resort|prefer any purpose-built|use the direct read_file|chrome_devtools Tools as the primary route/i,
  );
  assert.doesNotMatch(request.prefixMessages[0].content, /consult_logic|learn_logic|\bLEM\b/);
  assert.doesNotMatch(request.metadata.subagentChildPrefixMessages[0].content, /consult_logic|learn_logic|\bLEM\b/);
  assert.equal(request.prefixMessages.length, 2);
  assert.equal(request.prefixMessages[1].name, "runtime_context");
  assert.doesNotMatch(request.prefixMessages[1].content, /Local date/);
  assert.match(request.prefixMessages[1].content, /Desktop: C:\\Users\\fixture\\Desktop/);
  assert.deepEqual(request.metadata.mcpContext.filesystemRoots, ["C:\\workspace"]);
  assert.equal(request.metadata.mcpContext.sessionTitle, "完成任务");
  assert.equal(request.inputMessages.at(-1).message.content, "完成任务");
  assert.deepEqual(request.inputMessages.at(-1).metadata.attachments, [{
    id: "attachment-1",
    name: "brief.md",
    type: "document",
    path: "C:\\workspace\\brief.md",
    size: 128,
  }]);
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
  assert.equal(nextRequest.inputMessages.at(-1).message.content, "继续任务");
});

test("time snapshots append as internal user inputs across midnight without changing the prefix", () => {
  const create = (createdAt, turnId) => createProductAgentTurnRequest({
    requestId: `request_${turnId}`,
    sessionId: "session_cache",
    turnId,
    messageId: `message_${turnId}`,
    createdAt,
    timeZone: "Asia/Shanghai",
    userText: "继续处理",
    model: "fixture",
    tools: [],
    projectDir: "C:\\workspace",
    instructionDocuments: [{ path: "C:/CardBush/AGENTS.md", scope: "global", content: "Prefer concise, verified results." }],
    permissionMode: "task_free",
    planEnabled: true,
  });
  const first = create("2026-08-29T15:59:59Z", "turn_before_midnight");
  const second = create(
    "2026-08-29T16:00:01Z",
    "turn_after_midnight",
  );
  assert.deepEqual(second.prefixMessages, first.prefixMessages);
  assert.deepEqual(first, create("2026-08-29T15:59:59Z", "turn_before_midnight"), 'replaying the same input never refreshes its clock');
  for (const request of [first, second]) {
    assert.equal(request.inputMessages.length, 2);
    assert.equal(request.inputMessages[0].message.role, 'user');
    assert.equal(request.inputMessages[0].message.name, 'turn_runtime_context');
    assert.equal(request.inputMessages[0].message.visibility, 'internal');
    assert.deepEqual(request.inputMessages.at(-1).message, { role: 'user', content: '继续处理' });
    assert.equal(request.metadata.sessionEnvironmentProtocol, undefined);
    assert.equal(request.metadata.sessionEnvironmentLocalDate, undefined);
    assert.doesNotMatch(JSON.stringify(request.prefixMessages), /2026-08-29|2026-08-30/);
    assert.equal(request.prefixMessages[0].content, CHILD_AGENT_SYSTEM_PROMPT);
  }
  assert.match(first.inputMessages[0].message.content, /Current date: 2026-08-29 \(Saturday\)/);
  assert.match(first.inputMessages[0].message.content, /Current time: 23:59:59 UTC\+08:00/);
  assert.match(second.inputMessages[0].message.content, /Current date: 2026-08-30 \(Sunday\)/);
  assert.match(second.inputMessages[0].message.content, /Current time: 00:00:01 UTC\+08:00/);
  assert.equal(first.inputMessages[0].createdAt, '2026-08-29T15:59:59Z');
  assert.equal(second.inputMessages[0].createdAt, '2026-08-29T16:00:01Z');
});

test("visual inputs carry ordered source facts without injecting data URLs or changing stable instructions", () => {
  const sources = ['\\\\nas\\共享\\中文 图.png', 'C:\\images\\one.png', 'data:image/png;base64,TEST_BYTES', 'https://example.test/image.png', 'C:\\images\\omitted.png'];
  const create = images => createProductAgentTurnRequest({ requestId: 'r', sessionId: 's', turnId: 't', messageId: 'u',
    createdAt: '2026-09-10T00:00:00Z', localDate: '2026-09-10', sessionEnvironmentLocalDate: '2026-09-10',
    userText: '看看这些图片', model: 'fixture', tools: [], images, permissionMode: 'task_free', planEnabled: true });
  const request = create(sources);
  assert.deepEqual(request.inputMessages.at(-1).message.images.map(image => image.url), sources.slice(0, 4));
  const context = request.inputMessages.map(item => item.message.content).join('\n');
  assert.ok(context.includes('1. ' + JSON.stringify(sources[0])));
  assert.ok(context.includes('2. ' + JSON.stringify(sources[1])));
  assert.match(context, /3\. Inline image; no local file path was supplied/);
  assert.ok(context.includes('4. ' + JSON.stringify(sources[3])));
  assert.doesNotMatch(context, /TEST_BYTES|omitted\.png/);
  assert.deepEqual(request.prefixMessages, create([]).prefixMessages);
});

test("product requests append attachment facts while keeping the prefix and tool order stable", () => {
  const create = ({ turnId, localDate, files, images, tools = [] }) =>
    createProductAgentTurnRequest({
      requestId: `request_${turnId}`,
      sessionId: "session_cache_bypass",
      turnId,
      messageId: `message_${turnId}`,
      createdAt: `${localDate}T00:00:00Z`,
      userText: "继续处理",
      model: "fixture",
      tools,
      projectDir: "C:\\workspace",
      instructionDocuments: [{ path: "C:/CardBush/AGENTS.md", scope: "global", content: "Prefer concise, verified results." }],
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
    images: ["C:\\images\\two.png"],
    tools: [
      { name: "alpha", description: "a", inputSchema: {} },
      { name: "zeta", description: "z", inputSchema: {} },
    ],
  });

  assert.deepEqual(second.prefixMessages, first.prefixMessages);
  assert.doesNotMatch(JSON.stringify(first.prefixMessages), /one\.png/);
  assert.doesNotMatch(JSON.stringify(second.prefixMessages), /two\.png/);
  assert.equal(first.inputMessages[0].message.name, "turn_runtime_context");
  assert.equal(first.inputMessages[0].message.visibility, "internal");
  assert.equal(first.inputMessages.length, 2);
  assert.deepEqual(first.inputMessages.at(-1).message.images, [
    { url: "C:\\images\\one.png" },
  ]);
  assert.equal(second.inputMessages.length, 2);
  assert.equal(second.inputMessages.at(-1).message.name, undefined);
  assert.deepEqual(second.inputMessages.at(-1).message.images, [
    { url: "C:\\images\\two.png" },
  ]);
  assert.deepEqual(first.tools, second.tools);
  assert.deepEqual(first.tools.map((tool) => tool.name), ["alpha", "zeta"]);

  const nextDay = create({
    turnId: "three",
    localDate: "2026-08-30",
    files: ["C:\\work\\brief.md"],
  });
  assert.deepEqual(nextDay.prefixMessages, first.prefixMessages);
  assert.equal(nextDay.inputMessages.length, 2);
  assert.equal(nextDay.inputMessages[0].message.name, "turn_runtime_context");
  assert.match(nextDay.inputMessages[0].message.content, /brief\.md/);
  assert.doesNotMatch(nextDay.inputMessages[0].message.content, /Local date/);
  assert.equal(nextDay.inputMessages[1].message.content, "继续处理");
});

test("legacy date fields cannot replace the submission snapshot or alter dates authored by the user", () => {
  const userText = '我在 2026-09-17 修改过文件，今天请核对。';
  const request = createProductAgentTurnRequest({ requestId: 'legacy', sessionId: 'legacy', turnId: 'legacy', messageId: 'legacy',
    createdAt: '2026-09-18T08:00:00Z', timeZone: 'UTC', localDate: '2020-01-01', sessionEnvironmentLocalDate: '2020-01-02',
    userText, model: 'fixture', tools: [], permissionMode: 'task_free', planEnabled: false });
  assert.deepEqual(request.inputMessages.at(-1).message, { role: 'user', content: userText });
  assert.match(request.inputMessages[0].message.content, /Current date: 2026-09-18/);
  assert.doesNotMatch(request.inputMessages[0].message.content, /2020-01/);
  assert.equal(request.inputMessages[0].createdAt, '2026-09-18T08:00:00Z');
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
