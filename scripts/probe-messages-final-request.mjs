// Replays one fingerprint-verified, stopped child request. Never runs model tools.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { modelRequestSchema, providerStreamDiagnosticSchema } from '@cardbush/bush-protocol';
import { AnthropicMessagesProvider, ModelProviderRegistry } from '@cardbush/bush-provider-openai';

const id = process.argv[2];
assert.match(id ?? '', /^subagent_session_[a-f0-9-]+$/i, 'Pass the saved child session ID.');
const send = process.argv.includes('--send');
const root = resolve(process.env.CARDBUSH_PROBE_PROFILE || join(process.env.APPDATA, 'cardbush'));
const hash = value => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
const name = createHash('sha256').update(id).digest('hex');
const seedPath = join(root, 'runtime-state', 'subagent-context', name + '.json');
const journalPath = join(root, 'runtime-state', 'sessions', name + '.jsonl');
const seedBytes = await readFile(seedPath, 'utf8'), journalBytes = await readFile(journalPath, 'utf8');
const seed = JSON.parse(seedBytes);
const events = journalBytes.trim().split(/\r?\n/).map(line => {
  const row = JSON.parse(line); assert.equal(row.checksum, hash(row.event), 'Journal checksum'); return row.event;
});
const turns = events.filter(event => event.kind === 'turn_committed');
assert.equal(turns.length, 1, 'Only a single saved child turn is supported.');
const turn = turns[0].payload;
assert.equal(turn.status, 'stopped', 'Only replay a stopped request.');
const saved = turn.cacheChainState;
assert.equal(saved.providerInput.format, 'anthropic.messages.v1');
const request = modelRequestSchema.parse({ ...seed, protocol: 'bush.model_request.v1',
  messages: [...seed.prefixMessages, ...turn.messages.map(item => item.message)],
  tools: seed.metadata.mcpModelToolSnapshot.tools });
assert.deepEqual(request.messages.map(hash), saved.messageDigests, 'Original canonical context must match exactly.');
const models = JSON.parse(await readFile(join(root, 'product-host', 'config', 'models.json'), 'utf8'));
const model = models.models.find(item => item.id === request.providerBinding.bindingId);
assert.ok(model?.apiKey, 'The original model credentials are unavailable.');
assert.equal(model.apiProtocol, 'anthropic_messages');
const config = { adapter: model.apiProtocol, apiKey: model.apiKey, baseURL: model.baseURL,
  defaultHeaders: model.defaultHeaders ?? {}, anthropicThinkingMode: model.anthropicThinkingMode };
const registry = new ModelProviderRegistry();
const binding = registry.upsert({ protocol: 'bush.provider_binding_config.v1', bindingId: model.id, ...config }).binding;
assert.deepEqual(binding, request.providerBinding, 'Do not replay against a changed connection.');
const originalFetch = globalThis.fetch;
let requestCount = 0, wireEvents = 0, wireBytes = 0, lastWireAt = Date.now(), lastWireType, wireStopReason;
const counts = {}, safeUsage = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key, value]) =>
  ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].includes(key) && typeof value === 'number'));
