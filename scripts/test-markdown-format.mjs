import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { fileMemoReference, parseFileMemoReference } from '@cardbush/bush-protocol';
import remarkGfm from 'remark-gfm';
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
  remarkAutolinkBoundaries,
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

// Exercise the actual GFM -> Markdown AST -> React link pipeline. String-only
// normalization tests cannot detect a visually plausible link with a wrong href.
const linkCases = [
  {
    name: 'localhost links stop before Chinese prose in the reported paragraph',
    input: '一条命令即可：`npm start`（前台 http://localhost:51231/，后台 http://localhost:51231/admin.html）。如果之前是用自定义 `PORT/ADMIN_TOKEN` 启动的',
    hrefs: ['http://localhost:51231/', 'http://localhost:51231/admin.html'],
    includes: ['</a>，后台 ', '</a>）。如果之前是用自定义 <code>PORT/ADMIN_TOKEN</code>'],
  },
  {
    name: 'multiple links separated only by Chinese punctuation remain independent',
    input: 'http://localhost:51231/，后台：http://localhost:51231/admin.html）。下一句',
    hrefs: ['http://localhost:51231/', 'http://localhost:51231/admin.html'],
    includes: ['</a>，后台：<a ', '</a>）。下一句'],
  },
  {
    name: 'Unicode domains, paths, query values and fragments are retained',
    input: 'https://例子.测试/中文?q=你好&x=1#章节，下一句',
    hrefs: [encodeURI('https://例子.测试/中文?q=你好&x=1#章节')],
    includes: ['>https://例子.测试/中文?q=你好&amp;x=1#章节</a>，下一句'],
  },
  {
    name: 'balanced URL parentheses and ASCII query punctuation remain native',
    input: '（https://example.com/wiki/Foo_(bar)?q=a,b;c:d!e&x=1）。下一句',
    hrefs: ['https://example.com/wiki/Foo_(bar)?q=a,b;c:d!e&x=1'],
    includes: ['</a>）。下一句'],
  },
  {
    name: 'ASCII trailing punctuation is handled after separating Chinese prose',
    input: 'https://example.com/a).，继续',
    hrefs: ['https://example.com/a'],
    includes: ['</a>).，继续'],
  },
  {
    name: 'percent-encoded punctuation belongs to the URL',
    input: 'https://example.com/a%EF%BC%8Cb?x=%E3%80%82，继续',
    hrefs: ['https://example.com/a%EF%BC%8Cb?x=%E3%80%82'],
  },
  {
    name: 'www autolinks use the same prose boundaries',
    input: 'www.example.com/docs，继续',
    hrefs: ['http://www.example.com/docs'],
    includes: ['>www.example.com/docs</a>，继续'],
  },
  {
    name: 'GFM fallback www links after Chinese punctuation are corrected',
    input: '地址：www.example.com/docs，后台：www.example.com/admin。',
    hrefs: ['http://www.example.com/docs', 'http://www.example.com/admin'],
    includes: ['>www.example.com/docs</a>，后台：', '>www.example.com/admin</a>。'],
  },
  {
    name: 'entities inside bare URL destinations remain literal',
    input: 'https://example.com/?q=&copy;&x=1，继续',
    hrefs: ['https://example.com/?q=&copy;&x=1'],
  },
  {
    name: 'source offsets remain correct after emoji and repeated URLs',
    input: '😀 http://localhost:51231/，前台；http://localhost:51231/，后台。',
    hrefs: ['http://localhost:51231/', 'http://localhost:51231/'],
    includes: ['😀 <a ', '</a>，前台；<a ', '</a>，后台。'],
  },
  {
    name: 'explicit links preserve punctuation even with a URL as the label',
    input: '[https://example.com/中文，版本](https://example.com/中文，版本 "完整地址")',
    hrefs: [encodeURI('https://example.com/中文，版本')],
    includes: ['title="完整地址"', '>https://example.com/中文，版本</a>'],
  },
  {
    name: 'angle autolinks preserve their explicit destination',
    input: '<https://example.com/中文，版本>',
    hrefs: [encodeURI('https://example.com/中文，版本')],
  },
  {
    name: 'reference links preserve their explicit destination',
    input: '[后台][admin]\n\n[admin]: https://example.com/中文，版本',
    hrefs: [encodeURI('https://example.com/中文，版本')],
    includes: ['>后台</a>'],
  },
  {
    name: 'code examples remain literal',
    input: '`https://example.com/a，继续`\n\n```text\nhttps://example.com/a，继续\n```',
    hrefs: [],
    includes: ['<code>https://example.com/a，继续</code>', '<pre><code class="language-text">https://example.com/a，继续\n</code></pre>'],
  },
  {
    name: 'emphasized URL normalization does not turn prose into an explicit URL',
    input: '**http://localhost:51231/，继续**',
    hrefs: ['http://localhost:51231/'],
    includes: ['<strong><a ', '</a>，继续</strong>'],
  },
  {
    name: 'existing emphasized URL display remains correct',
    input: '**http://127.0.0.1:8000**(F5 刷新)',
    hrefs: ['http://127.0.0.1:8000'],
    includes: ['</a></strong>(F5 刷新)'],
  },
  {
    name: 'swallowed inline code and emphasis regain native Markdown semantics',
    input: 'http://localhost:51231/，`npm start`，**继续**',
    hrefs: ['http://localhost:51231/'],
    includes: ['</a>，<code>npm start</code>，<strong>继续</strong>'],
  },
  {
    name: 'native references elsewhere in the message survive reparsing',
    input: '> http://localhost:51231/，`npm start`\n>\n> [说明][doc]\n\n[doc]: https://example.com/中文，版本',
    hrefs: ['http://localhost:51231/', encodeURI('https://example.com/中文，版本')],
    includes: ['<blockquote>', '</a>，<code>npm start</code>', '>说明</a>'],
  },
  {
    name: 'GFM lists, tables, tasks and strikethrough remain available',
    input: '- [x] ~~旧~~ http://localhost:51231/，继续\n\n| 地址 |\n| --- |\n| https://example.com/，结束 |',
    hrefs: ['http://localhost:51231/', 'https://example.com/'],
    includes: ['type="checkbox"', '<del>旧</del>', '<table>', '</a>，结束</td>'],
  },
  ...Array.from('，。；：！？、（）【】《》〈〉「」『』〔〕［］｛｝“”‘’…', (punctuation) => ({
    name: `prose delimiter ${punctuation} remains outside the link`,
    input: `https://example.com/path${punctuation}后文`,
    hrefs: ['https://example.com/path'],
    includes: [`</a>${punctuation}后文`],
  })),
];

