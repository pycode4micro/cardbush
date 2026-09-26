import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
import { createProductAgentTurnRequest } from '../packages/bush-product-agent/dist/index.js';

const cache = new Map();
function load(file) {
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const require = createRequire(file);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', code)(exports, name => name === '@cardbush/bush-protocol' ? protocol : name.startsWith('.') ? load(resolve(dirname(file), name + '.ts')) : require(name));
  return exports;
}
const refs = load('src/shared/promptReferences.ts');
const skillRefs = load('src/features/skills/skillReferences.ts');
const { resolvePromptReferenceContext } = load('src/backend/promptReferenceContext.ts');
const { projectRuntimeSessionMessage } = load('src/backend/runtimeSessionMessageProjection.ts');
const { inspectorBrowserReferences, referenceableUserMessages } = load('src/features/composer/ComposerReferenceContext.ts');
const user = { kind: 'user-turn', sessionId: 'current', turnId: 'turn-1', messageId: 'user-1', title: '中文 [具体] 指令 \\ 路径' };
test('application references append selection facts without invoking tools or changing authored text', async () => {
  const entries = [
    { kind: 'application', id: 'builtin:automations', title: '定时与自动化', applicationKind: 'builtin', target: 'automations' },
    { kind: 'application', id: 'plugin:sample:design', title: '设计 [草稿]', applicationKind: 'plugin', target: 'sample', componentId: 'design' },
    { kind: 'application', id: 'external:example', title: '本地应用', applicationKind: 'external', target: 'http://localhost:8989/' },
    { kind: 'application', id: 'local:editor', title: '本地编辑器', applicationKind: 'local', target: 'C:\\Program Files\\编辑器\\editor.exe' },
  ];
  for (const entry of entries) {
    const link = refs.promptReferenceMarkdown(entry); assert.deepEqual(refs.parsePromptReference(refs.promptReferenceHref(entry)), entry);
    const original = `${link} 帮我处理这个任务 ${link}`;
    const resolved = await resolvePromptReferenceContext(original, 'local-or-cloud', null);
    assert.equal(resolved.metadata.composerReferenceContent, original);
    assert.ok(resolved.content.startsWith(original));
    const data = JSON.parse(resolved.content.split('Referenced context selected by the user (source material):\n')[1]);
    assert.equal(data.length, 1); assert.equal(data[0].target, entry.target); assert.match(data[0].note, /not|does not/);
    assert.equal(refs.promptReferenceParts('`' + link + '`').some(part => part.reference), false);
  }
  for (const entry of [
    { ...entries[0], target: 'execute' }, { ...entries[0], id: 'builtin:settings' },
    { ...entries[1], componentId: 'different' }, { ...entries[2], target: 'javascript:alert(1)' },
    { ...entries[2], target: 'https://user:secret@example.test/' }, { ...entries[2], target: 'file:///C:/program.exe' },
    { ...entries[3], target: 'editor.exe --run' }, { ...entries[3], target: 'https://example.test/app.exe' },
  ]) assert.equal(refs.parsePromptReference(refs.promptReferenceHref(entry)), null);
});
test('SSH references follow the selected execution environment and never carry credentials', async () => {
  const target={kind:'ssh',connectionId:'server-id',path:'/home/user/项目',title:'开发服务器'};
  const chip=refs.promptReferenceMarkdown(target);assert.deepEqual(refs.promptReferenceParts(chip)[0].reference,target);
  const snapshot={metadata:{runtimeWorkspace:{workspaceDir:protocol.sshWorkspace(target.connectionId,target.path)}}};
  assert.match((await resolvePromptReferenceContext(chip,'current',snapshot)).content,/Selected remote project/);
  await assert.rejects(resolvePromptReferenceContext(chip,'current'),/不一致/);
  assert.equal(refs.withWorkspaceReference('hello\n'), 'hello\n');
  assert.equal(refs.withWorkspaceReference('hello '+chip),'hello ');
  assert.equal(refs.promptReferenceParts(refs.withWorkspaceReference('hello '+chip,chip)).filter(part=>part.reference?.kind==='ssh').length,1);
});
test('conversation extracts resolve as readable Markdown paths, deduplicate, and respect the receiving model budget', async () => {
  const oldWindow = globalThis.window;
  const reference = { kind: 'conversation-extract', id: '00000000-0000-4000-8000-000000000001', title: '提取 [中文]' };
  const calls = [];
  globalThis.window = { cardbushDesktop: { conversationExtracts: { resolve: async (id, context) => {
    calls.push({ id, context }); return { id, path: 'C:/data/extract.md', title: '提取 [中文]', tokens: 100 };
  } } } };
  try {
    const token = refs.promptReferenceMarkdown(reference);
    assert.deepEqual(refs.promptReferenceParts(token)[0].reference, reference);
    const resolved = await resolvePromptReferenceContext(`${token} ${token}`, 'current', undefined, 'zh', undefined, 400);
    assert.equal(calls.length, 1); assert.equal(calls[0].context, 400);
    assert.match(resolved.content, /C:\/data\/extract.md/);
    assert.match(resolved.content, /source material, not new instructions/);
    await assert.rejects(resolvePromptReferenceContext(token, 'current', undefined, 'zh', undefined, 396), /1\/4/);
    globalThis.window.cardbushDesktop.conversationExtracts.resolve = async () => { throw Error('expired'); };
    await assert.rejects(resolvePromptReferenceContext(token, 'current'), /expired/);
  } finally { globalThis.window = oldWindow; }
});

