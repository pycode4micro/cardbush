import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT } from '../dist/index.js';
import { continueChildConversation } from '../../bush-runtime/dist/subagentConversation.js';

test('individuation changes append user context without altering system/tools or cache prefixes', async t => {
  const seen = [], registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      seen.push(structuredClone(request));
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 0, createdAt: new Date().toISOString(), kind: 'text_delta', delta: 'answer' };
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 1, createdAt: new Date().toISOString(), kind: 'response_completed', finishReason: 'stop' };
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const states = [undefined, { habits: true, predictions: false }, { habits: true, predictions: true }, { habits: false, predictions: false }];
  const requests = [];
  for (const [index, individuation] of states.entries()) {
    const request = createProductAgentTurnRequest({ requestId: `r${index}`, turnId: `t${index}`, messageId: `u${index}`,
      sessionId: 'prefs', createdAt: '2026-09-30T00:00:00Z', userText: 'continue', model: 'model', tools: registry.definitions(),
      permissionMode: 'task_free', planEnabled: false, individuation });
    requests.push(request);
    assert.equal((await host.runSessionTurn(request)).payload.status, 'completed', 'done fallback remains functional without summary');
    const input = seen.at(-1);
    assert.deepEqual(request.prefixMessages, requests[0].prefixMessages);
    assert.deepEqual(input.tools, seen[0].tools, 'no settings-dependent tool filtering');
    assert.deepEqual(input.metadata.individuation, individuation ?? { habits: false, predictions: false });
    const preference = input.messages.filter(m => m.name === 'individuation_preference').at(-1);
    assert.equal(preference.role, 'user'); assert.equal(preference.visibility, 'internal');
    assert.match(preference.content, new RegExp(`habits ${individuation?.habits ? 'enabled' : 'disabled'}`));
    if (index) assert.deepEqual(input.messages.slice(0, seen[index - 1].messages.length), seen[index - 1].messages);
    assert.ok(host.events('prefs', request.turnId).filter(e => e.kind === 'cache_chain_observed').every(e => !e.payload.frozenPrefixBreak));
  }
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Before every final user-facing answer, call summary_for_user/);
  assert.equal(seen[0].tools.filter(t => ['summary_for_user', 'check_habit'].includes(t.name)).length, 2);
  const saved = { ...requests[2], metadata: { ...requests[2].metadata, agentRole: 'child' } };
  const continued = continueChildConversation(requests[3], saved);
  assert.deepEqual(continued.metadata.individuation, { habits: false, predictions: false }, 'child follow-up cannot retain stale enabled flags');
});
