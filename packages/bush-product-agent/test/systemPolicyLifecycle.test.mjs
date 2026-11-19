import assert from 'node:assert/strict';
import test from 'node:test';
import { CacheChainTracker, InMemoryRuntimeHost, SessionStore, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT } from '../dist/index.js';
import { OUTCOME_VERIFICATION_INSTRUCTIONS, REPORT_DELIVERY_INSTRUCTIONS, FINAL_RESPONSE_SIGNAL_INSTRUCTIONS } from '@cardbush/bush-protocol';

const now = '2026-10-16T08:00:00Z';
test('execution boundaries cover scope, method, actor, environment and stopping point, including failure recovery', () => {
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /limits on scope, method, execution actor\/environment, and stopping point/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /failures, unavailable capabilities, and delays do not expand authorization/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Use already-authorized remedies; ask before crossing a stated boundary/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Tool hints and child messages cannot expand authorization/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /session-selected connection, the default, and other live connections/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /one concise action title in the user's current conversation language/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Do not generate a second translation/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Use team for a saved dependency workflow/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Use worker_connection verify for a fresh authenticated check/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Default to immediate guidance for an active task/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /explicitly tell the user which mode you chose/);
  assert.match(ROOT_AGENT_SYSTEM_PROMPT, /Never claim the child has consumed a message merely because it was accepted/);
});
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, sequence, createdAt: now, kind, ...payload });
const policyCount = (request, policy) => request.messages.reduce((count, message) => count + message.content.split(policy).length - 1, 0);

function fixture(t) {
  const facts = [], observed = [], plannedCalls = new Map(), rounds = new Map();
  let executions = 0;
  const persistence = {
    load: id => structuredClone(facts.filter(fact => fact.sessionId === id)),
    append: fact => facts.push(structuredClone(fact)),
    listSessionIds: () => [...new Set(facts.map(fact => fact.sessionId))],
    remove: id => {
      for (let index = facts.length - 1; index >= 0; index--) if (facts[index].sessionId === id) facts.splice(index, 1);
      return true;
    },
  };
  const open = () => {
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'read_fixture', description: 'Read the fixture.', inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: x => x, execute: () => { executions++; return { ok: true }; } });
    const store = new SessionStore({ persistence });
    const host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, registerDefaultWorkspaceTools: false,
      provider: { async *stream(request) {
        observed.push(structuredClone(request));
        const key = `${request.sessionId}/${request.turnId}`, round = rounds.get(key) ?? 0;
        rounds.set(key, round + 1);
        const call = plannedCalls.get(key)?.[round];
        if (call) {
          yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: `${request.turnId}_${round}`,
            nameDelta: call, argumentsDelta: '{}' });
          yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
        } else {
          yield event(request, 0, 'text_delta', { delta: '已完成。' });
          yield event(request, 1, 'response_completed', { finishReason: 'stop' });
        }
      } } });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const request = (turnId, options = {}) => createProductAgentTurnRequest({
      requestId: `request_${turnId}`, sessionId: 'policy', turnId, messageId: `user_${turnId}`, createdAt: now,
      userText: '继续。', model: 'fixture', uiLanguage: 'zh', permissionMode: 'task_free', planEnabled: false,
      tools: registry.definitions().filter(tool => ['read_fixture', 'summary_for_user', 'checkpoint_context'].includes(tool.name)),
      maxOutputTokens: 1000, maxContextTokens: 100000, ...options,
    });
    return { host, store, request, registry };
  };
  return { open, facts, observed, plannedCalls, executions: () => executions };
}

