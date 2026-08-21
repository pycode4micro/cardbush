import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const composerPath = path.join(
  process.cwd(),
  'src',
  'features',
  'composer',
  'Composer.tsx',
);
const source = fs.readFileSync(composerPath, 'utf8');
const mainSource = fs.readFileSync(
  path.join(process.cwd(), 'electron', 'main.ts'),
  'utf8',
);
const preloadSource = fs.readFileSync(
  path.join(process.cwd(), 'electron', 'preload.ts'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
const messageBubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'App.tsx'),
  'utf8',
);
const slashBlock = source.match(
  /const slashCommands[\s\S]*?const commandItems/,
)?.[0] ?? '';

assert.ok(slashBlock, 'slash quick-action block is missing');
assert.deepEqual(
  [...slashBlock.matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]),
  ['/model', '/goal', '/skill', '/new'],
);
assert.match(slashBlock, /模型切换/);
assert.match(slashBlock, /目标/);
assert.match(slashBlock, /技能/);
assert.match(slashBlock, /新会话/);
const goalCommandBlock = slashBlock.match(
  /id:\s*'\/goal'[\s\S]*?searchText:\s*'\/goal 目标 goal'/,
)?.[0] ?? '';
assert.ok(goalCommandBlock, 'the /goal quick action is missing');
assert.match(goalCommandBlock, /icon:\s*<Target/);
assert.match(
  goalCommandBlock,
  /value:\s*'\/goal '/,
  'selecting /goal must insert it into the composer instead of opening a panel',
);
assert.doesNotMatch(
  goalCommandBlock,
  /run:/,
  'the /goal quick action must not bypass the conversation',
);
const modelCommandBlock = slashBlock.match(
  /id:\s*'\/model'[\s\S]*?searchText:\s*'\/model 模型切换 switch model'/,
)?.[0] ?? '';
assert.ok(modelCommandBlock, 'the /model quick action is missing');
assert.match(modelCommandBlock, /icon:\s*<Box/);
assert.match(modelCommandBlock, /setActiveMenu\('models'\)/);
assert.doesNotMatch(modelCommandBlock, /onConfigureModels/);
assert.match(messageBubbleSource, /userGoalCommandPresentation/);
assert.match(messageBubbleSource, /<Target size=\{14\}/);
assert.match(messageBubbleSource, /messageHasGoalContext\(message\)/);
assert.match(messageBubbleSource, /normalizeGoalObjective\(currentGoalObjective\)/);
assert.match(appSource, /goalObjective=\{activeGoal\?\.objective \?\? ''\}/);
assert.match(messageBubbleSource, /metadata\.experimental_goal/);
assert.match(messageBubbleSource, /metadata\.goal_auto_continuation === true/);
assert.match(
  messageBubbleSource,
  /goalCommand\.commandToken &&[\s\S]*?user-command-token/,
  'goal turns must keep the target heading without showing a synthetic /goal token',
);
assert.match(messageBubbleSource, /legacyUserGoalCommandText/);
assert.match(messageBubbleSource, /Please review the attached file\(s\)\./);
assert.match(messageBubbleSource, /isGoalCommandAttachmentPath/);
assert.match(source, /const goalDraft = composerGoalDraftPresentation\(draft\)/);
assert.match(source, /className="composer-command-mode goal"/);
assert.match(source, /<Target size=\{15\}/);
assert.match(source, /value=\{composerInputValue\}/);
assert.match(source, /onDraftChange\(`\/goal\$\{next \? ` \$\{next\}` : ' '\}`\)/);
assert.match(
  chatHookSource,
  /\^\\\/\(\?:model\|goal\|skill\|new\)\(\?:\\s\|\$\)/,
  'slash commands must not be parsed as POSIX file attachments',
);
assert.doesNotMatch(slashBlock, /title:\s*['"`]\//);
assert.doesNotMatch(source, /ComposerCommandMode\s*=\s*[^;]*mention/);
assert.doesNotMatch(source, /mentionMatch|mentionCommands|输入 @|Type @/);
assert.match(
  source,
  /`\$\{selectedModelConfig\.modelName\} · \$\{selectedModelConfig\.provider\}`/,
  'the compact model label must place the provider name last',
);
assert.match(source, /const \[fileAttachments, setFileAttachments\] = useState/);
assert.match(
  source,
  /const attachmentPaths = \[\.\.\.imageAttachments, \.\.\.fileAttachments\][\s\S]*?\.map\(\(item\) => `@\$\{item\.path\}`\)/,
  'Attachment paths must retain the existing hidden backend transport format',
);
assert.doesNotMatch(
  source,
  /otherPaths\.map\(\(value\) => `@\$\{value\}`\)/,
  'Selecting files must not insert @ commands into the visible draft',
);
assert.match(
  source,
  /className="composer-file-preview"[\s\S]*?openInspector\(file\.path, file\.name\)/,
  'File cards must open the existing right-side read-only inspector',
);
assert.match(source, /<ComposerFileIcon name=\{file\.name\} \/>/);
assert.match(source, /<small>\{formatFileSize\(file\.size\)\}<\/small>/);
assert.match(mainSource, /ipcMain\.handle\('files:inspect-attachments'/);
assert.match(mainSource, /size:\s*stats\.size/);
assert.match(preloadSource, /inspectAttachments:[\s\S]*?files:inspect-attachments/);
assert.match(stylesSource, /\.composer-file-attachment\s*\{/);
assert.match(stylesSource, /\.composer-file-meta small\s*\{[\s\S]*?color:\s*var\(--text-soft\)/);
assert.match(
  chatHookSource,
  /const userMessage:[\s\S]*?content:\s*outbound\.displayInput,[\s\S]*?attachments:/,
  'The optimistic user bubble must not expose hidden @ attachment paths',
);
assert.match(chatHookSource, /userInput:\s*outbound\.userInput/);
assert.match(messageBubbleSource, /function MessageFileAttachmentStrip/);
assert.match(messageBubbleSource, /splitUserFileAttachments/);
assert.match(
  messageBubbleSource,
  /openInspector\(pathValue, name\)/,
  'Sent file cards must open the right-side read-only inspector',
);
assert.match(stylesSource, /\.message-file-attachment\s*\{/);
const sendButtonHoverRule = stylesSource.match(
  /\.composer-actions \.send-button:hover\s*\{([^}]*)\}/,
)?.[1] ?? '';
assert.ok(sendButtonHoverRule, 'The send button hover rule is missing');
assert.doesNotMatch(
  sendButtonHoverRule,
  /transform|translateY|\bscale\s*:/,
  'Hovering the send button must not move it vertically or scale it',
);
assert.doesNotMatch(
  stylesSource,
  /\.composer-actions \.send-button:active\s*\{[^}]*transform/,
  'Pressing the send button must not restore a hover translation and create a visible jump',
);
assert.match(
  source,
  /event\.repeat\s*\|\|\s*event\.nativeEvent\.isComposing/,
  'Enter submission must ignore key repeat and IME composition events',
);
assert.match(
  source,
  /if\s*\(!cancelReady\)/,
  'The send control must not cancel a request before backend acceptance or during the double-click guard',
);
assert.match(
  source,
  /disabled=\{sending\s*&&\s*!hasContent\s*&&\s*!cancelReady\}/,
  'The pre-start send control must remain a disabled waiting state',
);
assert.match(source, /setTimeout\(\(\) => setCancelReady\(true\), 600\)/);
assert.match(source, /停止生成/);
assert.match(source, /<Square size=\{14\} fill="currentColor"/);
assert.doesNotMatch(source, /<Pause\b/);
assert.match(source, /aria-label=\{sendButtonLabel\}/);
assert.match(messageBubbleSource, /message-delivery-status/);
assert.match(messageBubbleSource, /onRetryMessage\(message\)/);
assert.match(chatHookSource, /let streamStarted = false/);
assert.match(chatHookSource, /markOptimisticChatRequestFailed\(/);

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  require: () => ({}),
  window: {},
  console,
});
const { composerGoalDraftPresentation, detectComposerCommand } = module.exports;
const detect = (value, caret = value.length) => plain(detectComposerCommand(value, caret));

assert.deepEqual(plain(composerGoalDraftPresentation('/goal ')), { content: '' });
assert.deepEqual(
  plain(composerGoalDraftPresentation('/goal 完成发布验证')),
  { content: '完成发布验证' },
);
assert.equal(composerGoalDraftPresentation('/goal/file'), null);

assert.deepEqual(detect('/'), {
  mode: 'slash',
  start: 0,
  end: 1,
  query: '',
});
assert.deepEqual(detect('/model'), {
  mode: 'slash',
  start: 0,
  end: 6,
  query: 'model',
});
assert.deepEqual(detect('请处理 /go'), {
  mode: 'slash',
  start: 4,
  end: 7,
  query: 'go',
});
assert.equal(detect('请处理/go'), null);
assert.equal(detect('请处理\n/go'), null);
assert.equal(detect('请处理\t/go'), null);
assert.equal(detect('@file'), null);
assert.equal(detect('请查看 @file'), null);

console.log('composer quick-action contract tests passed');

function plain(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