const output = resolve('tmp', 'messages-replay-' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(output, { recursive: true });
const start = Date.now();
const log = (stage, payload = {}) => {
  const entry = { ...payload, at: new Date().toISOString(), elapsedMs: Date.now() - start, stage };
  appendFileSync(join(output, 'diagnostics.jsonl'), JSON.stringify(entry) + '\n');
  if (!['wire_event', 'provider_event'].includes(stage)) console.log(JSON.stringify(entry));
};
const provider = new AnthropicMessagesProvider({ ...config, fetch: async (url, init) => {
  assert.equal(++requestCount, 1, 'This probe permits exactly one real API call.');
  log('http_request');
  const response = await originalFetch(url, init);
  log('http_response', { status: response.status, contentType: response.headers.get('content-type') });
  if (!response.ok || !response.body) return response;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', cancelled = false;
  const inspect = chunk => {
    wireBytes += chunk.byteLength; lastWireAt = Date.now(); pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) { counts.keepalive = (counts.keepalive ?? 0) + 1; continue; }
      let value; try { value = JSON.parse(data); } catch { counts.unparsed = (counts.unparsed ?? 0) + 1; continue; }
      const type = ['ping', 'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop', 'error'].includes(value.type) ? value.type : 'unknown';
      wireEvents++; lastWireType = type; counts[type] = (counts[type] ?? 0) + 1;
      if (type === 'message_delta') wireStopReason = providerStreamDiagnosticSchema.shape.stopReason.safeParse(value.delta?.stop_reason).data ?? 'unknown';
      if (type !== 'content_block_delta' && type !== 'ping') log('wire_event', { type, stopReason: wireStopReason,
        usage: safeUsage(type === 'message_start' ? value.message?.usage : value.usage) });
    }
    assert.ok(pending.length < 4_000_000, 'Malformed SSE frame is too large for diagnostic parsing.');
  };
  return new Response(new ReadableStream({
    async pull(controller) {
      try { const next = await reader.read(); if (cancelled) return;
        if (next.done) { log('wire_eof', { pendingChars: pending.length }); controller.close(); }
        else { inspect(next.value); controller.enqueue(next.value); } }
      catch (error) { if (!cancelled) { log('wire_read_error', { errorName: error?.name }); controller.error(error); } }
    },
    async cancel() { cancelled = true; log('wire_cancel'); await reader.cancel(); },
  }), { status: response.status, headers: response.headers });
} });
await provider.estimateInputTokens(request, { onInputProjection: projection => {
  assert.deepEqual(projection.inputDigests, saved.providerInput.inputDigests, 'Every wire content block must match.');
  assert.deepEqual(projection.parameterDigests, saved.providerInput.parameterDigests, 'Every wire parameter must match.');
} });
log('verified', { sessionId: id, turnId: turn.turnId, model: request.model, round: saved.requestOrdinal,
  canonicalMessages: request.messages.length, wireBlocks: saved.providerInput.inputDigests.length, tools: request.tools.length,
  maxOutputTokens: request.maxOutputTokens, reasoningEffort: request.reasoningEffort, exactProjection: true, sendsRequest: send, executesTools: false });
if (send) {
  const controller = new AbortController();
  const deadline = setTimeout(() => { log('probe_deadline', { limitMs: 600_000 }); controller.abort(); }, 600_000);
  const monitor = setInterval(() => log('wire_progress', { wireBytes, wireEvents, lastWireType,
    idleMs: Date.now() - lastWireAt, stopReason: wireStopReason, counts }), 30_000);
  let terminal, usage, reasoningChars = 0, textChars = 0, toolCalls = 0;
  try {
    for await (const event of provider.stream(request, { signal: controller.signal,
      onStreamDiagnostic: payload => { providerStreamDiagnosticSchema.parse(payload); log(payload.stage === 'event' ? 'provider_event' : 'provider_' + payload.stage, payload); },
      onCompatibilityDiagnostic: payload => log('compatibility', { action: payload.action, code: payload.error?.code, status: payload.error?.status }),
    })) {
      if (event.kind === 'reasoning_delta') reasoningChars += event.delta.length;
      if (event.kind === 'text_delta') textChars += event.delta.length;
      if (event.kind === 'tool_call_delta') toolCalls++;
      if (event.kind === 'usage') { const { protocol, requestId, sequence, createdAt, kind, ...value } = event; usage = value; }
      if (['response_completed', 'response_failed'].includes(event.kind)) terminal = { kind: event.kind, finishReason: event.finishReason, code: event.code, retryable: event.retryable };
    }
  } finally { clearTimeout(deadline); clearInterval(monitor); }
  const summary = { terminal, usage, reasoningChars, textChars, proposedToolsNotExecuted: toolCalls,
    requestCount, wireBytes, wireEvents, wireStopReason, counts, elapsedMs: Date.now() - start };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2)); log('result', summary);
}
assert.equal(await readFile(seedPath, 'utf8'), seedBytes, 'Saved request remains untouched.');
assert.equal(await readFile(journalPath, 'utf8'), journalBytes, 'Original session remains untouched.');
console.log('Diagnostics: ' + output);
