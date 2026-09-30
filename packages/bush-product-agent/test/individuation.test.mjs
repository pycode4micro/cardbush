import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT } from '../dist/index.js';
import { continueChildConversation } from '../../bush-runtime/dist/subagentConversation.js';
import { normalizeIndividuation } from '@cardbush/bush-protocol';

test('individuation changes append user context without altering system/tools or cache prefixes', async t => {
  const seen = [], registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      seen.push(structuredClone(request));
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 0, createdAt: new Date().toISOString(), kind: 'text_delta', delta: 'answer' };
      yield { protocol: 'bush.model_event.v1', requestId: request.requestId, sequence: 1, createdAt: new Date().toISOString(), kind: 'response_completed', finishReason: 'stop' };
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const states = [undefined, { habits: true, predictions: false }, { habits: true, predictions: true }, { habits: false, predictions: false }, { habits: false, predictions: true }];
  const requests = [];
  for (const [index, individuation] of states.entries()) {
    const request = createProductAgentTurnRequest({ requestId: `r${index}`, turnId: `t${index}`, messageId: `u${index}`,
      sessionId: 'prefs', createdAt: '2026-09-30T00:00:00Z', userText: 'continue', model: 'model', tools: registry.definitions(),
      permissionMode: 'task_free', planEnabled: false, individuation });
    requests.push(request);
    assert.equal((await host.runSessionTurn(request)).payload.status, 'completed', 'ordinary conversation completes without summary');
    assert.equal(seen.length, index + 1, 'one direct model response per turn; no extra round to require summary');
    assert.equal(host.events('prefs', request.turnId).some(event => event.kind === 'tool_returned'), false, 'host does not insert a summary call');
    const input = seen.at(-1);
    assert.deepEqual(input.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls : []), [],
      'ordinary conversation has no tool invocations at all, including empty-argument summary calls');
    assert.deepEqual(request.prefixMessages, requests[0].prefixMessages);
    assert.deepEqual(input.tools, seen[0].tools, 'no settings-dependent tool filtering');
    assert.deepEqual(input.metadata.individuation, normalizeIndividuation(individuation));
    const preference = input.messages.filter(m => m.name === 'individuation_preference').at(-1);
    assert.equal(preference.role, 'user'); assert.equal(preference.visibility, 'internal');
    assert.match(preference.content, new RegExp(`habits ${individuation?.habits ? 'enabled' : 'disabled'}`));
    assert.match(preference.content, /When summary_for_user is available, call it once before the final reply after other Tool work/);
    assert.match(preference.content, /Ordinary conversation without Tool work may reply directly without calling it/);
    assert.match(preference.content, individuation?.habits || individuation?.predictions
      ? /optional habit field.*optional prediction field.*Each field follows its own enabled category.*If there is nothing new, use \{\}/
      : /Memory storage is disabled: use \{\}/);
    if (index) assert.deepEqual(input.messages.slice(0, seen[index - 1].messages.length), seen[index - 1].messages);
    assert.ok(host.events('prefs', request.turnId).filter(e => e.kind === 'cache_chain_observed').every(e => !e.payload.frozenPrefixBreak));
  }
  assert.doesNotMatch(ROOT_AGENT_SYSTEM_PROMPT, /Before every final user-facing answer, call summary_for_user/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /When summary_for_user is available and this turn has used other Tools, call it once/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Ordinary conversation without Tool work may reply directly without calling it/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /optional habit field.*optional prediction field/);
  const summaryDescription = seen[0].tools.find(tool => tool.name === 'summary_for_user').description;
  assert.match(summaryDescription, /the host neither inserts a call nor requires one to finish/);
  assert.match(summaryDescription, /When this turn has used other tools and the work is complete, call this once before the final reply/);
  assert.match(summaryDescription, /ordinary conversation without tool work, the agent may reply directly without invoking this tool/);
  assert.match(summaryDescription, /Disabled memory or nothing new to save does not prevent the final-display signal: use \{\}/);
  assert.match(summaryDescription, /Put supported, reusable user preferences or corrections in habit; put uncertain next-step needs in prediction/);
  assert.match(summaryDescription, /Each is independent, optional, and saved only when its own memory category is enabled/);
  assert.equal(seen[0].tools.filter(t => ['summary_for_user', 'check_habit'].includes(t.name)).length, 2);
  const saved = { ...requests[2], metadata: { ...requests[2].metadata, agentRole: 'child' } };
  const continued = continueChildConversation(requests[3], saved);
  assert.deepEqual(continued.metadata.individuation, normalizeIndividuation(), 'child follow-up cannot retain stale enabled flags');
});

test('tool work completes without summary even when both personalization features are enabled', async t => {
  const registry = new ToolRegistry();
  let executions = 0, rounds = 0;
  registry.register({ definition: { name: 'read_fixture', description: 'Read a test value', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'probe', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: input => input, execute: async () => { executions++; return { value: 'verified-value' }; } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      const event = (sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
        sequence, createdAt: new Date().toISOString(), kind, ...payload });
      rounds++;
      assert.ok(rounds <= 2, 'host must not add another round to require summary');
      if (rounds === 1) {
        yield event(0, 'tool_call_delta', { index: 0, toolCallId: 'fixture-call', nameDelta: 'read_fixture', argumentsDelta: '{}' });
        yield event(1, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        assert.match(request.messages.find(message => message.role === 'tool' && message.toolCallId === 'fixture-call').content, /verified-value/);
        yield event(0, 'text_delta', { delta: 'Verified value returned.' });
        yield event(1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const request = createProductAgentTurnRequest({ requestId: 'tool-choice', sessionId: 'tool-choice', turnId: 'work', messageId: 'user',
    createdAt: '2026-09-30T00:00:00Z', userText: 'Read the test value', model: 'model', tools: registry.definitions(),
    permissionMode: 'task_free', planEnabled: false, individuation: { habits: true, predictions: true } });
  assert.equal((await host.runSessionTurn(request)).payload.status, 'completed');
  assert.equal(executions, 1); assert.equal(rounds, 2);
  assert.deepEqual(host.events('tool-choice', 'work').filter(event => event.kind === 'tool_returned').map(event => event.payload.toolName), ['read_fixture']);
});
