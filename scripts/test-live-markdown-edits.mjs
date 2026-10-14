import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
const { partialEditInput, previewFileEdit } = await loadChatTranscript({ source: `export * from ${JSON.stringify(resolve('src/features/mdPresentation/fileEditPreview.ts'))};` });
const path = 'C:/writing/a.md', root = 'C:/writing';
const preview = (tool, input, base = '') => previewFileEdit(tool, input, base, path, root);

test('handles fragmented JSON escapes, Unicode, Windows paths and fields reordered by a provider', () => {
  const text = '# 标题\n\n汉字😀 "quote" \\';
  const json = JSON.stringify({ path: 'C:\\writing\\a.md', content: text });
  let previous = '';
  for (let i = 0; i <= json.length; i++) {
    const result = preview('write_file', json.slice(0, i));
    if (result) { assert.ok(text.startsWith(result.source)); assert.ok(result.source.startsWith(previous)); previous = result.source; }
  }
  assert.equal(previous, text);
  assert.equal(partialEditInput('{"content":"a\\uD83D').values.content, 'a');
  assert.equal(preview('write_file', '{"content":"new","path":"a.md"}').source, 'new');
  assert.equal(preview('write_file', '{"path":"other.md","content":"oops"}'), undefined);
  assert.equal(preview('write_file', '{"path":"a.md","content":"oops","encoding":"base64"}'), undefined);
  assert.equal(preview('write_file', '{"path":"a.md","path":"a.md","content":"oops"}'), undefined);
});
test('partial exact replacements preserve the unedited prefix and suffix, refusing ambiguous matches', () => {
  const base = '# A\n\nold\n\nfooter';
  const result = preview('edit_file', '{"path":"a.md","old_text":"old","new_text":"新段', base);
  assert.equal(result.source, '# A\n\n新段\n\nfooter'); assert.equal(result.cursor, 7);
  assert.equal(preview('edit_file', '{"path":"a.md","old_text":"old","new_text":"new"}', 'old old'), undefined);
  assert.equal(preview('edit_file', '{"path":"a.md","old_text":"old","replace_all":true,"new_text":"$&"}', 'old old').source, '$& $&');
  assert.equal(preview('edit_file', '{"path":"a.md","old_text":"missing","new_text":"new"}', base), undefined);
});
test('line replacements require complete versioned locations and retain CRLF outside the edit', () => {
  const input = JSON.stringify({ path: 'a.md', start_line: 2, end_line: 2, expected_sha256: 'a'.repeat(64), new_text: '新\r\n' });
  assert.equal(preview('edit_file', input, 'first\r\nold\r\nlast').source, 'first\r\n新\r\nlast');
  assert.equal(preview('edit_file', '{"path":"a.md","new_text":"new","start_line":1', 'old'), undefined);
});
test('patch preview uses the same exact-context implementation as the file tool', () => {
  const patch = '*** Begin Patch\n*** Update File: a.md\n@@\n first\n-old\n+新段';
  const input = JSON.stringify({ patch }).slice(0, -2);
  assert.equal(preview('apply_patch', input, 'first\nold\nlast\n').source, 'first\n新段\nlast\n');
  assert.equal(preview('apply_patch', input, 'different\nfile\n'), undefined);
  assert.equal(preview('apply_patch', JSON.stringify({ patch: '*** Begin Patch\n*** Delete File: a.md\n*** End Patch' }), 'keep'), undefined);
});
