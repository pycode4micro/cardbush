import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AGENT_REGISTRY_COMMAND, agentToolActivity, modelRequestSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, modelReplayMessageHash } from '@cardbush/bush-runtime';
import { AnthropicMessagesProvider, toAnthropicMessagesParams } from '../dist/index.js';

const sse = blocks => new Response([
  { type: 'message_start', message: { id: 'response', role: 'assistant', type: 'message', model: 'fixture', content: [], stop_reason: null,
    usage: { input_tokens: 100, output_tokens: 1 } } },
  ...blocks.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const collect = async iterable => { const events = []; for await (const event of iterable) events.push(event); return events; };
const request = extra => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
  messages: [{ role: 'system', content: 'Stable rules' }, { role: 'user', content: 'Read the file' }],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }], ...extra });
function assistant(event, content, reasoningContent, toolCalls = []) {
  const message = { role: 'assistant', content, reasoningContent, toolCalls };
  message.providerReplay = { ...event.providerReplay, model: 'fixture', messageHash: modelReplayMessageHash(message) };
  return message;
}

test('Claude signed multi-round Team and employee configuration keeps the exact tools and history prefix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-anthropic-disclosure-'));
  const registry = new ToolRegistry(), journal = new ToolExecutionStore(), bodies = [], signatures = new Map();
  const workflow = { id: 'fixture-flow', name: 'Fixture workflow', nodes: [{ id: 'draft', agent_id: 'writer', prompt: 'Write a draft' }] };
  const operations = [['get_tool_schema', { name: 'team' }],
    ['call_tool', { name: 'team', arguments: { action: 'save', definition: workflow, expected_revision: 0 } }],
    ['get_tool_schema', { name: 'subagent' }],
    ['call_tool', { name: 'subagent', arguments: { action: 'save', expected_revision: 0,
      agent: { id: 'reviewer', name: 'Reviewer', system_prompt: 'Review the draft', allowed_tools: [], memory: 'user' } } }],
    ['team', { action: 'get', team_id: workflow.id }]];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    const body = JSON.parse(init.body), previous = bodies.at(-1);
    if (previous) {
      assert.deepEqual(body.tools, previous.tools, 'schema recall must not rewrite top-level declarations');
      assert.equal(body.system, previous.system);
      assert.deepEqual(body.messages.slice(0, previous.messages.length), previous.messages, 'history remains append-only');
    }
    const replayed = [];
    for (const [index, message] of body.messages.entries()) for (const block of message.content) {
      if (block.type !== 'thinking') continue;
      replayed.push(block.signature);
      const bound = signatures.get(block.signature);
      assert.ok(bound, 'every original signature is preserved');
      assert.deepEqual({ tools: body.tools, system: body.system, messages: body.messages.slice(0, index) }, bound);
    }
    assert.deepEqual(replayed, [...signatures.keys()], 'normal recall retains every signed thinking block instead of dropping it');
    const operation = operations[bodies.length], signature = `signature-${bodies.length}`;
    signatures.set(signature, { tools: body.tools, system: body.system, messages: body.messages });
    bodies.push(body);
    return sse([{ type: 'thinking', thinking: 'Check the current definition', signature }, operation
      ? { type: 'tool_use', id: `call-${bodies.length}`, name: operation[0], input: operation[1] }
      : { type: 'text', text: 'Saved' }]);
  } });
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, toolExecutionStore: journal, provider });
  t.after(async () => {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-anthropic-disclosure-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'save', expected_revision: 0,
    definition: { id: 'writer', name: 'Writer', system_prompt: 'Write from evidence', allowed_tools: [], memory: 'user' } } });
  for (const turnId of ['first', 'second']) {
    const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: turnId, sessionId: 's', turnId,
      model: 'fixture', reasoningEffort: 'high', tools: registry.definitions(), permissionMode: 'all_free',
      prefixMessages: [{ role: 'system', content: 'Stable rules' }], inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: turnId === 'first' ? 'Create the workflow' : 'Continue' } }] });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
    assert.ok(host.events('s', turnId).filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind)).every(event => !event.payload.frozenPrefixBreak));
  }
  assert.equal(bodies.length, 7);
  assert.ok(!bodies[0].tools.find(tool => tool.name === 'team').input_schema.properties.definition);
  const savedTeam = journal.get('s', 'first', 'call-2');
  assert.equal(savedTeam.toolCall.name, 'team');
  assert.deepEqual(agentToolActivity(savedTeam), { kind: 'team', action: 'save', id: workflow.id, name: workflow.name });
  assert.equal(journal.get('s', 'first', 'call-4').toolCall.name, 'subagent');
  assert.equal(journal.get('s', 'first', 'call-5').result.definition.id, workflow.id);
});