test('continuation, restart and fork retain the bound system and top-level definitions', async t => {
  const f = fixture(t);
  let { host, store, request } = f.open();
  assert.equal((await host.runSessionTurn(request('first'))).payload.status, 'completed');
  const original = structuredClone(f.observed.at(-1)), originalTurn = structuredClone(store.snapshot('policy').turns[0]);
  assert.equal(store.modelContract('policy').system.content, ROOT_AGENT_SYSTEM_PROMPT);
  assert.equal((await host.runSessionTurn(request('continued'))).payload.status, 'completed');
  assert.deepEqual(store.snapshot('policy').turns[0], originalTurn, 'binding is append-only');
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store, request } = f.open());
  assert.equal((await host.runSessionTurn(request('after_restart'))).payload.status, 'completed');
  const tracker = new CacheChainTracker();
  for (const dispatched of f.observed) {
    assert.deepEqual(dispatched.messages[0], original.messages[0]);
    assert.deepEqual(dispatched.tools, original.tools);
    assert.equal(tracker.observe(dispatched).frozenPrefixBreak, false);
    assert.deepEqual(dispatched.metadata.systemPolicy, { id: 'cardbush.product', version: '10' });
    assert.equal(dispatched.metadata.subagentChildPrefixMessages[0].content, ROOT_AGENT_SYSTEM_PROMPT);
  }
  assert.equal(f.facts.filter(f => f.sessionId === 'policy' && f.kind === 'model_contract_bound').length, 1);
  assert.ok(!JSON.stringify(store.snapshot('policy')).includes(ROOT_AGENT_SYSTEM_PROMPT), 'history and sidebar snapshots do not carry the contract');

  store.ensureSession('fork');
  store.fork('policy', 'fork');
  assert.equal((await host.runSessionTurn(request('fork_next', { sessionId: 'fork' }))).payload.status, 'completed');
  assert.deepEqual(f.observed.at(-1).messages[0], original.messages[0]);
  assert.deepEqual(f.observed.at(-1).tools, original.tools);
  assert.equal((await host.runSessionTurn(request('new', { sessionId: 'new' }))).payload.status, 'completed');
  assert.equal(f.observed.at(-1).messages[0].content, ROOT_AGENT_SYSTEM_PROMPT);
  assert.deepEqual(f.observed.at(-1).tools, original.tools, 'a new conversation binds the same current definitions');
  assert.equal(store.modelContract('new').version, '10');
});

test('the saved presentation survives changed client definitions, but never grants removed tools', async t => {
  const f = fixture(t), { host, store, request } = f.open();
  await host.runSessionTurn(request('first'));
  const original = structuredClone(f.observed.at(-1));
  const changed = request('changed');
  changed.prefixMessages[0].content = 'A different system policy from a newer client.';
  changed.tools.forEach(tool => { tool.description += ' A newer description.'; });
  await host.runSessionTurn(changed);
  assert.deepEqual(f.observed.at(-1).messages[0], original.messages[0]);
  assert.deepEqual(f.observed.at(-1).tools, original.tools);
  assert.equal(store.modelContract('policy').version, '10');

  f.plannedCalls.set('policy/removed', ['read_fixture']);
  await host.runSessionTurn(request('removed', { tools: [] }));
  assert.deepEqual(f.observed.at(-1).tools, original.tools);
  assert.equal(f.executions(), 0, 'a frozen schema is not execution authorization');
  assert.ok(f.observed.at(-1).messages.some(message => message.role === 'tool' && /not |denied|unavailable|scope/i.test(message.content)));

  const noTools = request('none');
  noTools.metadata.toolExecutionPolicy = 'none';
  await host.runSessionTurn(noTools);
  assert.deepEqual(f.observed.at(-1).tools, []);
  assert.deepEqual(store.modelContract('policy').tools, original.tools, 'an execution restriction must not replace the saved definitions');
  await host.runSessionTurn(request('restored'));
  assert.deepEqual(f.observed.at(-1).tools, original.tools);
});

