import assert from 'node:assert/strict';
import test from 'node:test';
import { modelEventSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry } from '@cardbush/bush-runtime';
import { createModelProvider, modelProviderCapabilityScope, InMemoryProviderCapabilityStore } from '../dist/index.js';

const adapters = ['openai_responses', 'openai_chat_completions', 'anthropic_messages'];
const definition = { name: 'write_once', description: 'Record one authorized write', inputSchema: { type: 'object' } };

// The scenarios below are identical. Only these wire fixtures differ by protocol.
function wire(adapter, step) {
  const call = ['tool', 'invalid', 'incomplete', 'truncated'].includes(step);
  const args = step === 'invalid' || step === 'truncated' ? '{"unclosed_fixture_value":' : '{}';
  const callId = step === 'incomplete' ? '' : step === 'invalid' ? 'call-invalid' : 'call-1';
  const text = call ? 'Checking.' : 'Done.';
  let events;
  if (adapter === 'openai_responses') {
    const response = { id: 'fixture-response', model: 'fixture', created_at: 1, store: false,
      status: step === 'truncated' ? 'incomplete' : 'completed',
      ...(step === 'truncated' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: [
        { type: 'message', id: 'message-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
        ...(call ? [{ type: 'function_call', id: 'item-1', call_id: callId, name: 'write_once', arguments: args,
          status: step === 'truncated' ? 'incomplete' : 'completed' }] : []),
      ], usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } };
    events = [{ type: step === 'truncated' ? 'response.incomplete' : 'response.completed', response }];
  } else if (adapter === 'openai_chat_completions') {
    events = [{ id: 'fixture-response', model: 'fixture', choices: [{ index: 0, delta: { content: text,
      ...(call ? { tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'write_once', arguments: args } }] } : {}) },
      finish_reason: step === 'truncated' ? 'length' : call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } }];
  } else {
    events = [
      { type: 'message_start', message: { id: 'fixture-response', model: 'fixture', role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
      { type: 'content_block_stop', index: 0 },
      ...(call ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: callId, name: 'write_once', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      { type: 'message_delta', delta: { stop_reason: step === 'truncated' ? 'max_tokens' : call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
  }
  return new Response(events.map(event => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') +
    (adapter === 'openai_chat_completions' ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
}

function fixture(t, adapter, steps, denied = false) {
  const calls = [], requests = [], normalized = [], waits = [], sessions = new SessionStore();
  const controller = new AbortController();
  let executions = 0;
  const config = { adapter, apiKey: 'fixture', baseURL: 'https://opencode.ai/zen/go/v1' };
  const capabilityStore = new InMemoryProviderCapabilityStore();
  if (steps.includes('retry')) {
    // Test execution retries after wire capability negotiation has settled.
    // Responses' separate native-to-portable projection fallback has its own tests.
    capabilityStore.observe({ scope: modelProviderCapabilityScope(config), model: 'fixture', capability: 'responses_generation_compatibility' }, { status: 'supported' });
  }
  const provider = createModelProvider({ ...config, capabilityStore,
    fetch: async (url, init) => {
      assert.equal(new Headers(init.headers).get('x-opencode-session'), 'shared-loop');
      if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
      const step = steps[calls.length];
      assert.ok(step, `Unexpected additional generation: ${adapter}`);
      const body = JSON.parse(init.body);
      if (adapter === 'anthropic_messages') {
        assert.equal(body.messages.at(-1).role, 'user', 'Repair/continuation must not create assistant prefill');
        assert.doesNotMatch(body.system ?? '', /\[tool_call_repair\]/, 'Mid-turn notices must not rewrite the system prefix');
      }
      calls.push({ url: String(url), body });
      if (step === 'cancel') { controller.abort(); throw controller.signal.reason; }
      if (step === 'retry') return Response.json({ error: { type: 'overloaded_error', message: 'Temporary overload' } }, { status: 503 });
      return wire(adapter, step);
    } });
  const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, options) {
    const before = structuredClone(request); requests.push(before);
    const output = []; normalized.push(output);
    for await (const event of stream(request, options)) { modelEventSchema.parse(event); output.push(event); yield event; }
    assert.deepEqual(request, before, 'Wire projection cannot mutate canonical history or loop instructions');
  };
  const registry = new ToolRegistry().register({ definition,
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: () => ({ writes: ++executions }),
    ...(denied ? { authorize: () => ({ kind: 'deny', code: 'fixture_denied', message: 'Not authorized' }) } : {}),
  });
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry, sessionStore: sessions,
    registerDefaultWorkspaceTools: false, maxAttempts: 3, wait: async ms => { waits.push(ms); } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const run = (turnId = 'turn-1') => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1',
    requestId: turnId, sessionId: 'shared-loop', turnId, model: 'fixture', tools: registry.definitions(),
    permissionMode: 'all_free', maxOutputTokens: 8192,
    prefixMessages: [{ role: 'system', content: 'Stable rules' }],
    inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: turnId === 'turn-1' ? 'Write once' : 'Confirm the previous result' } }],
  }, { signal: controller.signal });
  return { run, host, sessions, calls, requests, normalized, waits, executions: () => executions };
}

for (const adapter of adapters) {
  test(`${adapter}: one Runtime owns tool execution, history and follow-up turns`, async t => {
    const f = fixture(t, adapter, ['tool', 'answer', 'answer']);
    assert.equal((await f.run()).payload.status, 'completed');
    assert.equal(f.executions(), 1);
    assert.equal(f.requests.length, 2);
    assert.deepEqual(f.requests[1].messages.slice(-2).map(m => m.role), ['assistant', 'tool']);
    assert.equal(f.requests[1].messages.at(-2).toolCalls[0].name, 'write_once');
    assert.match(f.requests[1].messages.at(-1).content, /"writes":1/);
    assert.equal(f.normalized[0].at(-1).finishReason, 'tool_calls');
    assert.equal(f.normalized[1].at(-1).finishReason, 'stop');
    assert.equal((await f.run('turn-2')).payload.status, 'completed');
    assert.equal(f.executions(), 1, 'Follow-up does not replay a completed mutation');
    const turns = f.sessions.snapshot('shared-loop').turns;
    assert.deepEqual(turns.map(turn => turn.status), ['completed', 'completed']);
    assert.equal(turns[0].messages.filter(item => item.message.role === 'tool').length, 1);
    assert.ok(f.requests[2].messages.some(m => m.role === 'tool' && m.content.includes('"writes":1')));
    assert.equal(f.host.events('shared-loop', 'turn-1').filter(e => e.kind === 'turn_terminal').length, 1);
  });

  test(`${adapter}: shared transport retry never re-executes a tool or rewrites history`, async t => {
    const f = fixture(t, adapter, ['tool', 'retry', 'answer']);
    assert.equal((await f.run()).payload.status, 'completed');
    assert.equal(f.executions(), 1); assert.equal(f.calls.length, 3);
    assert.deepEqual(f.requests[2], f.requests[1]);
    assert.deepEqual(f.calls[2].body, f.calls[1].body);
    assert.equal(f.waits.length, 1);
    assert.equal(f.host.events('shared-loop', 'turn-1').filter(e => e.kind === 'provider_retry').length, 1);
  });

  test(`${adapter}: incomplete tool identities use the common one-repair policy`, async t => {
    const f = fixture(t, adapter, ['tool', 'incomplete', 'answer']);
    assert.equal((await f.run()).payload.status, 'completed');
    assert.equal(f.executions(), 1); assert.equal(f.calls.length, 3);
    const repair = f.requests[2].messages.at(-1);
    assert.equal(repair.role, 'developer'); assert.equal(repair.name, 'tool_call_repair');
    assert.match(JSON.stringify(f.calls[2].body), /tool_call_repair/);
    assert.match(repair.content, /never repeat completed side effects/);
    assert.equal(f.requests[2].messages.at(-2).toolCalls.length, 0);
    assert.equal(f.host.events('shared-loop', 'turn-1').filter(e => e.kind === 'provider_retry' && e.payload.code === 'tool_call_validation_repair').length, 1);
  });

  test(`${adapter}: malformed arguments become the same factual tool failure`, async t => {
    const f = fixture(t, adapter, ['tool', 'invalid', 'answer']);
    assert.equal((await f.run()).payload.status, 'completed');
    assert.equal(f.executions(), 1); assert.equal(f.calls.length, 3);
    assert.match(f.requests[2].messages.at(-1).content, /tool_arguments_invalid_json/);
    assert.match(f.requests[2].messages.at(-2).toolCalls[0].argumentsText, /unclosed_fixture_value/);
    assert.match(JSON.stringify(f.calls[2].body), /tool_arguments_invalid_json/);
    assert.equal(f.host.events('shared-loop', 'turn-1').filter(e => e.kind === 'provider_retry').length, 0);
  });

  test(`${adapter}: Runtime permissions apply before any tool side effect`, async t => {
    const f = fixture(t, adapter, ['tool', 'answer'], true);
    assert.equal((await f.run()).payload.status, 'completed');
    assert.equal(f.executions(), 0);
    assert.match(f.requests[1].messages.at(-1).content, /fixture_denied/);
  });

  test(`${adapter}: an unconfirmed truncated call follows the shared output-limit stop`, async t => {
    const f = fixture(t, adapter, ['truncated']);
    const result = await f.run();
    assert.equal(result.payload.reason, 'model_output_limit_exceeded');
    assert.equal(f.executions(), 0); assert.equal(f.calls.length, 1);
    assert.equal(f.sessions.snapshot('shared-loop').turns[0].status, 'failed');
    assert.doesNotMatch(JSON.stringify(f.sessions.snapshot('shared-loop').turns[0].messages), /unclosed_fixture_value/);
  });

  test(`${adapter}: user cancellation stops the common loop without tools or retries`, async t => {
    const f = fixture(t, adapter, ['cancel']);
    assert.equal((await f.run()).payload.status, 'stopped');
    assert.equal(f.executions(), 0); assert.equal(f.calls.length, 1); assert.equal(f.waits.length, 0);
  });
}

test('protocol capability observations cannot leak between adapters', () => {
  const scopes = adapters.map(adapter => modelProviderCapabilityScope({ adapter, apiKey: 'fixture' }));
  assert.equal(new Set(scopes).size, 3);
  assert.equal(scopes[0], modelProviderCapabilityScope({ apiKey: 'fixture' }), 'Existing Responses capability identity stays stable');
});