for (const testCase of linkCases) {
  const hrefs = [];
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkAutolinkBoundaries],
    components: {
      a: ({ node: _node, ...props }) => {
        hrefs.push(props.href);
        return createElement('a', props);
      },
    },
  }, normalizeMarkdownContentForDisplay(testCase.input)));
  assert.deepEqual(hrefs, testCase.hrefs, testCase.name);
  for (const expected of testCase.includes ?? []) {
    assert.ok(html.includes(expected), `${testCase.name}: missing ${expected}\n${html}`);
  }
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

const memoReference = fileMemoReference({ sessionId: '会话', turnId: 'turn', toolCallId: 'memo' });
for (const content of [`[文件](${memoReference})`, `![图片](${memoReference})`, `[文件][memo]\n\n[memo]: ${memoReference}`]) {
  const references = [];
  renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkAutolinkBoundaries],
    urlTransform: url => parseFileMemoReference(url) ? url : defaultUrlTransform(url),
    components: {
      a: ({ href }) => { references.push(href); return null; },
      img: ({ src }) => { references.push(src); return null; },
    },
  }, normalizeMarkdownContentForDisplay(content)));
  assert.deepEqual(references, [memoReference], 'Markdown parsing must preserve the exact tool-returned reference');
}
console.log(`markdown format tests passed (${cases.length} formatting, ${linkCases.length} rendered links, 3 memo references)`);