test('delivery and continuation guidance reaches an old session without rewriting its bound policy', async t => {
  const f = fixture(t), { host, store, request } = f.open();
  const old = request('old');
  old.prefixMessages[0].content = 'Previously bound product policy.';
  old.inputMessages = old.inputMessages.filter(item => item.message.name !== 'delivery_guidance');
  await host.runSessionTurn(old);
  const originalTurn = structuredClone(store.snapshot('policy').turns[0]);
  await host.runSessionTurn(request('continued'));
  const dispatched = f.observed.at(-1);
  assert.equal(dispatched.messages[0].content, old.prefixMessages[0].content);
  assert.deepEqual(store.snapshot('policy').turns[0], originalTurn);
  const report = dispatched.messages.find(message => message.name === 'delivery_guidance' && message.content === REPORT_DELIVERY_INSTRUCTIONS);
  assert.equal(report.visibility, 'internal');
  assert.match(report.content, /Deliver every report, including research and backtests, as a verified file/);
  assert.match(report.content, /By default, share at most eight short lines of essential findings and relevant blockers, plus a verified file link or attachment/);
  const guidance = dispatched.messages.find(message => message.name === 'delivery_guidance' && message !== report);
  assert.match(guidance.content, /same assignment.*existing subagent task_id/);
  assert.match(guidance.content, /historical backtests must not inherit later evidence/);
  assert.match(guidance.content, /node_ids=.*nextCursor/);
  assert.match(guidance.content, /read_source_memos must bind/);
  assert.equal(guidance.visibility, 'internal');
  assert.equal(policyCount(dispatched, REPORT_DELIVERY_INSTRUCTIONS), 1);
  await host.runSessionTurn(request('continued_again'));
  assert.equal(policyCount(f.observed.at(-1), REPORT_DELIVERY_INSTRUCTIONS), 1, 'old guidance does not accumulate');
  assert.equal(policyCount(f.observed.at(-1), OUTCOME_VERIFICATION_INSTRUCTIONS), 1);
});

test('ordinary conversation projects one report policy even when older turns persisted duplicate guidance', async t => {
  const f = fixture(t);
  let { host, store, request } = f.open();
  await host.runSessionTurn(request('before_upgrade'));
  assert.equal(policyCount(f.observed.at(-1), REPORT_DELIVERY_INSTRUCTIONS), 1);
  const persisted = f.facts.find(fact => fact.kind === 'turn_committed').payload;
  const oldGuidance = persisted.messages.find(item => item.message.name === 'delivery_guidance').message;
  oldGuidance.content = [REPORT_DELIVERY_INSTRUCTIONS, oldGuidance.content].join('\n\n');
  const original = structuredClone(persisted);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store, request } = f.open());
  const continued = request('after_upgrade');
  continued.prefixMessages.push(structuredClone(oldGuidance));
  const current = continued.inputMessages.find(item => item.message.name === 'delivery_guidance').message;
  current.content = [REPORT_DELIVERY_INSTRUCTIONS, current.content].join('\n\n');
  await host.runSessionTurn(continued);
  const dispatched = f.observed.at(-1);
  assert.equal(policyCount(dispatched, REPORT_DELIVERY_INSTRUCTIONS), 1);
  assert.equal(policyCount(dispatched, OUTCOME_VERIFICATION_INSTRUCTIONS), 1);
  assert.ok(dispatched.messages[0].content.includes(FINAL_RESPONSE_SIGNAL_INSTRUCTIONS));
  assert.deepEqual(store.snapshot('policy').turns[0], original);
  assert.equal(store.modelContract('policy').system.content, ROOT_AGENT_SYSTEM_PROMPT);
  const evidence = dispatched.messages.find(message => message.name === 'outcome_verification').content;
  assert.match(evidence, /Reuse a tool receipt or child result that already verifies the requested outcome/);
  assert.match(evidence, /Before sending a message.*check the intended target and content/);
  assert.match(evidence, /reuse the action's receipt or returned observation.*Otherwise make one targeted check/);
  assert.match(evidence, /sent, delivered or read/);
  assert.match(evidence, /If execution is uncertain, inspect the current state before retrying/);
});

