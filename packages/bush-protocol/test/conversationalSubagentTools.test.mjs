import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as protocol from '@cardbush/bush-protocol';
import * as esm from '@cardbush/bush-protocol/conversational-subagent-tools';

const cjs = createRequire(import.meta.url)('@cardbush/bush-protocol/conversational-subagent-tools');

test('text and voice resolve the same conversational tool contracts through ESM and CommonJS', () => {
  assert.equal(protocol.conversationalSubagentInput, esm.conversationalSubagentInput,
    'the protocol root must share the ESM schema instance rather than load a second Zod runtime');
  assert.deepEqual(esm.conversationalSubagentTools, cjs.conversationalSubagentTools);
  assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
  for (const entry of [esm, cjs]) {
    assert.deepEqual(entry.conversationalSubagentInput.parse({ prompt: '  Inspect the selected page.  ' }),
      { prompt: 'Inspect the selected page.' });
    assert.deepEqual(entry.conversationalSubagentInput.parse({ prompt: 'Continue', task_id: 'child-1' }),
      { prompt: 'Continue', task_id: 'child-1' });
    assert.deepEqual(entry.conversationalAwaitInput.parse({}), {}, 'omitted task_ids means all owned tasks');
    assert.deepEqual(entry.conversationalAwaitInput.parse({ task_ids: ['child-1'] }), { task_ids: ['child-1'] });
    assert.deepEqual(entry.conversationalReadInput.parse({ task_id: 'child-1', cursor: '12:34' }),
      { task_id: 'child-1', cursor: '12:34' });
    assert.equal(entry.conversationalSubagentInput.safeParse({ prompt: ' ' }).success, false);
    assert.equal(entry.conversationalAwaitInput.safeParse({ task_ids: [''] }).success, false);
    assert.equal(entry.conversationalAwaitInput.safeParse({ task_ids: Array(9).fill('child-1') }).success, false);
    assert.equal(entry.conversationalAwaitInput.safeParse({ unexpected: true }).success, false);
    assert.equal(entry.conversationalReadInput.safeParse({ task_id: 'child-1', cursor: 'invalid' }).success, false);
  }
});
