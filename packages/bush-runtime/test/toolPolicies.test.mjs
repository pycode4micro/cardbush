import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { registerBuiltinToolDisclosure, nativeToolInvocation } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { presentTool } from '../dist/toolPresentation.js';
import { resolvePluginForkRole, pluginAgentTools } from '../dist/pluginExtensions.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false };
const definition = name => ({ name, description: `Test ${name}`, inputSchema: { type: 'object', properties: {
  action: { enum: ['read', 'write'] }, content: { type: 'string' },
}, additionalProperties: false } });
const request = registry => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
  model: 'fixture', tools: registry.definitions(), messages: [], metadata: {}, permissionMode: 'all_free' });

test('presentation and direct routes belong to registrations, not tool names', async () => {
  const registry = new ToolRegistry();
  for (const name of ['team', 'tasks', 'terminal_poll']) registry.register({ definition: definition(name), manifest,
    decodeInput: x => x, execute: () => ({}) });
  let projected = 0;
  registry.register({ definition: definition('custom_reader'), manifest, directInvocation: true,
    projectModelDefinition: (tool, scope) => { projected++; return scope.canRecall ? presentTool(tool, { actions: ['read'], fields: ['action'] }) : tool; },
    decodeInput: x => x, execute: () => ({}) });
  registry.register({ definition: definition('unavailable_reader'), manifest,
    modelAvailable: () => false, decodeInput: x => x, execute: () => ({}) });
  registerBuiltinToolDisclosure(registry);
  const req = request(registry), before = structuredClone(req.tools), frozen = modelToolDefinitions(registry, req);
  assert.deepEqual(frozen.find(tool => tool.name === 'team').inputSchema.properties.action.enum, ['read', 'write']);
  assert.ok(frozen.some(tool => tool.name === 'terminal_poll'), 'a familiar name alone cannot hide an extension');
  assert.ok(!frozen.some(tool => tool.name === 'unavailable_reader'));
  assert.equal(frozen.find(tool => tool.name === 'custom_reader').inputSchema.properties.content, undefined);
  assert.equal(nativeToolInvocation(registry, 'custom_reader').tool, 'custom_reader');
  assert.equal(nativeToolInvocation(registry, 'team').tool, 'call_tool');
  const coordinator = new ToolExecutionCoordinator({ registry });
  const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c', name: 'call_tool',
    argumentsText: JSON.stringify({ name: 'custom_reader', arguments: {} }) },
  { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, undefined, { request: req, contextMessages: [] });
  assert.equal(result.error.code, 'tool_requires_direct_call');
  registry.resolve('custom_reader').projectModelDefinition = () => { throw new Error('Frozen catalog must not project again'); };
  req.metadata.builtinToolSchemas = {}; // Compaction clears receipts, never the presentation contract.
  assert.deepEqual(modelToolDefinitions(registry, req), frozen);
  assert.deepEqual(req.tools, before); assert.equal(projected, 1);
});

test('custom role declarations win over builtin role names without widening declared tool access', () => {
  assert.equal(resolvePluginForkRole([], 'demo', 'Plan').readOnly, true);
  assert.equal(resolvePluginForkRole([], 'demo', 'Explore').readOnly, true);
  assert.equal(resolvePluginForkRole([], 'demo').readOnly, false);
  assert.equal(resolvePluginForkRole([], 'demo', '').readOnly, false);
  for (const name of ['constructor', 'toString', 'unknown']) assert.throws(() => resolvePluginForkRole([], 'demo', name), /unavailable/);
  const profile = { id: 'demo:Plan', name: 'Plan', pluginId: 'demo', tools: ['read', 'write'], disallowedTools: ['write'], maxTurns: 7 };
  const resolved = resolvePluginForkRole([profile], 'demo', 'Plan');
  assert.equal(resolved.profile, profile); assert.equal(resolved.readOnly, false); assert.equal(resolved.maxTurns, 7);
  assert.deepEqual(pluginAgentTools(resolved.profile, ['read', 'write', 'unrelated']), ['read']);
});