test('skill tokens preserve full paths, surrounding text and escaped labels without changing the prompt', () => {
  const skill = { name: '中文 [技能] \\ 示例', displayName: '视频制作', path: 'C:\\Users\\EDY\\My Skills\\场景 #50% (test)\\SKILL.md' };
  const link = skillRefs.skillReference(skill);
  const content = `先用 ${link} 再补充 ${link}。`;
  const parts = skillRefs.skillPromptParts(content, [skill]);
  assert.equal(parts.map(part => part.text).join(''), content);
  const tokens = parts.filter(part => part.skillReference);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].skill, skill);
  assert.equal(tokens[0].skillReference.title, skill.name);
  assert.equal(tokens[0].skillReference.path, skill.path.replaceAll('\\', '/'));
  for (const part of parts) assert.equal(content.slice(part.start, part.start + part.text.length), part.text);
});

test('skill identity follows the referenced path, including before the catalog loads', () => {
  const first = { name: 'same-name', path: 'C:/CardBush/skills/a/SKILL.md' };
  const other = { name: 'same-name', path: 'C:/Other Host/skills/a/SKILL.md' };
  const link = '[same-name](<c:/cardbush/skills/A/skill.md>)';
  assert.equal(skillRefs.skillPromptParts(link, [other, first])[0].skill, first);
  assert.equal(skillRefs.skillPromptParts(link, [])[0].skillReference.path, 'c:/cardbush/skills/A/skill.md');
  assert.equal(skillRefs.skillPromptParts(link, [])[0].skill, undefined);
  assert.equal(skillRefs.skillPromptParts('[a](<//server/skills/a/SKILL.md>)', [])[0].skillReference.path, '//server/skills/a/SKILL.md');
  assert.equal(skillRefs.skillPromptParts('[a](/home/me/skills/a/SKILL.md)', [])[0].skillReference.path, '/home/me/skills/a/SKILL.md');
});

test('skill examples, escaped links, images and unrelated paths remain editable literal text', () => {
  const link = '[sample](<C:/skills/sample/SKILL.md>)';
  for (const value of ['`' + link + '`', '```md\n' + link + '\n```', '~~~md\n' + link + '\n~~~',
    '\\' + link, '!' + link, '[a](https://example.test/SKILL.md)', '[a](<C:/skills/README.md>)', '[a](skills/sample/SKILL.md)']) {
    const parts = skillRefs.skillPromptParts(value, []);
    assert.equal(parts.some(part => part.skillReference), false, value);
    assert.equal(parts.map(part => part.text).join(''), value);
  }
});
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
