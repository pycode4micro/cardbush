import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const sourcePath = path.join(
  process.cwd(),
  'src',
  'features',
  'chatMessages',
  'markdownFormat.ts',
);
const source = fs.readFileSync(sourcePath, 'utf8');
const messageBubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
const quickContextSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'QuickContextRail.tsx'),
  'utf8',
);
const appStyles = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});

const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
});

const {
  normalizeExecutionNarrationForDisplay,
  normalizeMarkdownContentForDisplay,
} = module.exports;

const cases = [
  {
    name: 'windows path fence opener becomes code content',
    input: '文件路径:\n```C:\\Users\\wfang\\Desktop\\cardbush\\index.html\n```',
    expected: '文件路径:\n```text\nC:\\Users\\wfang\\Desktop\\cardbush\\index.html\n```',
  },
  {
    name: 'relative html path fence opener becomes code content',
    input: '文件路径:\n```index.html\n```',
    expected: '文件路径:\n```text\nindex.html\n```',
  },
  {
    name: 'file uri fence opener becomes code content',
    input: '文件路径:\n~~~file:///C:/Users/wfang/Desktop/cardbush/index.html\n~~~',
    expected: '文件路径:\n~~~text\nfile:///C:/Users/wfang/Desktop/cardbush/index.html\n~~~',
  },
  {
    name: 'shell command after language moves onto next line',
    input: '```powershell npm.cmd run build\n```',
    expected: '```powershell\nnpm.cmd run build\n```',
  },
  {
    name: 'normal language fence is unchanged',
    input: '```html\n<div>ok</div>\n```',
    expected: '```html\n<div>ok</div>\n```',
  },
  {
    name: 'empty fenced code block is removed',
    input: '部署清单\n\n```text\n   \n```\n\n下一段',
    expected: '部署清单\n\n\n\n下一段',
  },
  {
    name: 'emphasized bare URL becomes an unambiguous native Markdown link',
    input: '服务运行中:**http://127.0.0.1:8000**(F5 刷新)',
    expected: '服务运行中:**[http://127.0.0.1:8000](http://127.0.0.1:8000)**(F5 刷新)',
  },
  {
    name: 'emphasized URL inside inline code remains literal',
    input: '示例：`**http://127.0.0.1:8000**`',
    expected: '示例：`**http://127.0.0.1:8000**`',
  },
  {
    name: 'emphasized URL inside fenced code remains literal',
    input: '```md\n**https://example.com**\n```',
    expected: '```md\n**https://example.com**\n```',
  },
];

for (const testCase of cases) {
  assert.equal(
    normalizeMarkdownContentForDisplay(testCase.input),
    testCase.expected,
    testCase.name,
  );
}

const crowdedNarration =
  '我先读取核心文件确认问题。 现在继续检查页面运行状态。 然后读取剩余样式并进行浏览器验证。 核心代码已经读取完成。 接下来启动页面并检查交互表现。 继续确认最后的响应式样式和错误日志。'.repeat(2);
assert.equal(
  normalizeExecutionNarrationForDisplay(crowdedNarration, 6),
  crowdedNarration.replaceAll('。 ', '。\n\n'),
);
assert.equal(
  normalizeExecutionNarrationForDisplay(crowdedNarration, 1),
  crowdedNarration,
);

assert.match(
  messageBubbleSource,
  /<div className="markdown-content">/,
  'rendered Markdown must have an isolated hierarchy scope',
);
assert.match(
  quickContextSource,
  /<MarkdownContent content=\{message\.content\} language=\{language\} \/>/,
  'Quick-context turn details must reuse the conversation Markdown renderer.',
);
assert.doesNotMatch(
  quickContextSource,
  /<UserRound|<Bot/,
  'Quick-context turn details must not prefix messages with role icons.',
);
assert.match(
  appStyles,
  /\.markdown-content li > ul,[\s\S]*?\.markdown-content li > ol[\s\S]*?border-left:/,
  'nested Markdown lists must expose a visible hierarchy guide',
);
assert.match(
  appStyles,
  /\.markdown-content h1\s*\{[\s\S]*?font-size:\s*19px/,
  'assistant headings must stay compact instead of dominating the conversation',
);
assert.match(
  messageBubbleSource,
  /conclusionHeading[\s\S]*?markdown-conclusion-heading/,
  'conclusion headings must receive a dedicated compact presentation',
);
assert.match(
  appStyles,
  /\.markdown-content h1\.markdown-conclusion-heading\s*\{[\s\S]*?font-size:\s*15\.5px;[\s\S]*?text-wrap:\s*pretty;/,
  'long conclusions must avoid balanced wrapping and oversized heading typography',
);
assert.match(
  appStyles,
  /\.markdown-content blockquote/,
  'Markdown callouts must have a distinct quoted hierarchy',
);
assert.match(
  messageBubbleSource,
  /className="markdown-table-scroll"/,
  'wide Markdown tables must scroll without widening the chat track',
);
assert.match(
  messageBubbleSource,
  /className="markdown-code-language"/,
  'code blocks must expose a quiet language label',
);
assert.match(
  appStyles,
  /\.markdown-content h3::before\s*\{\s*display:\s*none;/,
  'compact headings must not add a decorative rail beside ordinary sections',
);

console.log(`markdown format tests passed (${cases.length})`);
