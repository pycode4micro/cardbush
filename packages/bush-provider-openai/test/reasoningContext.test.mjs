import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore, ToolRegistry, executeModelRound,
  projectContextCompactionMaintenanceMessages,
} from '@cardbush/bush-runtime';
import { normalizeResponseStreamEvent, OpenAIResponsesProvider, toResponsesCreateParams } from '../dist/index.js';

const reasoning = (id, text) => ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text }] });
const answer = (id, text) => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id, name, args) => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args), status: 'completed' });
const terminal = output => ({ type: 'response.completed', response: { id: 'fixture_response', created_at: 1, store: false, output, usage: null } });
const checkpointCall = item => item.type === 'function_call' && item.name === 'checkpoint_context';

// A strict thinking endpoint treats assistant messages/calls as genuine model
// output and requires their reasoning, including on a fresh transport chain.
function missingReasoning(input) {
  let hasReasoning = false;
  return input.some(item => {
    if (item.role === 'user' || item.type === 'function_call_output') hasReasoning = false;
    if (item.type === 'reasoning') hasReasoning = Boolean(item.content?.some(part => part.type === 'reasoning_text' && part.text));
    return (item.role === 'assistant' || item.type === 'function_call') && !hasReasoning;
  });
}

test('thinking endpoint resumes repeated compaction and durable history without synthetic assistant output', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-reasoning-context-'));
  const requests = [], rejected = [], failures = [], hosts = [], journals = [];
  let executed = 0, compactions = 0;
  const server = createServer(async (req, res) => {
    try {
      let content = ''; for await (const chunk of req) content += chunk;
      const body = JSON.parse(content);
      const pressure = body.input.some(item => typeof item.content === 'string' && item.content.startsWith('[context_pressure]'));
      if (req.url.endsWith('/input_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        const checkpointIndex = body.input.findLastIndex(checkpointCall);
        const readSinceCheckpoint = body.input.slice(checkpointIndex + 1).some(item => item.type === 'function_call' && item.name === 'fixture_read');
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: pressure ? 2900 : readSinceCheckpoint ? 2860 : 100 }));
        return;
      }
      requests.push(body);
      if (missingReasoning(body.input)) {
        rejected.push(body);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_request_error', message: 'The `reasoning_text` in the thinking mode must be passed back to the API.' } }));
        return;
      }
      let output;
      if (pressure) {
        compactions++;
        output = [reasoning(`rs_checkpoint_${compactions}`, 'Summarize the verified observations.'), call(`checkpoint_${compactions}`, 'checkpoint_context', {
          summaries: [], active_summary: `Completed ${compactions} observations. ${compactions === 1 ? 'Perform the second observation.' : 'Return the final answer.'}`,
        })];
      } else if (executed < 2) {
        output = [reasoning(`rs_read_${executed}`, 'Read the next fact.'), call(`read_${executed}`, 'fixture_read', {})];
      } else {
        output = [reasoning(`rs_answer_${requests.length}`, 'The observations are complete.'), answer(`answer_${requests.length}`, 'Finished.')];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(terminal(output))}\n\n`);
    } catch (error) { failures.push(error); res.destroy(); }
  });
  t.after(async () => {
    for (const host of hosts) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    for (const journal of journals) journal.close();
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-reasoning-context-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    assert.deepEqual(failures, []);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 2000 });
  const readTool = {
    definition: { name: 'fixture_read', description: 'Read a fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: input => input, execute: () => ({ observed: ++executed }),
  };
  const createHost = () => {
    const persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    journals.push(persistence);
    const host = new InMemoryRuntimeHost({ dataRoot: root, provider, sessionStore: new SessionStore({ persistence }),
      toolRegistry: new ToolRegistry().register(readTool), registerDefaultWorkspaceTools: false, maxAttempts: 1 });
    hosts.push(host); return host;
  };
  const turn = id => ({ protocol: 'bush.session_turn_request.v1', requestId: id, sessionId: 's', turnId: id, model: 'thinking-fixture',
    reasoningEffort: 'high', tools: [readTool.definition], prefixMessages: [], maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 },
    inputMessages: [{ messageId: `user_${id}`, message: { role: 'user', content: 'Inspect twice and report.' } }] });
  const first = createHost();
  const result = await first.runSessionTurn(turn('first'));
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.equal(compactions, 2);
  assert.equal(executed, 2);
  assert.equal(requests.length, 5);
  const wireObservations = first.events('s', 'first').filter(event => event.kind === 'provider_input_observed');
  assert.equal(wireObservations.length, 5);
  assert.deepEqual(wireObservations.map(event => event.payload.frozenPrefixBreak), [false, false, true, false, true]);
  assert.ok(wireObservations.every(event => event.payload.changedParameters.length === 0));
  const continued = requests.at(-1);
  assert.equal(continued.previous_response_id, undefined);
  assert.equal(continued.reasoning.effort, 'high');
  const checkpoints = continued.input.filter(checkpointCall);
  assert.equal(checkpoints.length, 1);
  assert.match(checkpoints[0].arguments, /Completed 2 observations/);
  assert.deepEqual(continued.input.find(item => item.type === 'reasoning'), reasoning('rs_checkpoint_2', 'Summarize the verified observations.'));
  assert.ok(continued.input.some(item => item.type === 'function_call_output' && item.call_id === checkpoints[0].call_id));
  assert.equal(continued.input.some(item => item.role === 'user' && /active_turn_checkpoint|turn_context_summary/.test(item.content)), false);
  await first.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  hosts.shift();
  journals.shift().close();
  const second = createHost();
  assert.equal((await second.runSessionTurn(turn('second'))).payload.status, 'completed');
  assert.equal(executed, 2, 'recovery must not repeat completed tools');
  const restoredWire = second.events('s', 'second').find(event => event.kind === 'provider_input_observed').payload;
  assert.equal(restoredWire.previousProjectionAvailable, true);
  assert.equal(restoredWire.frozenPrefixBreak, false);
  assert.deepEqual(requests.at(-1).input.slice(0, continued.input.length), continued.input, 'the compacted prefix survives finalization and restart');
  assert.deepEqual(rejected, []);
});

test('emergency maintenance preserves genuine reasoning and opaque replay while bounding only tool results', async () => {
  const items = [reasoning('rs_original', '真实思考🙂'.repeat(8000)), call('original_call', 'fixture_read', {})];
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'thinking-fixture', messages: [], tools: [] };
  const round = await executeModelRound({ async *stream(req) {
    yield* normalizeResponseStreamEvent(terminal(items), { requestId: req.requestId, sequence: 0, started: false });
  } }, request);
  assert.equal(round.status, 'completed');
  const original = { role: 'assistant', content: round.text, reasoningContent: round.reasoning, toolCalls: round.toolCalls, providerReplay: round.providerReplay };
  const messages = [original, { role: 'tool', toolCallId: 'original_call', content: 'large result '.repeat(8000) }];
  const canonical = structuredClone(messages);
  const projection = projectContextCompactionMaintenanceMessages({ messages, sessionId: 's', turnId: 't',
    pressure: { estimatedPromptTokens: 10000, usableInputTokens: 5000, fallbackScale: 1 } });
  assert.deepEqual(projection.messages[0], original);
  assert.ok(projection.compactedToolResults > 0);
  const wire = toResponsesCreateParams({ ...request, messages: projection.messages }).input;
  assert.deepEqual(wire.slice(0, items.length), items);
  assert.equal(missingReasoning(wire), false);
  assert.deepEqual(messages, canonical);
  const unchanged = projectContextCompactionMaintenanceMessages({ messages: [original], sessionId: 's', turnId: 't',
    pressure: { estimatedPromptTokens: 10000, usableInputTokens: 5000, fallbackScale: 1 } });
  assert.equal(unchanged.removedChars, 0, 'an irreducible request must fail locally instead of dropping required provider facts');
});
