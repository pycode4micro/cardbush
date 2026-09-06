import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { configure, runTask } from './live.mjs';
import { OpenAIResponsesProviderRegistry } from '@cardbush/bush-provider-openai';

const task = { id: 'fake-provider', prompt: 'Finish the local test task.' };
test('saved product configuration preserves its endpoint and headers without exposing credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-benchmark-config-'));
  t.after(async () => {
    const delta = relative(resolve(tmpdir()), resolve(root));
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'models.json');
  const model = { id: 'default', model: 'test-model', apiKey: 'fixture-key-only', baseURL: 'https://provider.invalid/v1', defaultHeaders: { 'X-Fixture': 'fixture-header-only' } };
  await writeFile(path, JSON.stringify({ version: 1, defaultModelId: 'default', models: [model] }));
  const result = await configure({ config: path, model: 'test-model', reasoning: 'high', 'max-rounds': '2', 'timeout-ms': '1000', 'token-stop': '1000', 'max-output-tokens': '12800' });
  const expected = new OpenAIResponsesProviderRegistry().upsert({
    protocol: 'bush.provider_binding_config.v1', bindingId: 'coding-benchmark', adapter: 'openai_responses',
    apiKey: model.apiKey, baseURL: model.baseURL, defaultHeaders: model.defaultHeaders,
  });
  assert.deepEqual(result.binding, expected.binding);
  assert.equal(JSON.stringify(result.publicConfig).includes(model.apiKey), false);
  assert.equal(JSON.stringify(result.publicConfig).includes('fixture-header-only'), false);
  assert.equal(result.maxOutputTokens, 12800);
  assert.equal(result.publicConfig.maxOutputTokens, 12800);
});

