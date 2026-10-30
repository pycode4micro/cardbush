import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const module = { exports: {} };
new Function('exports', ts.transpileModule(readFileSync('src/features/chatMessages/sourceMemoShorthand.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(module.exports);
const { remarkSourceMemoShorthand } = module.exports;
const render = content => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkSourceMemoShorthand, {
  references: new Map([[1, 'https://evidence.test/1']]), unresolved: new Set([6]), unavailableLabel: number => `Source ${number} is unverified`,
}]] }, content));

test('verified and unverified adjacent sources keep their order without fabricating identities', () => {
  const html = render('Claim [1][6].');
  assert.match(html, /href="https:\/\/evidence.test\/1"/);
  assert.match(html, /class="source-memo-unavailable"/);
  assert.match(html, /aria-label="Source 6 is unverified"/);
  assert.match(html, /\[1\]<\/a><span[^>]*>\[6\]<\/span>/);
  assert.doesNotMatch(html, /href="cardbush-source/);
});

test('unverified prose fallback does not rewrite code, arrays, escapes or authored links', () => {
  const html = render('Claim [6]. Code `[6]`, arr[6], \\[6], [label [6]](https://example.org).\n\n```text\n[6]\n```');
  assert.equal((html.match(/class="source-memo-unavailable"/g) ?? []).length, 1);
  assert.match(html, /<code>\[6\]<\/code>/);
  assert.match(html, /href="https:\/\/example.org"[^>]*>label \[6\]<\/a>/);
});

test('defined Markdown reference links retain standard semantics', () => {
  const html = render('Claim [1][6].\n\n[6]: https://example.org/defined');
  assert.match(html, /href="https:\/\/example.org\/defined"[^>]*>1<\/a>/);
  assert.doesNotMatch(html, /source-memo-unavailable|evidence.test/);
});
