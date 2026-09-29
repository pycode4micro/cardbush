import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema, providerStreamDiagnosticSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { AnthropicMessagesProvider } from '../dist/index.js';
import { AnthropicStreamDiagnostics } from '../dist/anthropicStreamDiagnostics.js';

const request = () => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'request',
  sessionId: 'session', turnId: 'turn', model: 'fixture', maxOutputTokens: 128000, reasoningEffort: 'max',
  messages: [{ role: 'user', content: 'private prompt' }], tools: [] });
const start = { type: 'message_start', message: { id: 'private-id', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 20 } } };
const thinking = [
  start,
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private thought' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private signature' } },
  { type: 'content_block_stop', index: 0 },
];
const finish = (reason = 'end_turn') => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 100 } }, { type: 'message_stop' },
];
const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });

test('idle observations retain stop reason and usage without logging content or changing control flow', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const logs = [], monitor = new AnthropicStreamDiagnostics(value => { providerStreamDiagnosticSchema.parse(value); logs.push(value); });
  monitor.dispatch({ max_tokens: 128000, thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  for (const event of [...thinking, finish('max_tokens')[0]]) monitor.observe(event);
  t.mock.timers.tick(60_000);
  const idle = logs.at(-1);
  assert.equal(idle.stage, 'idle'); assert.equal(idle.idleMs, 60_000);
  assert.equal(idle.stopReason, 'max_tokens'); assert.equal(idle.outputTokens, 100);
  assert.equal(idle.inputTokens, 30); assert.equal(idle.messageStopReceived, false);
  assert.equal(idle.thinkingChars, 'private thought'.length);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
  monitor.observe({ type: 'message_stop' }); monitor.close();
  assert.equal(logs.at(-1).messageStopReceived, true);
  const count = logs.length; t.mock.timers.tick(90_000); assert.equal(logs.length, count, 'close removes timer');
});

test('max_tokens is logged before missing message_stop, then cancellation stays cancellation', async () => {
  const abort = new AbortController(), logs = [], events = [];
  const provider = new AnthropicMessagesProvider({ apiKey: 'private-key', fetch: async (_url, init) => {
    const data = await sse([...thinking, finish('max_tokens')[0]]).text();
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      init.signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  for await (const event of provider.stream(request(), { signal: abort.signal, onStreamDiagnostic(value) {
    logs.push(value);
    if (value.lastEventType === 'message_delta') queueMicrotask(() => abort.abort());
  } })) events.push(event);
  assert.ok(logs.some(log => log.stopReason === 'max_tokens' && log.outputTokens === 100 && !log.messageStopReceived));
  assert.equal(events.at(-1).code, 'request_aborted');
  assert.equal(logs.at(-1).stage, 'closed'); assert.equal(logs.at(-1).aborted, true);
  assert.equal(events.some(event => event.kind === 'response_completed' || event.kind === 'tool_call_delta'), false);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

for (const mode of ['complete', 'eof', 'error']) test('observations preserve provider behavior: ' + mode, async () => {
  const logs = [], outputs = [];
  const provider = new AnthropicMessagesProvider({ apiKey: 'private-key', fetch: async () => sse([
    ...thinking, ...(mode === 'complete' ? finish() : mode === 'error' ? [{ type: 'error', error: { type: 'overloaded_error', message: 'private error' } }] : []),
  ]) });
  for await (const event of provider.stream(request(), { onStreamDiagnostic: value => logs.push(value) })) outputs.push(event);
  assert.equal(logs.at(-1).stage, 'closed');
  assert.equal(logs.at(-1).messageStopReceived, mode === 'complete');
  if (mode === 'complete') assert.equal(outputs.at(-1).finishReason, 'stop');
  else assert.equal(outputs.at(-1).code, mode === 'eof' ? 'provider_stream_incomplete' : 'overloaded_error');
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

test('runtime records stream facts with round and attempt; they stay out of model input', async () => {
  const bodies = [];
  const registry = new ToolRegistry();
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return sse([...thinking,
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Done.' } },
      { type: 'content_block_stop', index: 1 }, ...finish()]);
  } });
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry, registerDefaultWorkspaceTools: false });
  try {
    const input = request();
    await host.runModelTurn(input);
    const events = host.events(input.sessionId, input.turnId);
    const diagnostics = events.filter(event => event.kind === 'provider_stream_diagnostic');
    assert.ok(diagnostics.some(event => event.payload.messageStopReceived && event.payload.outputTokens === 100));
    assert.ok(diagnostics.every(event => event.payload.round === 1 && event.payload.attempt === 1));
    assert.doesNotMatch(JSON.stringify(bodies), /provider_stream_diagnostic|elapsedMs|thinkingChars/);
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});