test('wire prefix binding drops only invalid thinking while preserving valid signatures and tool results', async () => {
  const original = request(), blocks = [{ type: 'thinking', thinking: 'Inspect', signature: 'signed' },
    { type: 'redacted_thinking', data: 'opaque' }, { type: 'text', text: 'Checking' },
    { type: 'tool_use', id: 'read', name: 'read_file', input: {} }];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => sse(blocks) });
  const output = await collect(provider.stream(original));
  const message = assistant(output.at(-1), 'Checking', 'Inspect', [{ id: 'read', name: 'read_file', argumentsText: '{}' }]);
  const follow = request({ messages: [...original.messages, message, { role: 'tool', toolCallId: 'read', content: 'File contents' }] });
  const before = structuredClone(follow);
  assert.deepEqual(toAnthropicMessagesParams(follow).messages[1].content, blocks);
  for (const changed of [
    { ...follow, tools: [{ ...follow.tools[0], description: 'Changed' }] },
    { ...follow, messages: [{ role: 'system', content: 'Changed' }, ...follow.messages.slice(1)] },
    { ...follow, messages: [follow.messages[0], { role: 'user', content: 'Edited' }, ...follow.messages.slice(2)] },
  ]) {
    const body = toAnthropicMessagesParams(changed);
    assert.deepEqual(body.messages[1].content, blocks.slice(2));
    assert.equal(body.messages[2].content[0].content[0].text, 'File contents');
  }
  assert.deepEqual(follow, before, 'durable conversation and signatures are unchanged');
});

test('a confirmed legacy prefix rejection recovers once and preserves that projection on later turns', async () => {
  const original = request(), old = { role: 'assistant', content: 'Checking', reasoningContent: 'Inspect',
    toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] };
  old.providerReplay = { format: 'anthropic.messages.v1', model: 'fixture', messageHash: modelReplayMessageHash(old), data: { content: [
    { type: 'thinking', thinking: 'Inspect', signature: 'legacy' }, { type: 'redacted_thinking', data: 'legacy-redacted' },
    { type: 'text', text: 'Checking' }, { type: 'tool_use', id: 'read', name: 'read_file', input: {} },
  ] } };
  const input = request({ messages: [...original.messages, old, { role: 'tool', toolCallId: 'read', content: 'Retained result' }] });
  const before = structuredClone(input), bodies = [], diagnostics = [];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (bodies.length === 1) return Response.json({ type: 'error', error: { type: 'invalid_request_error',
      message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Arbitrary diagnostic suffix.' } }, { status: 400 });
    assert.deepEqual(body.messages[1].content.map(block => block.type), ['text', 'tool_use']);
    assert.match(JSON.stringify(body.messages), /Retained result/);
    return sse([{ type: 'thinking', thinking: 'Continue', signature: 'current' }, { type: 'text', text: 'Done' }]);
  } });
  const output = await collect(provider.stream(input, { onCompatibilityDiagnostic: d => diagnostics.push(d) }));
  assert.equal(output.at(-1).kind, 'response_completed'); assert.equal(bodies.length, 2);
  assert.deepEqual(diagnostics.map(d => d.action), ['retry', 'recovered']);
  const current = assistant(output.at(-1), 'Done', 'Continue');
  await collect(provider.stream(request({ messages: [...input.messages, current, { role: 'user', content: 'Continue again' }] })));
  assert.equal(bodies.length, 3); assert.match(JSON.stringify(bodies[2].messages), /"signature":"current"/);
  assert.deepEqual(input, before);
});

test('unrelated signature and request errors never consume a prefix-repair retry', async () => {
  for (const message of ['Invalid `signature` in `thinking` block.', 'Invalid tool parameters']) {
    let calls = 0;
    const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => {
      calls++; return Response.json({ type: 'error', error: { type: 'invalid_request_error', message } }, { status: 400 });
    } });
    const output = await collect(provider.stream(request()));
    assert.equal(output.at(-1).kind, 'response_failed'); assert.equal(calls, 1);
  }
});
