import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real shared send callback with a gated session creation. Neither
// local filesystem latency nor a remote acknowledgement should hold the bubble.
const source = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat');
const send = hook.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
  .find(node => node.name.getText(source) === 'sendMessage').initializer.arguments[0].getText(source);
const attachments = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'chatAttachmentsFromOutbound').getText(source);
const code = ts.transpileModule(`${attachments}\nexports.send = ${send};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(scope) {
  const creation = deferred(), completion = deferred(), streams = [], inspected = [], running = new Set();
  const candidate = { id: 'new', title: 'New', preview: '', updatedAt: '' };
  const state = { messages: {}, error: null, titles: [] };
  const context = {
    exports: {}, crypto: webcrypto, AbortController, console: { warn() {} },
    window: { cardbushDesktop: { inspectAttachments: async paths => { inspected.push(paths); return []; } }, setTimeout },
    backend: { scope }, selectedModel: 'fixture', managedModelConfigs: [], requestContext: {},
    referencePlanMode: 'normal', permissionMode: 'ask', subagentPermissionRouting: 'parent', reasoningLevel: 'none',
    languageRef: { current: 'zh' }, activeConversation: candidate, activeConversationIdRef: { current: 'new' },
    workspaceSwitchesRef: { current: new Map() }, conversationsRef: { current: [] }, preparedConversationsRef: { current: { new: candidate } },
    messagesByConversation: state.messages, messagesByConversationRef: { current: state.messages },
    controllersRef: { current: {} }, activeTurnIdsRef: { current: {} }, terminalTurnIdsRef: { current: new Set() }, viewActiveRef: { current: true },
    splitStreamAttachmentMentions: text => ({ displayInput: text, userInput: text, files: [], images: [] }),
    streamAttachmentsForVision: value => value, firstUserTitleSource: (_messages, text) => text,
    isSessionSending: id => running.has(id), markSessionRunning: id => running.add(id), clearSessionRunning: id => running.delete(id),
    setConnectionRecoveryByConversation() {}, setError: value => { state.error = value; }, errorMessage: String,
    setMessagesByConversation: update => { state.messages = update(state.messages); context.messagesByConversationRef.current = state.messages; },
    setConversations: update => update([]), upsertConversationPreview: rows => rows,
    persistPreparedConversation: () => creation.promise,
    persistAutoConversationTitle: (...args) => state.titles.push(args),
    conversationProjectRequestDir: value => value.projectDir, conversationWorkspaceRoot: value => value.workspaceDir,
    createFrameStreamBuffers: () => ({ flushAllStreaming: async () => {}, dispose() {} }),
    modelConfigFor: () => ({}), selectedModelName: () => 'fixture', normalizeDisabledToolNames: () => [],
    streamChat: async request => { streams.push(request); await completion.promise; },
    loadTeamFlow: async () => null, beginHistoryRead: () => ({}), fetchMessages: async () => [], refreshGoal: async () => null,
    markSessionAttention() {}, reloadConversations: async () => {}, truncateText: text => text,
    isPendingInteractionConflictError: () => false,
    markOptimisticChatRequestFailed: (all, id, userId, assistantId) => ({ ...all, [id]: all[id].filter(message => message.id !== assistantId)
      .map(message => message.id === userId ? { ...message, metadata: { message_delivery: 'failed' } } : message) }),
    dequeueMessageForConversation: () => undefined,
  };
  vm.runInNewContext(code, context);
  return { ...context.exports, context, state, creation, completion, streams, inspected, running, candidate };
}

for (const scope of [undefined, 'remote-agent']) {
  const f = fixture(scope), sending = f.send('第一条消息');
  await tick();
  assert.equal(f.state.messages.new[0].content, '第一条消息');
  assert.equal(f.state.messages.new[0].metadata.message_delivery, 'pending');
  assert.equal(f.streams.length, 0, 'pending UI never bypasses durable session creation');
  assert.equal(f.inspected.length, 0, 'plain text does not wait for attachment IPC');
  assert.ok(f.context.controllersRef.current.new, 'cancellation is available while creation is pending');
  f.creation.resolve({ ...f.candidate, workspaceDir: '/persisted/workspace' }); await tick();
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].workspaceDir, '/persisted/workspace', 'execution uses the confirmed workspace');
  f.completion.resolve(); await sending;
  assert.equal(f.running.size, 0);

  const failed = fixture(scope), failure = failed.send('保留失败的消息');
  await tick(); failed.creation.reject(Error('Creation failed')); await failure;
  assert.equal(failed.state.messages.new[0].metadata.message_delivery, 'failed');
  assert.equal(failed.state.messages.new[0].content, '保留失败的消息');
  assert.equal(failed.streams.length, 0); assert.equal(failed.running.size, 0);
  assert.match(failed.state.error, /Creation failed/);

  const cancelled = fixture(scope), cancellation = cancelled.send('取消创建中的发送');
  await tick(); cancelled.context.controllersRef.current.new.abort();
  cancelled.creation.resolve(cancelled.candidate); await cancellation;
  assert.equal(cancelled.streams.length, 0, 'late creation never submits a cancelled message');
  assert.equal(cancelled.running.size, 0);

  const navigated = fixture(scope), stale = navigated.send('原会话');
  await tick(); navigated.context.activeConversationIdRef.current = 'other';
  navigated.creation.reject(Error('Late failure')); await stale;
  assert.equal(navigated.state.error, null, 'late creation failure cannot appear in the selected conversation');
  assert.equal(navigated.state.messages.new[0].metadata.message_delivery, 'failed');
}
console.log('First message passed: immediate pending bubble, gated creation, confirmed workspace, failure retention, cancellation and navigation for local and remote hosts.');
