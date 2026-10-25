import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, ToolExecutionCoordinator } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';
import { mcpInputDecoder } from '../dist/inputValidation.js';

const schema = { type: 'object', properties: { uid: { type: 'string', pattern: '^cb_[0-9]+$' }, limit: { type: 'integer', minimum: 1 } }, required: ['uid'], additionalProperties: false };

test('MCP inputs are validated before approval and dispatch, with actionable structured feedback', async t => {
  const registry = new ToolRegistry(); let approved = 0, dispatched = 0;
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }), createClient: () => ({
    async connect() {}, async close() {}, getNegotiatedProtocolVersion: () => '2026-07-28',
    async listTools() { return { tools: [{ name: 'click', inputSchema: schema }] }; },
    async callTool() { dispatched++; return { content: [{ type: 'text', text: 'ok' }] }; },
  }) });
  t.after(() => manager.close());
  await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 's', revision: 1, servers: [{ id: 'browser',
    transport: { kind: 'stdio', command: 'fixture' }, defaultToolPolicy: { permission: 'ask' } }] });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { approved++; return { decision: 'allow', scope: 'once', grantedCapabilityIds: [] }; } } });
  const name = 'mcp__browser__click';
  const execute = input => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c', name, argumentsText: JSON.stringify(input) },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 });
  for (const input of [{}, { uid: 2 }, { uid: 'cb_1', limit: '3' }, { uid: 'cb_1', typo: true }, { name, arguments: { uid: 'cb_1' } }]) {
    const outcome = await execute(input);
    assert.equal(outcome.kind, 'failed');
    assert.equal(outcome.error.code, 'tool_arguments_schema_invalid');
    assert.equal(outcome.error.details.inputDispatched, false);
    assert.deepEqual(outcome.error.details.requiredFields, ['uid']);
    assert.equal(outcome.error.details.recovery.load.arguments.name, name);
    assert.match(outcome.error.message, /No tool was executed/);
  }
  assert.equal(approved, 0); assert.equal(dispatched, 0);
  await assert.rejects(registry.mcpHook('browser', 'click').call({ uid: 2 }, {
    timeoutMs: 1000, request: { requestId: 'r', sessionId: 's', turnId: 't', metadata: {} },
  }), error => error.code === 'tool_arguments_schema_invalid');
  assert.equal(dispatched, 0, 'trusted MCP hook entry points use the same schema validation');
  assert.equal((await execute({ uid: 'cb_1', limit: 3 })).kind, 'returned');
  assert.equal(approved, 1); assert.equal(dispatched, 1);
});

test('optional schemas cannot silently consume a dispatcher envelope or a misspelled filter', () => {
  const decode = mcpInputDecoder('mcp__browser__snapshot', { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false });
  assert.throws(() => decode({ name: 'mcp__browser__snapshot', arguments: { query: 'AI' } }), /call_tool envelope/);
  assert.throws(() => decode({ qurey: 'AI' }), /additional properties/);
  assert.deepEqual(decode({}), {});
  assert.deepEqual(decode({ query: 'AI' }), { query: 'AI' });
});

test('validation supports refs and unions without coercing, defaulting or mutating valid input', () => {
  const decode = mcpInputDecoder('nested', { type: 'object',
    $defs: { option: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }] } },
    properties: { option: { $ref: '#/$defs/option' }, scale: { type: 'number', default: 1 } }, required: ['option'] });
  const input = { option: 'auto', serverExtension: true };
  assert.equal(decode(input), input);
  assert.deepEqual(input, { option: 'auto', serverExtension: true });
  assert.throws(() => decode({ option: false }), /Invalid arguments/);
  const dispatchLike = mcpInputDecoder('nested', { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } } });
  assert.deepEqual(dispatchLike({ name: 'nested', arguments: {} }), { name: 'nested', arguments: {} });
  const open = mcpInputDecoder('open', { type: 'object', properties: { metadata: { type: 'object' } } });
  assert.deepEqual(open({ name: 'open', arguments: {} }), { name: 'open', arguments: {} }, 'a server can explicitly accept arbitrary fields; the host does not invent schema restrictions');
});

test('schema IDs do not reuse an earlier service revision and malformed schemas fail closed', () => {
  const old = mcpInputDecoder('a', { ...schema, $id: 'https://fixture.test/input' });
  const current = mcpInputDecoder('a', { ...schema, $id: 'https://fixture.test/input', required: ['limit'] });
  assert.deepEqual(old({ uid: 'cb_1' }), { uid: 'cb_1' });
  assert.throws(() => current({ uid: 'cb_1' }), /limit/);
  assert.deepEqual(current({ limit: 1 }), { limit: 1 });
  assert.throws(() => mcpInputDecoder('bad', { type: 'object', properties: { x: { $ref: '#/$defs/missing' } } })({}),
    error => error.code === 'mcp_input_schema_invalid' && error.details.inputDispatched === false);
});
