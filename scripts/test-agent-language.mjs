import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProductAgentTurnRequest,
  GOAL_CONTINUATION_PROMPT,
} from '../packages/bush-product-agent/dist/index.js';
import {
  assembleContext,
  buildChildTurnRequest,
  inheritedChildMessages,
  projectActiveTurnContext,
  ToolRegistry,
} from '../packages/bush-runtime/dist/index.js';

const emptySession = {
  protocol: 'bush.session_snapshot.v1', sessionId: 'language', revision: 0,
  turns: [], supersededMessageIds: [], metadata: {},
};
function request(overrides = {}) {
  return createProductAgentTurnRequest({
    requestId: 'request', sessionId: 'language', turnId: 'turn', messageId: 'human',
    createdAt: '2026-09-08T00:00:00Z',
    userText: '帮我安装blender的官方mcp，并且下载一点素材下来',
    uiLanguage: 'zh', model: 'fixture', tools: [], permissionMode: 'task_free',
    planEnabled: false, ...overrides,
  });
}
function assertOneCommunicationPolicy(messages) {
  const marker = "Use the human user's explicit language preference";
  assert.equal(messages.filter(m => m.content.includes(marker)).length, 1);
  const policy = messages.find(m => m.content.includes(marker)).content;
  assert.match(policy, /all user-facing text/);
  assert.match(policy, /explicit language preference, otherwise the latest substantive human request/);
  assert.match(policy, /artifact's requested language independently/);
  assert.match(policy, /children, checkpoints and summaries/);
}

test('first model context has one communication policy; locale changes do not churn the stable prefix', () => {
  const zh = request();
  const en = request({ uiLanguage: 'en' });
  assert.deepEqual(zh.prefixMessages, en.prefixMessages);
  for (const [turn, locale] of [[zh, 'zh'], [en, 'en'], [request({ uiLanguage: 'fr' }), 'fr'], [request({ uiLanguage: 'pt-BR' }), 'pt-BR']]) {
    const context = assembleContext({
      session: emptySession, prefix: turn.prefixMessages,
      current: turn.inputMessages.map(m => m.message),
    });
    assertOneCommunicationPolicy(context.messages);
    const fallback = context.messages.find(m => m.name === 'conversation_preferences');
    assert.equal(fallback.visibility, 'internal');
    assert.ok(fallback.content.includes(`ui_language_fallback: ${locale}`));
    assert.equal(context.messages.at(-1).content, zh.inputMessages.at(-1).message.content);
  }
});

test('tool loops and active compaction retain original human request and locale, without repeating policy', () => {
  const turn = request();
  const generatedMessages = [{
    messageId: 'progress', message: { role: 'assistant', content: '开始检查环境。', toolCalls: [
      { id: 'call', name: 'shell', argumentsText: '{}' },
    ] },
  }, {
    messageId: 'tool', message: { role: 'tool', toolCallId: 'call', name: 'shell', content: 'Node 24/npm are available; no Python/uv.' },
  }];
  const inputs = {
    turnId: turn.turnId, inputMessages: turn.inputMessages, generatedMessages,
  };
  for (const current of [
    projectActiveTurnContext(inputs),
    projectActiveTurnContext({ ...inputs, includeResumeInstruction: true, checkpoint: {
      inputMessageCount: turn.inputMessages.length, throughMessageId: 'tool',
      summary: '用户使用中文；环境检查已完成，下一步验证 MCP 来源。',
    } }),
  ]) {
    const context = assembleContext({ session: emptySession, prefix: turn.prefixMessages, current });
    assertOneCommunicationPolicy(context.messages);
    for (const input of turn.inputMessages) {
      assert.ok(context.messages.some(m => m.content === input.message.content));
    }
  }
});

test('children inherit human language evidence and fallback even when assignment wording is English', () => {
  const parent = request({
    instructionDocuments: [{ path: 'C:/fixture/AGENTS.md', scope: 'global', content: '先核对事实再修改。' }],
    conversationStyle: { mode: 'professional', customTone: '' },
  });
  const context = {
    sessionId: parent.sessionId, turnId: parent.turnId,
    turn: { request: parent, contextMessages: [
      ...parent.prefixMessages, ...parent.inputMessages.map(m => m.message),
    ] },
  };
  for (const inherit of [true, false]) {
    const child = buildChildTurnRequest({
      context, registry: new ToolRegistry(),
      ids: { requestId: 'child-request', sessionId: 'child', turnId: 'child-turn', messageId: 'child-input' },
      prompt: 'Verify the MCP source. Report in Chinese.',
      inherited: inheritedChildMessages(context, inherit), metadata: {},
    });
    assertOneCommunicationPolicy(child.prefixMessages);
    assert.deepEqual(child.prefixMessages[0], parent.prefixMessages[0]);
    assert.ok(child.prefixMessages.some(m => m.name === 'global_instructions' && m.content.includes('先核对事实再修改。')));
    assert.ok(child.prefixMessages.some(m => m.content.includes('Mode: professional')));
    assert.ok(child.prefixMessages.some(m => m.content.includes('ui_language_fallback: zh')));
    if (inherit) assert.deepEqual(child.prefixMessages, context.turn.contextMessages);
    assert.equal(child.inputMessages.at(-1).message.content, 'You are currently a child Agent.\n\nVerify the MCP source. Report in Chinese.');
    assert.equal(child.prefixMessages.some(m => m.content === parent.inputMessages.at(-1).message.content), inherit);
  }
});

test('continuations are internal; explicit language and artifact requests remain unmodified', () => {
  const continuation = request({ uiLanguage: 'en', userText: GOAL_CONTINUATION_PROMPT, userMessageName: 'goal_continuation' });
  assert.equal(continuation.inputMessages.at(-1).message.visibility, 'internal');
  assert.ok(continuation.inputMessages.some(m => m.message.content.includes('ui_language_fallback: en')));
  for (const userText of ['Please respond in English from now on.', '用中文解释，帮我写一封英文邮件。', '继续', 'https://example.com', 'const foo = 1;']) {
    const turn = request({ userText });
    assert.equal(turn.inputMessages.at(-1).message.content, userText);
    assert.equal(turn.inputMessages.at(-1).message.visibility, undefined);
    assertOneCommunicationPolicy(turn.prefixMessages);
  }
});

test('new built-in model declarations use English descriptions while display titles remain bilingual', async t => {
  const { InMemoryRuntimeHost } = await import('../packages/bush-runtime/dist/index.js');
  const { withToolDisplayTitle, toolCallDisplay } = await import('../packages/bush-runtime/dist/toolDisplay.js');
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const definitions = registry.definitions();
  assert.ok(definitions.some(tool => tool.name === 'subagent'));
  assert.ok(definitions.some(tool => tool.name === 'summary_for_user'));
  for (const definition of definitions) {
    assert.doesNotMatch(JSON.stringify(withToolDisplayTitle(definition)), /\p{Script=Han}/u, definition.name);
  }
  const native = { name: 'read_fixture', description: 'Read fixture', inputSchema: { type: 'object' } };
  const presented = withToolDisplayTitle(native);
  assert.deepEqual(presented.inputSchema.properties._display_title.required, ['zh', 'en']);
  const title = { zh: '检查文件', en: 'Check files' };
  const display = toolCallDisplay({ name: native.name, argumentsText: JSON.stringify({ _display_title: title }) }, native);
  assert.equal(display.title, 'Check files');
  assert.deepEqual(display.titles, title);
  assert.doesNotMatch(GOAL_CONTINUATION_PROMPT, /\p{Script=Han}/u);
});
