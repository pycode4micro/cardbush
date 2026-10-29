import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteControlSchema, remoteInteractionSchema, supportsRemoteInteraction, validateRemoteResponse } from '../dist/index.js';

test('capability negotiation requires both the profile and supported version', () => {
  assert.equal(supportsRemoteInteraction({ profile: 'subagent-remote-proton', version: '0.1' }), true);
  assert.equal(supportsRemoteInteraction({ profile: 'subagent-remote-proton', version: '0.1', operations: ['observe'] }), true);
  assert.equal(supportsRemoteInteraction({ profile: 'subagent-remote-proton', version: '0.1', operations: ['invented'] }), false);
  assert.equal(supportsRemoteInteraction({ profile: 'subagent-remote-proton', version: '0.1', operations: 'observe' }), false);
  for (const value of [undefined, {}, { version: '0.1' }, { profile: 'other', version: '0.1' }, { profile: 'subagent-remote-proton', version: '0.2' }]) {
    assert.equal(supportsRemoteInteraction(value), false);
  }
});

const base = { contextId: 'conversation', taskId: 'run', interactionId: 'question', createdAt: '2026-10-29T00:00:00.000Z' };
const permission = { ...base, kind: 'permission', text: 'Write the approved report', actionDigest: 'sha256:' + 'a'.repeat(64),
  operations: ['file.write'], resources: [{ kind: 'workspace', value: 'delivery/report.md' }], authority: 'human_required', decisions: ['allow_once', 'deny'] };
const response = { kind: 'permission', interactionId: base.interactionId, decision: 'allow_once', actionDigest: permission.actionDigest };
test('questions accept words without menu options or any tool catalogue', () => {
  const question = remoteInteractionSchema.parse({ ...base, kind: 'question', text: 'Which publication date?', blocking: true });
  assert.deepEqual(question.suggestions, []);
  validateRemoteResponse(question, { kind: 'answer', interactionId: 'question', text: 'Use next Monday.' }, 'parent_delegate');
});
test('permissions cannot be granted by prose, changed digests or self-declared human identity', () => {
  assert.throws(() => validateRemoteResponse(permission, { kind: 'answer', interactionId: 'question', text: 'Approved' }, 'human'), /structured_permission/);
  assert.throws(() => validateRemoteResponse(permission, response, 'parent_delegate'), /human_authority/);
  assert.throws(() => validateRemoteResponse(permission, { ...response, actionDigest: 'sha256:' + 'b'.repeat(64) }, 'human'), /action_changed/);
  assert.throws(() => remoteControlSchema.parse({ profile: 'subagent-remote-proton', version: '0.1', contextId: 'conversation', taskId: 'run',
    operation: 'respond', messageId: 'reply', response: { ...response, authority: 'human' } }));
  validateRemoteResponse(permission, { ...response, decision: 'deny' }, 'parent_delegate');
  validateRemoteResponse({ ...permission, authority: 'parent_delegate' }, response, 'parent_delegate');
});
test('expiration, identities, strict operation kinds and bounded awaits are enforced', () => {
  assert.throws(() => validateRemoteResponse({ ...permission, expiresAt: '2026-10-29T00:01:00.000Z' }, response, 'human', Date.parse('2026-10-29T00:02:00Z')), /expired/);
  assert.throws(() => validateRemoteResponse(permission, { ...response, interactionId: 'another' }, 'human'), /mismatch/);
  const control = { profile: 'subagent-remote-proton', version: '0.1', contextId: 'conversation', taskId: 'run', operation: 'observe' };
  assert.equal(remoteControlSchema.parse(control).waitMs, 0);
  assert.throws(() => remoteControlSchema.parse({ ...control, waitMs: 30001 }));
  assert.throws(() => remoteControlSchema.parse({ ...control, tool: 'vendor_tool' }));
  assert.throws(() => remoteControlSchema.parse({ ...control, version: '2.0' }));
});
