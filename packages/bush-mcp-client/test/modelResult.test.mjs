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

test('duplicate structured JSON is shown once while images, prose and distinct JSON remain', () => {
  const structuredContent = { action: 'observe', output: { state_id: 'fresh-state', window: { hwnd: 12 }, accessibility: { elements: [{ name: 'UNIQUE-CONTROL' }] } } };
  const raw = { content: [
    { type: 'text', text: JSON.stringify(structuredContent, null, 2) },
    { type: 'text', text: 'Keep this warning' },
    { type: 'text', text: '{"different":true}' },
    { type: 'image', mimeType: 'image/png', data: 'image-bytes' },
  ], structuredContent, isError: false };
  const before = structuredClone(raw);
  const text = projectMcpResult(raw);
  assert.equal(text.split('UNIQUE-CONTROL').length - 1, 1);
  assert.equal(text.split('fresh-state').length - 1, 1);
  assert.match(text, /Keep this warning/);
  assert.equal(JSON.parse(text).content.length, 3);
  assert.doesNotMatch(text, /image-bytes/);
  assert.deepEqual(raw, before);
});
