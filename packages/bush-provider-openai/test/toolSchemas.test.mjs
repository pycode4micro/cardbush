import { legacyPlanDefinition, legacyRunToolsDefinition } from './fixtures/legacyBuiltinSchemas.mjs';
import { withToolDisplayTitle } from '@cardbush/bush-runtime';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CoordinationStore, ToolRegistry, ToolExecutionCoordinator, registerCoordinationTools } from '@cardbush/bush-runtime';
import { providerToolInputSchema } from '../dist/toolSchemas.js';

function fixture() {
  const registry = new ToolRegistry(), store = new CoordinationStore();
  registerCoordinationTools(registry, store);
  return { registry, store, tool: registry.resolve('update_task_plan') };
}

test('new plan schemas are portable at their source and preserve nested value constraints', () => {
  const { tool } = fixture(), before = structuredClone(tool.definition);
  assert.equal(before.inputSchema.type, 'object'); assert.equal(before.inputSchema.anyOf, undefined);
  const projected = providerToolInputSchema(tool.definition);
  assert.deepEqual(projected, withToolDisplayTitle(before).inputSchema);
  assert.deepEqual(projected.properties.updates.items.properties.waitingFor.type, ['string', 'null']);
  assert.equal(projected.properties.updates.items.properties.waitingFor.minLength, 1);
  assert.deepEqual(tool.definition, before);
});

test('known legacy wire projections preserve saved capabilities without modifying frozen definitions', () => {
  const { tool } = fixture(), saved = legacyPlanDefinition(tool.definition);
  delete saved.inputSchema.properties.nodes.items.properties.waitingKind;
  const before = structuredClone(saved), projected = providerToolInputSchema(saved);
  const { anyOf, ...envelope } = before.inputSchema;
  assert.deepEqual(projected, envelope);
  assert.equal(projected.properties.nodes.items.properties.waitingKind, undefined);
  assert.equal(projected.properties._display_title, undefined, 'no new field is inserted into the historical plan');
  assert.deepEqual(saved, before); assert.deepEqual(providerToolInputSchema(saved), projected);
});

test('compatibility never removes arbitrary unions or upgrades unfamiliar native declarations', () => {
  const { tool } = fixture();
  for (const name of ['mcp__server__update_task_plan', 'other_tool']) {
    const definition = { ...legacyPlanDefinition(tool.definition), name };
    assert.deepEqual(providerToolInputSchema(definition), definition.inputSchema);
  }
  const unfamiliar = legacyPlanDefinition(tool.definition); unfamiliar.inputSchema.anyOf.push({ type: 'null' });
  assert.deepEqual(providerToolInputSchema(unfamiliar), unfamiliar.inputSchema);
  const script = legacyRunToolsDefinition();
  assert.deepEqual(providerToolInputSchema(script), script.inputSchema);
  script.inputSchema.anyOf.push({ type: 'null' });
  assert.deepEqual(providerToolInputSchema(script), script.inputSchema);
  const codeOnly = { name: 'run_tools', description: 'Code only', inputSchema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } };
  assert.deepEqual(Object.keys(providerToolInputSchema(codeOnly).properties).sort(), ['_display_title', 'code']);
});

test('plan action rules are enforced locally before dispatch even when the provider sees a portable envelope', async () => {
  const { registry, store, tool } = fixture();
  assert.equal(providerToolInputSchema(tool.definition).anyOf, undefined);
  const coordinator = new ToolExecutionCoordinator({ registry,
    permissions: { request: async () => { throw new Error('No permission request expected'); } } });
  const run = input => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'plan-call', name: 'update_task_plan',
    argumentsText: JSON.stringify(input) }, { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 });
  const nodes = [{ id: 'first', step: 'Inspect', status: 'pending' }];
  const created = await run({ nodes });
  assert.equal(created.kind, 'returned');
  const before = structuredClone(store.getPlan('s'));
  for (const input of [{}, { action: 'get', nodes }, { action: 'get', expected_revision: 0 },
    { action: 'patch', updates: [] }, { action: 'patch', expected_revision: 1, nodes },
    { nodes, updates: [] }, { nodes, unknown: true }]) {
    const result = await run(input);
    assert.equal(result.kind, 'failed', JSON.stringify(input));
    assert.equal(result.error.code, 'tool_arguments_schema_invalid');
    assert.equal(result.execution.dispatch, 'not_started');
    assert.deepEqual(store.getPlan('s'), before, 'invalid input cannot mutate the plan');
  }
  assert.deepEqual((await run({ action: 'get' })).result, before);
  const patched = await run({ action: 'patch', expected_revision: before.revision, active: false,
    updates: [{ id: before.plan.nodes[0].id, status: 'completed' }] });
  assert.equal(patched.kind, 'returned', JSON.stringify(patched));
  assert.equal(patched.result.plan.nodes[0].status, 'completed');
});
