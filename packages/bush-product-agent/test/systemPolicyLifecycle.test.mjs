import assert from 'node:assert/strict';
import test from 'node:test';
import { CacheChainTracker, InMemoryRuntimeHost, SessionStore, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest, ROOT_AGENT_SYSTEM_PROMPT } from '../dist/index.js';

const now = '2026-10-16T08:00:00Z';
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: request.requestId, sequence, createdAt: now, kind, ...payload });

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
    return { host, store, request };
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
    assert.deepEqual(dispatched.metadata.systemPolicy, { id: 'cardbush.product', version: '6' });
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
  assert.equal(store.modelContract('new').version, '6');
});

test('the saved presentation survives changed client definitions, but never grants removed tools', async t => {
  const f = fixture(t), { host, store, request } = f.open();
  await host.runSessionTurn(request('first'));
  const original = structuredClone(f.observed.at(-1));
  const changed = request('changed');
  changed.prefixMessages[0].content = 'A different system policy from a newer client.';
  changed.metadata.systemPolicy.version = 'future';
  changed.tools.forEach(tool => { tool.description += ' A newer description.'; });
  await host.runSessionTurn(changed);
  assert.deepEqual(f.observed.at(-1).messages[0], original.messages[0]);
  assert.deepEqual(f.observed.at(-1).tools, original.tools);
  assert.equal(store.modelContract('policy').version, '6');

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

for (const legacyVersion of ['2', '3', '4', '5'])
test(`product policy upgrades v${legacyVersion} once at the next Turn boundary without restoring tool_summary`, async t => {
  const f = fixture(t);
  let { host, store, request } = f.open();
  const legacy = request('legacy');
  legacy.metadata.systemPolicy = { id: 'cardbush.product', version: legacyVersion };
  legacy.prefixMessages[0].content = legacyVersion === '2'
    ? 'Legacy policy: call summary_for_user with tool_summary after Tool work.'
    : legacyVersion === '3' ? 'Legacy policy: use summary_for_user only for enabled memory; otherwise reply directly after Tool work.'
      : legacyVersion === '4' ? 'Legacy policy: request a typed confirmation and assume the browser is connected.'
        : 'Legacy policy: use permission controls without describing invocation binding.';
  const oldSummary = legacy.tools.find(tool => tool.name === 'summary_for_user');
  if (['2', '3'].includes(legacyVersion)) oldSummary.description = legacyVersion === '2' ? 'Write tool_summary before finishing.' : 'Use only when there is new memory.';
  if (legacyVersion === '2') oldSummary.inputSchema.properties.tool_summary = { type: 'string' };
  await host.runSessionTurn(legacy);
  const oldTurn = structuredClone(store.snapshot('policy').turns[0]);
  f.plannedCalls.set('policy/upgrade', ['read_fixture', 'summary_for_user']);
  assert.equal((await host.runSessionTurn(request('upgrade'))).payload.status, 'completed');
  assert.equal(store.modelContract('policy').version, '6');
  assert.deepEqual(store.snapshot('policy').turns[0], oldTurn, 'migration never rewrites conversation facts');
  for (const observed of f.observed.filter(r => r.turnId === 'upgrade')) {
    assert.equal(observed.messages[0].content, ROOT_AGENT_SYSTEM_PROMPT);
    assert.match(observed.messages[0].content, /do not require a typed confirmation phrase/);
    assert.match(observed.messages[0].content, /Do not pre-approve it with request_permission/);
    assert.match(observed.messages[0].content, /use list_browsers/);
    assert.match(observed.messages[0].content, /get_user_directories/);
    assert.equal(observed.tools.find(tool => tool.name === 'summary_for_user').inputSchema.properties.tool_summary, undefined);
    assert.match(observed.tools.find(tool => tool.name === 'summary_for_user').description, /final-display signal is independent of memory settings/);
    assert.deepEqual(observed.tools.filter(tool => tool.name !== 'summary_for_user'), f.observed[0].tools.filter(tool => tool.name !== 'summary_for_user'));
    assert.equal(observed.metadata.subagentChildPrefixMessages[0].content, ROOT_AGENT_SYSTEM_PROMPT);
  }
  assert.equal(f.facts.filter(f => f.kind === 'model_contract_updated').length, 1);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  ({ host, store, request } = f.open());
  await host.runSessionTurn(request('after_upgrade_restart'));
  assert.equal(f.facts.filter(f => f.kind === 'model_contract_updated').length, 1);
  assert.equal(store.modelContract('policy').version, '6');
  const cache = host.events('policy', 'after_upgrade_restart').filter(e => e.kind === 'cache_chain_observed');
  assert.ok(cache.every(e => !e.payload.frozenPrefixBreak && !e.payload.parametersChanged));
  assert.throws(() => store.upgradeModelContract('policy', legacyVersion, store.modelContract('policy')), /current bound version/);
});
