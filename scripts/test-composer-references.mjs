import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import { createProductAgentTurnRequest } from '../packages/bush-product-agent/dist/index.js';

const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const require = createRequire(file);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', code)(exports, name => name.startsWith('.') ? load(resolve(dirname(file), name + '.ts')) : require(name));
  return exports;
}
const refs = load('src/shared/promptReferences.ts');
const { resolvePromptReferenceContext } = load('src/backend/promptReferenceContext.ts');
const { projectRuntimeSessionMessage } = load('src/backend/runtimeSessionMessageProjection.ts');
const { inspectorBrowserReferences, referenceableUserMessages } = load('src/features/composer/ComposerReferenceContext.ts');
const user = { kind: 'user-turn', sessionId: 'current', turnId: 'turn-1', messageId: 'user-1', title: '中文 [具体] 指令 \\ 路径' };
const browser = { kind: 'browser', tabId: 'tab-1', url: 'https://example.test/a?term=中文&next=(x)#section', title: '已打开的网页' };
const raw = { messageId: user.messageId, turnId: user.turnId, turnSequence: 1, messageIndex: 0, createdAt: '2026-09-12T00:00:00Z', message: { role: 'user', content: '完整原文\n' + '内容'.repeat(6000) } };
const snapshot = { sessionId: 'current', supersededMessageIds: [], turns: [{ turnId: user.turnId, messages: [raw, { ...raw, messageId: 'assistant', message: { role: 'assistant', content: 'Do not attach this response.' } }] }] };

test('reference identity, Unicode titles and authored offsets survive copying and persistence', () => {
  const value = `前文 ${refs.promptReferenceMarkdown(user)}\n${refs.promptReferenceMarkdown(browser)} 后文`;
  const parts = refs.promptReferenceParts(value);
  assert.equal(parts.map(part => part.text).join(''), value);
  assert.deepEqual(parts.flatMap(part => part.reference ? [part.reference] : []), [user, browser]);
  for (const part of parts) assert.equal(value.slice(part.start, part.start + part.text.length), part.text);
  assert.deepEqual(refs.parsePromptReference(refs.promptReferenceHref(browser)), browser);
});

test('literal code, images, ordinary @ text and unsafe targets never attach context', async () => {
  const reference = refs.promptReferenceMarkdown(user);
  for (const value of ['user@example.test @note', '`' + reference + '`', '`literal\n' + reference + '`', '```md\n' + reference + '\n```', '```md\n' + reference,
    '````md\n```\n' + reference + '\n````', '~~~md\n' + reference + '\n~~~', '\\' + reference, '!' + reference]) {
    assert.equal(refs.promptReferenceParts(value).some(part => part.reference), false, value);
    assert.deepEqual(await resolvePromptReferenceContext(value, 'current'), { content: value, metadata: undefined });
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/secret.txt']) {
    assert.equal(refs.parsePromptReference(refs.promptReferenceHref({ ...browser, url })), null);
  }
  assert.equal(refs.parsePromptReference('cardbush-reference://user-turn?title=Fake'), null);
});

test('selected user facts are complete, deduplicated and appended only to the new message', async () => {
  const original = structuredClone(snapshot);
  const content = `${refs.promptReferenceMarkdown(user)} 对照 ${refs.promptReferenceMarkdown(user)} ${refs.promptReferenceMarkdown(browser)}`;
  const resolved = await resolvePromptReferenceContext(content, 'current', snapshot);
  assert.ok(resolved.content.startsWith(content));
  assert.ok(resolved.content.includes(JSON.stringify(raw.message.content)));
  assert.doesNotMatch(resolved.content, /Do not attach this response/);
  assert.equal(resolved.content.split('"messageId": "user-1"').length - 1, 1);
  assert.deepEqual(snapshot, original, 'never rewrite prior user messages, summaries or cache prefix');
  assert.deepEqual(await resolvePromptReferenceContext(content, 'current', snapshot), resolved, 'same selected facts serialize identically');
  const input = { requestId: 'new', sessionId: 'current', turnId: 'next', messageId: 'user-next', createdAt: raw.createdAt, localDate: '2026-09-12', model: 'model', tools: [], permissionMode: 'task_free', planEnabled: false };
  const request = createProductAgentTurnRequest({ ...input, userText: resolved.content, userMessageMetadata: resolved.metadata });
  const ordinary = createProductAgentTurnRequest({ ...input, userText: 'ordinary' });
  assert.deepEqual(request.prefixMessages, ordinary.prefixMessages);
  const persisted = { ...raw, ...request.inputMessages.find(item => item.messageId === 'user-next') };
  assert.equal(projectRuntimeSessionMessage(persisted, 'current').content, content);
  assert.equal(JSON.parse(JSON.stringify(persisted)).message.content, resolved.content, 'restart retains the already-resolved model facts');
});

