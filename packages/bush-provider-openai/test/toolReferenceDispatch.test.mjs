import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, portableToolName } from '@cardbush/bush-runtime';
import { AnthropicMessagesProvider, OpenAIChatCompletionsProvider, OpenAIResponsesProvider,
  InMemoryProviderCapabilityStore } from '../dist/index.js';

const mcpName = `mcp__${'long_plugin_'.repeat(6)}__status`, mcpAlias = portableToolName(mcpName);
const nativeName = `native_${'extension_'.repeat(8)}`, nativeAlias = portableToolName(nativeName);
const operations = [
  ['get_tool_schema', { name: mcpName }],
  ['call_tool', { name: mcpAlias, arguments: { literal: mcpAlias } }],
  ['start_mcp_tool', { name: mcpAlias, arguments: { literal: mcpAlias } }],
  [mcpAlias, { literal: mcpAlias }],
  ['run_tools', { code: `return await tools.call(${JSON.stringify(mcpAlias)}, {literal:${JSON.stringify(mcpAlias)}});` }],
  ['get_tool_schema', { name: nativeName }],
  ['call_tool', { name: nativeAlias, arguments: { literal: nativeAlias } }],
  ['get_tool_schema', { names: [mcpAlias] }],
  ['get_tool_schema', { name: mcpAlias }],
  ['call_tool', { name: mcpAlias, arguments: { literal: mcpAlias } }],
  ['update_task_plan', { nodes: [{ step: 'Verified', status: 'completed' }] }],
];
const sse = events => new Response(events.map(event => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
function messagesResponse(operation, id, signature) {
  const blocks = [{ type: 'thinking', thinking: 'Inspect the loaded definition', signature }, operation
    ? { type: 'tool_use', id, name: operation[0], input: operation[1] } : { type: 'text', text: 'Done' }];
  return sse([
    { type: 'message_start', message: { id: `message-${id}`, role: 'assistant', type: 'message', model: 'fixture', content: [],
      usage: { input_tokens: 100, output_tokens: 0 } } },
    ...blocks.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }]),
    { type: 'message_delta', delta: { stop_reason: operation ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}
function chatResponse(operation, id) {
  const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason }] });
  if (!operation) return sse([chunk({ role: 'assistant', content: 'Done' }), chunk({}, 'stop')]);
  const args = JSON.stringify(operation[1]), split = Math.floor(args.length / 2);
  return sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: operation[0], arguments: '' } }] }),
    ...[args.slice(0, split), args.slice(split)].map(argumentsText => chunk({ tool_calls: [{ index: 0, function: { arguments: argumentsText } }] })),
    chunk({}, 'tool_calls')]);
}
function responsesResponse(operation, id, body, terminalOnly) {
  const item = !operation ? { type: 'message', id: `item-${id}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Done', annotations: [] }] }
    : operation[0] === 'mcp_search' && body.tools.some(tool => tool.type === 'tool_search')
      ? { type: 'tool_search_call', id: `item-${id}`, call_id: id, execution: 'client', status: 'completed', arguments: operation[1] }
      : { type: 'function_call', id: `item-${id}`, call_id: id, name: operation[0], arguments: JSON.stringify(operation[1]), status: 'completed' };
  const events = [];
  if (!terminalOnly) {
    events.push({ type: 'response.output_item.added', output_index: 0,
      item: item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' } : item });
    if (item.type === 'function_call') {
      const split = Math.floor(item.arguments.length / 2);
      for (const delta of [item.arguments.slice(0, split), item.arguments.slice(split)]) events.push({
        type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta });
    }
    events.push({ type: 'response.output_item.done', output_index: 0, item });
  }
  return sse([...events, { type: 'response.completed', response: { id: `response-${id}`, created_at: 1, store: false,
    status: 'completed', output: [item], tools: body.tools, usage: null } }]);
}

for (const mode of ['messages', 'chat', 'responses-stream', 'responses-terminal', 'responses-portable']) {
  test(`${mode}: real host resolves tool-reference aliases without rewriting schemas, history or signed thinking`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cardbush-tool-reference-'));
    const registry = new ToolRegistry(), journal = new ToolExecutionStore(), bodies = [], signatures = new Map();
    const calls = [], nativeCalls = [];
    const definition = name => ({ name, description: 'Read fixture data', inputSchema: {
      type: 'object', required: ['literal'], additionalProperties: false, properties: { literal: { type: 'string' } } } });
    const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
    registry.register({ definition: definition(mcpName), manifest, decodeInput: value => value,
      execute: context => { calls.push(context.input); return { structuredContent: { status: 'done', literal: context.input.literal } }; },
      mcpHook: { server: 'fixture', tool: 'status', readOnly: true, call: async () => ({}) } });
    registry.register({ definition: definition(nativeName), manifest, deferredSchema: true, decodeInput: value => value,
      execute: context => { nativeCalls.push(context.input); return { ok: true }; } });
    const capabilityStore = new InMemoryProviderCapabilityStore();
    if (mode === 'responses-portable') capabilityStore.observe({ scope: 'fixture', model: 'fixture', capability: 'client_tool_search' }, { status: 'unsupported' });
    const config = { apiKey: 'fixture', capabilityStore, capabilityScope: 'fixture', fetch: async (url, init) => {
      if (String(url).endsWith('/input_tokens')) return Response.json({ object: 'response.input_tokens', input_tokens: 100 });
      const body = JSON.parse(init.body), previous = bodies.at(-1), history = body.messages ?? body.input;
      const toolNames = body.tools.map(tool => tool.function?.name ?? tool.name);
      assert.ok(toolNames.includes('call_tool'));
      assert.ok(toolNames.includes('get_tool_schema'));
      assert.equal(toolNames.includes('mcp_call'), false, 'new model catalogs advertise one gateway');
      if (mode.startsWith('responses') && mode !== 'responses-portable') {
        assert.ok(body.tools.some(tool => tool.type === 'tool_search'), 'native search remains enabled without a visible mcp_call');
      }
      if (previous) {
        assert.deepEqual(body.tools, previous.tools, 'recall never replaces top-level schemas');
        assert.equal(body.system, previous.system);
        const prefix = previous.messages ?? previous.input;
        assert.deepEqual(history.slice(0, prefix.length), prefix, 'model arguments and history remain append-only');
      }
      if (mode === 'messages') {
        const seen = [];
        for (const [index, message] of body.messages.entries()) for (const block of message.content) {
          if (block.type !== 'thinking') continue;
          seen.push(block.signature);
          assert.deepEqual({ tools: body.tools, system: body.system, messages: body.messages.slice(0, index) }, signatures.get(block.signature));
        }
        assert.deepEqual(seen, [...signatures.keys()], 'no original signature is dropped to conceal changed inputs');
      }
      const operation = operations[bodies.length], id = `call-${bodies.length}`, signature = `signature-${bodies.length}`;
      if (mode === 'messages') signatures.set(signature, { tools: body.tools, system: body.system, messages: body.messages });
      bodies.push(body);
      assert.ok(bodies.length <= operations.length + 3, 'no repeated tool failure loop');
      return mode === 'messages' ? messagesResponse(operation, id, signature)
        : mode === 'chat' ? chatResponse(operation, id)
        : responsesResponse(operation, id, body, mode === 'responses-terminal');
    } };
    const provider = mode === 'messages' ? new AnthropicMessagesProvider(config)
      : mode === 'chat' ? new OpenAIChatCompletionsProvider(config) : new OpenAIResponsesProvider(config);
    const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, toolExecutionStore: journal, provider });
    t.after(async () => {
      await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-tool-reference-'));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
      model: 'fixture', reasoningEffort: 'high', tools: registry.definitions(), permissionMode: 'all_free', metadata: { mcpToolDiscovery: true },
      prefixMessages: [{ role: 'system', content: 'Stable rules' }], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Inspect fixture tools' } }] });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
    assert.deepEqual(calls, Array.from({ length: 5 }, () => ({ literal: mcpAlias })), 'data strings stay untouched and each call executes once');
    assert.deepEqual(nativeCalls, [{ literal: nativeAlias }]);
    for (const [index, operation] of operations.entries()) {
      const record = journal.get('s', 't', `call-${index}`);
      assert.ok(record, operation[0]);
      assert.equal(record.outcome, 'returned', JSON.stringify(record));
      // call_tool records the actual native/MCP target under the wire call ID.
      if (operation[0] !== 'call_tool') assert.deepEqual(JSON.parse(record.toolCall.argumentsText), operation[1]);
    }
    assert.equal(journal.get('s', 't', `call-${operations.length - 1}`).result.plan.active, false);
    assert.ok(host.events('s', 't').filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind))
      .every(event => !event.payload.frozenPrefixBreak));
  });
}
