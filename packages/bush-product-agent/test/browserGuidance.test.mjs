import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductAgentTurnRequest } from '../dist/index.js';

test('root and inherited child prompts use local first-use consent and reserve codes for manual or remote pairing', () => {
  const request = createProductAgentTurnRequest({ requestId: 'r', sessionId: 's', turnId: 't', messageId: 'm',
    createdAt: '2026-10-25T01:00:00Z', userText: '用 Edge 查看网页', model: 'fixture', tools: [],
    permissionMode: 'task_free', planEnabled: false });
  for (const messages of [request.prefixMessages, request.metadata.subagentChildPrefixMessages]) {
    const prompt = messages.map(message => message.content).join('\n');
    assert.match(prompt, /Local Chrome\/Edge first connects through user consent in the system dialog and extension, without pairing codes/);
    assert.match(prompt, /App\/CLI share persistent connections and reconnect automatically/);
    assert.match(prompt, /Chrome\/Edge does not require the desktop App/);
    assert.match(prompt, /\/browser pair chrome or \/browser pair edge only for manual or remote Agent pairing/);
    assert.match(prompt, /remote Agents connect separately/);
    assert.match(prompt, /Never approve consent for the user or ask for pairing codes, including after temporary disconnects/);
    assert.match(prompt, /Integrated CardBush tabs need a running desktop bridge, but no extension or pairing/);
    assert.match(prompt, /Respect session boundaries and the user's browser\/profile choice; unavailable targets need re-selection/);
  }
});
