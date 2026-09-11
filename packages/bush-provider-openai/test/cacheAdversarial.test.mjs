import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { CacheChainTracker, executeModelRound, estimateContextPressure, ToolRegistry, registerMcpDiscovery } from '@cardbush/bush-runtime';
import { normalizeResponseStreamEvent, toResponsesCreateParams, OpenAIResponsesProvider } from '../dist/index.js';
import { estimateResponsesInputTokens } from '../dist/responsesInputEstimate.js';
import { responsesInputFingerprint } from '../dist/responsesInputFingerprint.js';

const base = modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
  model: 'protocol-fixture', messages: [{ role: 'user', content: 'Inspect the facts.' }], tools: [], maxOutputTokens: 128000,
  metadata: { contextWindowTokens: 400000 } });
const terminal = output => ({ type: 'response.completed', response: { id: 'response', output } });
const toolCall = { type: 'function_call', id: 'fc', call_id: 'read', name: 'read_file', arguments: '{}' };
const reasoning = { type: 'reasoning', id: 'rs', summary: [], content: [{ type: 'reasoning_text', text: 'Verified reasoning. '.repeat(6000) }] };
async function assistantFrom(output, initial = []) {
  const round = await executeModelRound({ async *stream(request) {
    const state = { requestId: request.requestId, sequence: 0, started: false };
    for (const event of [...initial, terminal(output)]) yield* normalizeResponseStreamEvent(event, state);
  } }, base);
  assert.equal(round.status, 'completed', JSON.stringify(round));
  return { role: 'assistant', content: round.text, reasoningContent: round.reasoning, toolCalls: round.toolCalls, providerReplay: round.providerReplay };
}

test('an incomplete terminal snapshot cannot erase streamed reasoning from a subsequent request', async () => {
  const text = 'Real streamed reasoning needed for the tool exchange.';
  for (const snapshot of [[toolCall], [{ type: 'reasoning', id: 'rs', summary: [] }, toolCall]]) {
    const assistant = await assistantFrom(snapshot, [{ type: 'response.reasoning_text.delta', output_index: 0,
      item_id: 'rs', content_index: 0, delta: text },
      { type: 'response.output_item.added', output_index: 1, item: { ...toolCall, arguments: '' } }]);
    const input = toResponsesCreateParams({ ...base, messages: [...base.messages, assistant] }).input;
    assert.equal(input.find(item => item.type === 'reasoning')?.content?.[0]?.text, text);
    assert.equal(input.filter(item => item.type === 'function_call').length, 1);
    assert.equal(assistant.reasoningContent, text);
  }
});

test('fallback estimation charges real wire reasoning once and excludes replay storage duplication', async () => {
  const assistant = await assistantFrom([reasoning, toolCall]);
  const messages = [...base.messages, assistant, { role: 'tool', toolCallId: 'read', content: 'Read succeeded.' }];
  const request = { ...base, messages };
  const wire = toResponsesCreateParams(request);
  assert.deepEqual(wire.input.slice(1, -1), [reasoning, toolCall]);
  const localEstimate = estimateResponsesInputTokens(wire);
  const provider = new OpenAIResponsesProvider({ apiKey: 'unused-fixture', baseURL: 'http://127.0.0.1:1' });
  assert.equal(await provider.estimateInputTokens(request), localEstimate, 'estimation performs no network call');
  const chained = { ...request, providerState: { strategy: 'response_chain', previousResponseId: 'stored', inputMessageOffset: 2 } };
  assert.equal(await provider.estimateInputTokens(chained), localEstimate, 'the estimate includes stored history, not just the delta');
  const pressure = estimateContextPressure(request, messages, undefined, { projectedInputTokens: localEstimate });
  assert.equal(pressure.estimatedPromptTokens, localEstimate);
  assert.equal(pressure.measurement, 'fallback_estimate');
  const canonicalOnly = messages.map(message => { const { providerReplay, ...rest } = message; return rest; });
  assert.equal(estimateContextPressure(request, messages).fallbackPromptTokens,
    estimateContextPressure(request, canonicalOnly).fallbackPromptTokens);
  assert.ok(Math.ceil(JSON.stringify(messages).length / 4) > localEstimate * 1.8);
});

test('image base64 length does not masquerade as millions of text tokens', () => {
  const input = size => [{ type: 'message', role: 'user', content: [{ type: 'input_image', detail: 'high', image_url: 'data:image/png;base64,' + 'A'.repeat(size) }] }];
  assert.equal(estimateResponsesInputTokens({ input: input(100), tools: [] }), estimateResponsesInputTokens({ input: input(1000000), tools: [] }));
});

const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const definition = { name: 'mcp__docs__read', description: 'Read docs', inputSchema: { type: 'object' } };
const search = (id, description = definition.description) => [
  { role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_search', argumentsText: '{"query":"docs"}' }] },
  { role: 'tool', toolCallId: id, content: JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's',
    matches: [{ ...definition, description, server: 'docs', tool: 'read', revision: description }], total: 1, more: false }) },
];
function request(messages) { return { ...base, tools: registry.definitions(), metadata: { ...base.metadata, mcpToolDiscovery: true }, messages }; }
function observe(tracker, req, mode = 'native') {
  const logical = tracker.observe(req);
  const params = toResponsesCreateParams(req, { toolSearchMode: mode, disableProviderState: true });
  const wire = tracker.observeProviderInput(responsesInputFingerprint(params, params, req.providerBinding));
  return { logical, wire, params };
}

test('overlapping discoveries stay append-only on the wire and through tracker persistence', () => {
  const tracker = new CacheChainTracker();
  const first = observe(tracker, request([...base.messages, ...search('one')]));
  const second = observe(new CacheChainTracker(JSON.parse(JSON.stringify(tracker.snapshot()))), request([...base.messages, ...search('one'), ...search('two')]));
  assert.equal(second.logical.frozenPrefixBreak, false);
  assert.equal(second.wire.frozenPrefixBreak, false);
  assert.deepEqual(second.params.input.slice(0, first.params.input.length), first.params.input);
});

test('schema replacement is an observable historical wire rewrite, even when Runtime history only appends', () => {
  const tracker = new CacheChainTracker();
  observe(tracker, request([...base.messages, ...search('one')]));
  const result = observe(tracker, request([...base.messages, ...search('one'), ...search('two', 'Updated schema contract')]));
  assert.equal(result.logical.frozenPrefixBreak, false);
  assert.equal(result.wire.frozenPrefixBreak, true, 'never whitelist this as a harmless tool-search append');
  assert.equal(result.wire.breakIndex, 2);
  assert.deepEqual(result.wire.changedParameters, []);
  assert.deepEqual(result.params.input.filter(item => item.type === 'tool_search_output').map(item => item.tools.length), [0, 1]);
});

test('capability projection and generation-parameter changes report their first boundary without raw facts', () => {
  const tracker = new CacheChainTracker();
  const req = request(base.messages);
  observe(tracker, req);
  const fallback = observe(tracker, req, 'function');
  assert.equal(fallback.logical.frozenPrefixBreak, false);
  assert.equal(fallback.wire.frozenPrefixBreak, true);
  assert.deepEqual(fallback.wire.changedParameters, ['tools']);
  const changed = observe(tracker, { ...req, reasoningEffort: 'high' }, 'function');
  assert.deepEqual(changed.wire.changedParameters, ['reasoning']);
  assert.equal(JSON.stringify(tracker.snapshot()).includes('Inspect the facts.'), false);
  assert.equal(changed.wire.breakIndex, 0);
});
