import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductAgentTurnRequest } from '../dist/index.js';

test('root and inherited child prompts use local first-use consent and reserve codes for manual or remote pairing', () => {
  const request = createProductAgentTurnRequest({ requestId: 'r', sessionId: 's', turnId: 't', messageId: 'm',
    createdAt: '2026-10-25T01:00:00Z', userText: '用 Edge 查看网页', model: 'fixture', tools: [],
    permissionMode: 'task_free', planEnabled: false });
  for (const messages of [request.prefixMessages, request.metadata.subagentChildPrefixMessages]) {
    const prompt = messages.map(message => message.content).join('\n');
    assert.match(prompt, /local Chrome\/Edge.*user approves the first connection.*system dialog and extension; no pairing code is needed/);
    assert.match(prompt, /local App and CLI share connections and reconnect automatically after disconnects or restarts/);
    assert.match(prompt, /Chrome\/Edge work without the desktop App/);
    assert.match(prompt, /\/browser pair chrome or \/browser pair edge only for manual connection or remote Agent pairing/);
    assert.match(prompt, /remote Agents keep separate connections/);
    assert.match(prompt, /Do not request a new pairing code for a temporary disconnect/);
    assert.match(prompt, /or ask them to send pairing codes to the model/);
    assert.match(prompt, /Integrated CardBush tabs require a running desktop bridge, but no extension or pairing/);
  }
});