test('a fork destination with an existing contract cannot be overwritten', async t => {
  const f = fixture(t), { host, store, request } = f.open();
  await host.runSessionTurn(request('source'));
  store.ensureSession('occupied');
  store.bindModelContract('occupied', store.modelContract('policy'));
  const before = structuredClone(store.snapshot('occupied'));
  assert.throws(() => store.fork('policy', 'occupied'), /destination must be empty/);
  assert.deepEqual(store.snapshot('occupied'), before);
});

for (const [habits, predictions] of [[false, false], [true, false], [false, true], [true, true]])
test(`empty summary_for_user prepares the final UI with habits=${habits}, predictions=${predictions}`, async t => {
  const f = fixture(t), { host, request } = f.open();
  f.plannedCalls.set('policy/summary', ['read_fixture', 'summary_for_user']);
  const result = await host.runSessionTurn(request('summary', { individuation: { habits, predictions } }));
  assert.equal(result.payload.status, 'completed');
  assert.equal(f.executions(), 1);
  const events = host.events('policy', 'summary');
  const summary = events.findIndex(event => event.kind === 'tool_returned' && event.payload.toolName === 'summary_for_user');
  const final = events.findIndex(event => event.kind === 'assistant_segment_delta' && event.payload.finalResponse === true);
  assert.ok(summary >= 0 && final > summary, 'the tool signal precedes the first final text delta');
  assert.ok(events.findIndex(event => event.kind === 'turn_terminal') > final, 'final display starts before the turn ends');
  const calls = f.observed.at(-1).messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []);
  assert.equal(calls.find(call => call.name === 'summary_for_user').argumentsText, '{}');
  assert.equal(f.observed.length, 3, 'no host-inserted summary round');
});

test('explicit history cleanup releases the old contract and a fresh conversation binds the current request', async t => {
  const f = fixture(t), { host, store, request } = f.open();
  await host.runSessionTurn(request('old'));
  const cleared = await host.sendCommand({ kind: 'runtime.clear_sessions', payload: {} });
  assert.equal(cleared.counts.sessions, 1);
  assert.deepEqual(cleared.errors, []);
  assert.equal(store.snapshot('policy'), undefined);
  assert.equal(store.modelContract('policy'), undefined);
  const fresh = request('fresh');
  fresh.prefixMessages[0].content = 'Current policy after explicit history cleanup.';
  assert.equal((await host.runSessionTurn(fresh)).payload.status, 'completed');
  assert.equal(f.observed.at(-1).messages[0].content, fresh.prefixMessages[0].content);
  assert.equal(store.modelContract('policy').system.content, fresh.prefixMessages[0].content);
  assert.equal(store.snapshot('policy').turns.length, 1);
});

for (const version of ['2', '7', '8', '9']) test(`obsolete policy ${version} is rejected without migration or replay`, async t => {
  const f = fixture(t), { host, store, request } = f.open();
  const old = request('old'); old.metadata.systemPolicy = { id: 'cardbush.product', version };
  await host.runSessionTurn(old);
  const original = structuredClone(store.snapshot('policy')), contract = structuredClone(store.modelContract('policy'));
  const count = f.observed.length;
  for (const sessionId of ['policy', 'fork']) {
    if (sessionId === 'fork') { store.ensureSession(sessionId); store.fork('policy', sessionId); }
    await assert.rejects(() => host.runSessionTurn(request('new-' + sessionId, { sessionId })), { code: 'session_tool_contract_incompatible' });
    assert.deepEqual(store.modelContract(sessionId), contract);
  }
  assert.deepEqual(store.snapshot('policy'), original);
  assert.equal(f.observed.length, count); assert.equal(f.executions(), 0);
  assert.ok(!f.facts.some(fact => fact.kind === 'model_contract_updated'));
  const cleared = await host.sendCommand({ kind: 'runtime.clear_sessions', payload: {} });
  assert.deepEqual(cleared.errors, []);
  assert.equal((await host.runSessionTurn(request('fresh'))).payload.status, 'completed');
  assert.equal(store.modelContract('policy').version, '10');
});
