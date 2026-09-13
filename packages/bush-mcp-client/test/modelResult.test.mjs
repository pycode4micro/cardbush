import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMcpResult } from '../dist/modelResult.js';

test('model projection only hides UI metadata without wrapping or interpreting the native result', () => {
  for (const isError of [true, false, undefined]) {
    const raw = { ...(isError === undefined ? {} : { isError }), content: [{ type: 'text', text: 'Created successfully' }], structuredContent: { file: 'source.html' }, _meta: { private: 'UI-only' } };
    const before = structuredClone(raw), result = JSON.parse(projectMcpResult(raw));
    assert.deepEqual(raw, before);
    assert.deepEqual(result, { ...(isError === undefined ? {} : { isError }), content: raw.content, structuredContent: raw.structuredContent });
    assert.equal(JSON.stringify(result).includes('UI-only'), false);
  }
});

test('model projection preserves native nulls, extension fields and server fields named facts or result', () => {
  const native = { content: [], structuredContent: null, facts: { server: true }, result: 'native', extension: [1, 2], _meta: { private: true } };
  assert.deepEqual(JSON.parse(projectMcpResult(native)), { content: [], structuredContent: null, facts: { server: true }, result: 'native', extension: [1, 2] });
});

test('MCP model projection removes image bytes, including nested resources, without touching native content', () => {
  const raw = { content: [{ type: 'image', mimeType: 'image/png', data: 'native-image-bytes' },
    { type: 'resource', resource: { mimeType: 'image/jpeg', blob: 'native-resource-bytes', uri: 'image://test' } }],
    isError: true, _meta: { private: true } };
  const before = structuredClone(raw);
  const text = projectMcpResult(raw);
  assert.ok(!text.includes('native-image-bytes'));
  assert.ok(!text.includes('native-resource-bytes'));
  assert.ok(!text.includes('private'));
  assert.equal(JSON.parse(text).isError, true);
  assert.deepEqual(raw, before);
});
