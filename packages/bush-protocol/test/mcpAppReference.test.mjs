import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpAppReference, mcpAppReferenceMarkdown, parseMcpAppReference } from '../dist/index.js';

test('App references round-trip execution identities and escape Markdown delimiters', () => {
  const identity = { sessionId: 'session a', turnId: '轮/1', toolCallId: "call(a)'!*" };
  const reference = mcpAppReference(identity);
  assert.deepEqual(parseMcpAppReference(reference), identity);
  assert.doesNotMatch(reference, /[()'!*\s]/);
  assert.equal(mcpAppReferenceMarkdown('设计 [v1]\\\n查看', reference), `[设计 \\[v1\\]\\\\ 查看](${reference})`);
});

test('malformed and noncanonical App references cannot become resource URLs', () => {
  for (const value of ['cardbush-app:', 'cardbush-app:s/t', 'cardbush-app:s/t/c/extra', 'cardbush-app:s/t/%00',
    'cardbush-app:s/t/%0A', 'cardbush-app:s/t/%ZZ', 'cardbush-app:s/t/%63', 'cardbush-app://host/t/c',
    'cardbush-app:s/t/c?url=https://evil.invalid', 'cardbush-app:s/t/' + 'x'.repeat(4096), 'https://example.com']) {
    assert.equal(parseMcpAppReference(value), undefined, value.slice(0, 100));
  }
});
