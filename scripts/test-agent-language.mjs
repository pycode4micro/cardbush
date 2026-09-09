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
    createdAt: '2026-09-08T00:00:00Z', localDate: '2026-09-08',
    sessionEnvironmentLocalDate: '2026-09-08',
    userText: '帮我安装blender的官方mcp，并且下载一点素材下来',
    uiLanguage: 'zh', model: 'fixture', tools: [], permissionMode: 'task_free',
    planEnabled: false, ...overrides,
  });
}
function assertOneCommunicationPolicy(messages) {
  assert.equal(messages.filter(m => m.content.includes('Choose the communication language')).length, 1);
  const policy = messages.find(m => m.content.includes('Choose the communication language')).content;
  assert.match(policy, /first user-visible sentence.*progress updates.*final response/s);
  assert.match(policy, /explicit preference first/);
  assert.match(policy, /artifact language independently/);
  assert.match(policy, /context checkpoints and summaries/);
}

test('first model context has one communication policy; locale changes do not churn the stable prefix', () => {
  const zh = request();
  const en = request({ uiLanguage: 'en' });
  assert.deepEqual(zh.prefixMessages, en.prefixMessages);
  for (const [turn, locale] of [[zh, 'zh-CN'], [en, 'en']]) {
    const context = assembleContext({
      session: emptySession, prefix: turn.prefixMessages,
      current: turn.inputMessages.map(m => m.message),
    });
    assertOneCommunicationPolicy(context.messages);
    const fallback = context.messages.find(m => m.name === 'turn_runtime_context');
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
  const parent = request();
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
    assert.ok(child.prefixMessages.some(m => m.name === 'communication_context' && m.content.includes('zh-CN')));
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