async function run(t, stream, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-benchmark-test-'));
  t.after(async () => {
    const delta = relative(resolve(tmpdir()), resolve(root));
    assert.ok(delta && delta !== '..' && !delta.startsWith('..') && !isAbsolute(delta));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return runTask(task, root, join(root, 'runtime'), {
    model: 'test-model', reasoning: 'high', maxRounds: 4, timeoutMs: 5000, tokenStop: 10000,
    providers: { stream, countInputTokens: async () => undefined }, ...overrides,
  });
}
function events(request, payloads) {
  return payloads.map((payload, sequence) => ({
    protocol: 'bush.model_event.v1', requestId: request.requestId, sequence,
    createdAt: new Date().toISOString(), ...payload,
  }));
}

test('offline provider drives the live harness and records reported usage', async t => {
  const result = await run(t, async function* (request) {
    yield* events(request, [
      { kind: 'response_started' }, { kind: 'text_delta', delta: 'Done.' },
      { kind: 'usage', inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
      { kind: 'response_completed', finishReason: 'stop' },
    ]);
  });
  assert.equal(result.terminal, 'completed');
  assert.equal(result.modelRequests, 1);
  assert.equal(result.reportedTokens, 120);
  assert.equal(result.usage.cachedInputTokens, 30);
  assert.equal(result.humanInterventions, 0);
  assert.deepEqual(result.cleanup, { stoppedTerminals: 0, errors: [] });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  assert.equal(trace.requests[0].finishReason, 'stop');
  assert.deepEqual(trace.requests[0].usage, { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 });
});

test('request limit settles a continuing Tool loop without a second model call', async t => {
  let calls = 0;
  const stream = async function* (request) {
    calls += 1;
    yield* events(request, [
      { kind: 'response_started' },
      { kind: 'tool_call_delta', index: 0, toolCallId: 'list', nameDelta: 'terminal_list', argumentsDelta: '{}' },
      { kind: 'response_completed', finishReason: 'tool_calls' },
    ]);
  };
  const result = await run(t, stream, { maxRounds: 1 });
  assert.equal(calls, 1);
  assert.equal(result.stopReason, 'request_limit');
  assert.equal(result.terminal, 'stopped');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.usageMissingRequests, 1);
});

test('harness explicitly stops terminal processes it owns after model completion', async t => {
  let calls = 0;
  const stream = async function* (request) {
    calls += 1;
    yield* events(request, calls === 1 ? [
      { kind: 'response_started' },
      { kind: 'tool_call_delta', index: 0, toolCallId: 'start', nameDelta: 'terminal_exec',
        argumentsDelta: JSON.stringify({
          command: process.platform === 'win32' ? 'Start-Sleep -Seconds 300' : 'exec sleep 300',
          cwd: '.', yield_time_ms: 50, shell: process.platform === 'win32' ? 'powershell' : 'posix',
        }) },
      { kind: 'response_completed', finishReason: 'tool_calls' },
    ] : [{ kind: 'response_started' }, { kind: 'text_delta', delta: 'Done.' }, { kind: 'response_completed', finishReason: 'stop' }]);
  };
  const result = await run(t, stream);
  assert.equal(result.terminal, 'completed');
  assert.equal(result.toolFailures, 0);
  assert.equal(result.cleanup.stoppedTerminals, 1);
  assert.deepEqual(result.cleanup.errors, []);
});

test('reported token threshold prevents the next request after an overshooting response', async t => {
  const result = await run(t, async function* (request) {
    yield* events(request, [
      { kind: 'response_started' },
      { kind: 'tool_call_delta', index: 0, toolCallId: 'list', nameDelta: 'terminal_list', argumentsDelta: '{}' },
      { kind: 'usage', inputTokens: 90, outputTokens: 20 },
      { kind: 'response_completed', finishReason: 'tool_calls' },
    ]);
  }, { tokenStop: 100 });
  assert.equal(result.modelRequests, 1);
  assert.equal(result.reportedTokens, 110);
  assert.equal(result.stopReason, 'reported_token_threshold');
  assert.equal(result.terminal, 'stopped');
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  assert.equal(trace.stopReason, 'reported_token_threshold');
  assert.equal(trace.terminal.reason, 'turn_stop_requested');
  assert.equal(trace.requests.length, 1);
  assert.equal(trace.toolExecutions[0].toolCall.name, 'terminal_list');
});

test('the selected output allowance reaches dispatch and truncation remains diagnosable', async t => {
  let calls = 0;
  const result = await run(t, async function* (request) {
    assert.equal(request.maxOutputTokens, 12800);
    yield* events(request, calls++ === 0 ? [
      { kind: 'reasoning_delta', delta: 'private-reasoning-only' },
      { kind: 'usage', inputTokens: 100, outputTokens: 12800 },
      { kind: 'response_completed', finishReason: 'length' },
    ] : [{ kind: 'text_delta', delta: 'Done.' }, { kind: 'response_completed', finishReason: 'stop' }]);
  }, { maxOutputTokens: 12800, tokenStop: 50000 });
  const trace = JSON.parse(await readFile(result.tracePath, 'utf8'));
  assert.deepEqual(trace.requests.map(request => request.finishReason), ['length', 'stop']);
  assert.ok(trace.runtimeEvents.some(event => event.payload.code === 'model_output_limit_continuation'));
  assert.equal(result.terminal, 'completed');
});

test('diagnostic trace preserves failed edit arguments and the model-visible read without hidden reasoning', async t => {
  const source = 'const pattern = /\\d+/;\r\n';
  const oldText = source.replaceAll('\\', '\\\\');
  const calls = [
    ['write_file', { path: 'fixture.txt', content: source }],
    ['read_file', { path: 'fixture.txt' }],
    ['edit_file', { path: 'fixture.txt', old_text: oldText, new_text: 'changed' }],
  ];
  let index = 0;
  const result = await run(t, async function* (request) {
    const call = calls[index++];
    yield* events(request, call ? [
      { kind: 'response_started' },
      { kind: 'reasoning_delta', delta: 'hidden-reasoning-fixture' },
      { kind: 'tool_call_delta', index: 0, toolCallId: `call-${index}`, nameDelta: call[0], argumentsDelta: JSON.stringify(call[1]) },
      { kind: 'response_completed', finishReason: 'tool_calls' },
    ] : [{ kind: 'text_delta', delta: 'Done.' }, { kind: 'response_completed', finishReason: 'stop' }]);
  });
  const serialized = await readFile(result.tracePath, 'utf8');
  const trace = JSON.parse(serialized);
  assert.equal(serialized.includes('hidden-reasoning-fixture'), false);
  assert.ok(trace.requests[0].reasoningChars > 0);
  const failed = trace.toolExecutions.find(record => record.outcome === 'failed');
  assert.equal(failed.error.code, 'edit_old_text_not_found');
  assert.equal(JSON.parse(failed.toolCall.argumentsText).old_text, oldText);
  const read = trace.toolExecutions.find(record => record.toolCall.name === 'read_file');
  assert.equal(read.result.content, source);
  const visible = trace.requests[2].messages.find(message => message.role === 'tool' && message.toolCallId === read.toolCall.id);
  assert.equal(visible.content.slice(visible.content.indexOf('[content]\n') + '[content]\n'.length), source);
  assert.equal(trace.requests[2].outputToolCalls[0].argumentsText, failed.toolCall.argumentsText);
});

test('a permission request stops unattended evaluation without approving the action', async t => {
  const result = await run(t, async function* (request) {
    yield* events(request, [
      { kind: 'response_started' },
      { kind: 'tool_call_delta', index: 0, toolCallId: 'external', nameDelta: 'read_file',
        argumentsDelta: JSON.stringify({ path: fileURLToPath(new URL('./suite.mjs', import.meta.url)) }) },
      { kind: 'response_completed', finishReason: 'tool_calls' },
    ]);
  });
  assert.equal(result.stopReason, 'permission_required');
  assert.equal(result.permissionRequests, 1);
  assert.equal(result.humanInterventions, 0);
  assert.notEqual(result.terminal, 'completed');
  assert.notEqual(result.tools[0].outcome, 'returned');
});
