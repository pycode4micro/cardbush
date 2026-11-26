import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductAgentTurnRequest } from '../dist/index.js';

test('root and inherited child prompts use local first-use consent and reserve codes for manual or remote pairing', () => {
  const request = createProductAgentTurnRequest({ requestId: 'r', sessionId: 's', turnId: 't', messageId: 'm',
    createdAt: '2026-10-25T01:00:00Z', userText: '用 Edge 查看网页', model: 'fixture', tools: [],
    permissionMode: 'ask_for_approval', planEnabled: false });
  for (const messages of [request.prefixMessages, request.metadata.subagentChildPrefixMessages]) {
    const prompt = messages.map(message => message.content).join('\n');
    assert.match(prompt, /Local Chrome\/Edge first connects via user consent in the system dialog and extension, no pairing codes/);
    assert.match(prompt, /App\/CLI share persistent connections and auto-reconnect/);
    assert.match(prompt, /auto-reconnect without the desktop App/);
    assert.match(prompt, /\/browser pair chrome or \/browser pair edge is for manual\/remote pairing only/);
    assert.match(prompt, /remote Agents connect separately/);
    assert.match(prompt, /Never approve consent or ask for codes, even after disconnects/);
    assert.match(prompt, /CardBush tabs need a desktop bridge, no extension\/pairing/);
    assert.match(prompt, /Respect session\/browser\/profile choice; unavailable targets need re-selection/);
  }
});