test('a referenced instruction does not recursively reattach its own reference payload', async () => {
  const saved = structuredClone(snapshot);
  saved.turns[0].messages[0].metadata = { composerReferenceContent: 'The user-authored instruction.' };
  saved.turns[0].messages[0].message.content = 'The user-authored instruction.\nOld resolved context.';
  const resolved = await resolvePromptReferenceContext(refs.promptReferenceMarkdown(user), 'current', saved);
  assert.match(resolved.content, /The user-authored instruction/);
  assert.doesNotMatch(resolved.content, /Old resolved context/);
});

test('wrong conversation, replaced, internal and assistant messages are explicit failures', async () => {
  for (const variant of [{ ...user, sessionId: 'other' }, { ...user, messageId: 'assistant' }, { ...user, messageId: 'missing' }, { ...user, turnId: 'missing' }]) {
    await assert.rejects(resolvePromptReferenceContext(refs.promptReferenceMarkdown(variant), 'current', snapshot), /无法引用/);
  }
  const replaced = { ...snapshot, supersededMessageIds: [user.messageId] };
  await assert.rejects(resolvePromptReferenceContext(refs.promptReferenceMarkdown(user), 'current', replaced), /无法引用/);
  const internal = structuredClone(snapshot); internal.turns[0].messages[0].message.visibility = 'internal';
  await assert.rejects(resolvePromptReferenceContext(refs.promptReferenceMarkdown(user), 'current', internal), /无法引用/);
});

test('in-flight references resolve from the host fact without reading another conversation', async () => {
  let reads = 0;
  const reader = async (turnId, messageId) => { reads++; assert.equal(turnId, user.turnId); assert.equal(messageId, user.messageId); return raw; };
  const resolved = await resolvePromptReferenceContext(refs.promptReferenceMarkdown(user), 'current', null, 'zh', reader);
  assert.equal(reads, 1); assert.ok(resolved.content.includes(JSON.stringify(raw.message.content)));
  await assert.rejects(resolvePromptReferenceContext(refs.promptReferenceMarkdown({ ...user, sessionId: 'other' }), 'current', null, 'zh', reader));
  assert.equal(reads, 1);
});

test('browser sources use live navigation and exclude file previews, while selected links stay frozen', () => {
  const tabs = [{ id: 'tab-1', kind: 'resource', detail: { target: 'https://example.test/old', title: 'Old title' } },
    { id: 'file', kind: 'resource', detail: { target: 'C:/file.html' } }, { id: 'review', kind: 'review' }];
  const navigation = { 'tab-1': { url: browser.url, title: browser.title } };
  const choices = inspectorBrowserReferences(tabs, navigation);
  assert.deepEqual(choices, [browser]);
  const selected = refs.promptReferenceMarkdown(choices[0]);
  navigation['tab-1'] = { url: 'https://example.test/next', title: 'Next' };
  assert.equal(inspectorBrowserReferences(tabs, navigation)[0].title, 'Next');
  assert.deepEqual(refs.promptReferenceParts(selected)[0].reference, browser);
});

test('the picker lists current-conversation user messages only and preserves duplicate titles as distinct identities', () => {
  const message = { id: 'ui-1', messageId: 'user-1', turnId: 'turn-1', conversationId: 'current', role: 'user', content: 'same' };
  const choices = referenceableUserMessages([message, { ...message, id: 'ui-2', messageId: 'user-2' },
    { ...message, role: 'assistant' }, { ...message, conversationId: 'other' }, { ...message, metadata: { __bush_superseded: true } },
    { ...message, metadata: { message_delivery: 'failed' } }, { ...message, metadata: { message_delivery: 'pending' } }], 'current');
  assert.deepEqual(choices.map(item => item.messageId), ['user-1', 'user-2']);
});

test('accepted live user and guidance messages retain Runtime identities before history refresh', () => {
  const { assignTurnToLocalMessages, applyAssistantSegmentBoundary } = load('src/features/chatMessages/transcript/liveMessageUpdates.ts');
  const initial = { current: [{ id: 'optimistic-user', role: 'user', content: 'draft' }] };
  const started = assignTurnToLocalMessages(initial, 'current', 'running-turn', ['optimistic-user'], undefined, 'runtime-user');
  assert.equal(started.current[0].id, 'optimistic-user', 'render identity stays stable');
  assert.equal(started.current[0].messageId, 'runtime-user');
  assert.equal(referenceableUserMessages(started.current, 'current').length, 1);
  const continuation = assignTurnToLocalMessages(started, 'current', 'automatic-next-turn', ['optimistic-user']);
  assert.equal(continuation.current[0].turnId, 'running-turn', 'hidden goal continuation cannot move the referenced user fact');
  const guidance = { current: [{ id: 'guide-user', clientMessageId: 'guide-user', conversationId: 'current', turnId: 'running-turn', role: 'user', content: 'guidance', metadata: { guidance_delivery: 'queued' } }] };
  assert.equal(referenceableUserMessages(guidance.current, 'current').length, 0);
  const applied = applyAssistantSegmentBoundary(guidance, 'current', '', { messageId: '', guidanceMessageId: 'guide-user', turnId: 'running-turn' });
  assert.equal(applied.current[0].messageId, 'guide-user');
  assert.equal(referenceableUserMessages(applied.current, 'current').length, 1);
});
