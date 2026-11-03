import assert from 'node:assert/strict';
import test from 'node:test';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
const { composerCodeRanges } = await loadChatTranscript({ source: 'export * from "./src/features/composer/composerCodeRanges.ts";', conditions: ['node'] });
const code = source => Array.from(composerCodeRanges(source), range => source.slice(range.start, range.end));

test('single, double and longer delimiters retain exact editable source offsets', () => {
  assert.deepEqual(code('关键词 `user_id`，``包含 `反引号` 的词``，**`重点`**。'), ['user_id', '包含 `反引号` 的词', '重点']);
  assert.deepEqual(code('😀 ```a `` b``` and `a\nb` and ` a  b `'), ['a `` b', 'a\nb', ' a  b ']);
  assert.deepEqual(code('`<img src=x onerror=alert(1)>`'), ['<img src=x onerror=alert(1)>']);
});
test('escaped delimiters, unfinished spans, fenced and indented blocks stay literal', () => {
  assert.deepEqual(code('\\`escaped\\` and `unfinished'), []);
  assert.deepEqual(code('``mismatch`'), []);
  assert.deepEqual(code('```js\nconst a = `not inline`;\n```\n\n`inline`'), ['inline']);
  assert.deepEqual(code('~~~\n`not inline`\n~~~\n\n    `indented`\n\n- `list code`'), ['list code']);
  assert.deepEqual(code('[label](https://example.com/`path`)\n\n`real`'), ['real']);
});
test('large pasted text has a bounded plain-text fallback without modifying the source', () => {
  const source = '`keyword`'.repeat(10_000);
  assert.deepEqual(code(source), []);
  assert.equal(source.length, 90_000);
});
