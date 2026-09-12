import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

function load(file) {
  file = resolve(file);
  const exports = {};
  const require = createRequire(file);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  new Function('exports', 'require', code)(exports, name => name.startsWith('.')
    ? load(resolve(dirname(file), name + '.ts')) : require(name));
  return exports;
}

const { conversationDisplayTitle: display, conversationTitleFromUserText: title } = load('src/shared/conversationTitle.ts');
const { authoredPromptContent, promptReferenceMarkdown } = load('src/shared/promptReferences.ts');
const skill = '[$video-face-stylizer](<C:/Users/EDY/My Skills/video-face-stylizer/SKILL.md>)';

test('skill, plugin, file and context links become readable names before title truncation', () => {
  assert.equal(title(skill + ' 现在已经可以使用了是么'), 'video-face-stylizer 现在已经可以使用了是么');
  assert.equal(title('[$face-tools](<C:/plugins/face-tools/.codex-plugin/plugin.json>) 排查连接'), 'face-tools 排查连接');
  assert.equal(title('检查 [需求文档](<D:/项目 (新版)/需求.md>) 的渲染'), '检查 需求文档 的渲染');
  const browser = promptReferenceMarkdown({ kind: 'browser', tabId: 'tab-1', url: 'https://example.test/(guide)', title: '浏览器页面' });
  assert.equal(title(browser + ' 检查布局'), '浏览器页面 检查布局');
  assert.equal(display('[页面](https://example.test/a_(b) "说明 (新版)") 后文'), '页面 后文');
  assert.equal(display('[需求 \\[草稿\\]](<D:/需求.md>) 和 ![截图](<D:/screen.png>)'), '需求 [草稿] 和 截图');
});

test('existing titles truncated inside a link recover the complete label', () => {
  for (const stored of [skill.slice(0, 25) + '...', skill.slice(0, 48) + '…', '[$video-face-stylizer](<C...']) {
    assert.equal(display(stored), 'video-face-stylizer', stored);
  }
  assert.equal(display('排查 [$face-tools](<D:/plugins/fa...'), '排查 face-tools');
  assert.equal(display('[布局](https://example.test/very-long…'), '布局');
  assert.equal(display('[布局](https://example.test/very-long'), '[布局](https://example.test/very-long', 'unfinished authored text without truncation stays literal');
});

test('attachment paths do not crowd out the request and the title limit preserves Unicode', () => {
  assert.equal(title('@"C:/Users/EDY/screenshot.png"\n优化这里的渲染\nD:/notes.txt'), '优化这里的渲染');
  assert.equal(title('/skill video-face-stylizer'), '/skill video-face-stylizer');
  const emoji = '👩🏽‍💻';
  assert.equal(title(emoji.repeat(60)), emoji.repeat(45) + '...');
  assert.equal(title(' \n '), '');
  assert.equal(title('只包含普通文字'), '只包含普通文字');
});

test('code, escaped links, ordinary punctuation and manually authored titles stay literal', () => {
  for (const value of ['[待办] 优化渲染 (第二版)', '成本 $5 / 100%', 'face_tool_v2',
    '`' + skill + '`', '\\' + skill, '```md\n' + skill + '\n```']) {
    assert.equal(display(value), value.replace(/\s+/g, ' ').trim());
  }
});

test('restored conversations use authored content and keep stored messages and custom titles intact', () => {
  const source = ts.createSourceFile('api.ts', readFileSync('src/backend/api.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ['runtimeConversation', 'optionalString', 'defaultConversationTitle'].includes(node.name?.text)).map(node => node.getText(source)).join('\n');
  const code = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const project = new Function('conversationDisplayTitle', 'conversationTitleFromUserText', 'authoredPromptContent', 'isInternalRuntimeMessage',
    code + '\nreturn runtimeConversation;')(display, title, authoredPromptContent, () => false);
  const authored = skill + ' 验证连接';
  const snapshot = { sessionId: 'fixture', updatedAt: '2026-09-12T00:00:00Z', metadata: {}, supersededMessageIds: [],
    turns: [{ messages: [{ messageId: 'user-1', metadata: { composerReferenceContent: authored },
      message: { role: 'user', content: 'Resolved context must never become a title.' } }] }] };
  const original = structuredClone(snapshot);
  assert.equal(project(snapshot).title, 'video-face-stylizer 验证连接');
  assert.deepEqual(snapshot, original);
  snapshot.metadata.title = '[$video-face-stylizer](<C...';
  assert.equal(project(snapshot).title, 'video-face-stylizer');
  assert.equal(snapshot.metadata.title, '[$video-face-stylizer](<C...', 'presentation does not rewrite persisted metadata');
  snapshot.metadata.title = '我设置的标题 [待办]';
  assert.equal(project(snapshot).title, snapshot.metadata.title);
});
