import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { usageRecipeInvocationSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, modelToolDefinitions } from '../dist/index.js';

const legacy = () => ({ name: 'run_tools', description: 'Saved method declaration', inputSchema: z.toJSONSchema(z.union([
  z.object({ code: z.string().min(1).max(64000) }).strict(), z.object({ usage: usageRecipeInvocationSchema }).strict(),
])) });
const requestWithSnapshot = tools => ({ sessionId: 's', turnId: 't', tools: [{ name: 'new_tool', description: 'Not part of the frozen catalog', inputSchema: { type: 'object' } }],
  metadata: { mcpModelToolSnapshot: { identity: JSON.stringify(['s', 't']), tools } } });

test('recovered provider snapshots repair only the known malformed declaration and remain stable', () => {
  const registry = new ToolRegistry(), unrelated = { ...legacy(), name: 'other_tool' }, original = [legacy(), unrelated];
  const before = structuredClone(original), request = requestWithSnapshot(original);
  const repaired = modelToolDefinitions(registry, request);
  assert.deepEqual(repaired.map(tool => tool.name), ['run_tools', 'other_tool']);
  assert.equal(repaired[0].inputSchema.type, 'object'); assert.equal(repaired[0].inputSchema.anyOf, undefined);
  assert.deepEqual(repaired[0].inputSchema.$defs, before[0].inputSchema.$defs);
  assert.deepEqual(repaired[1], before[1]); assert.deepEqual(original, before, 'historical input is not mutated');
  assert.deepEqual(modelToolDefinitions(registry, request), repaired, 'subsequent requests reuse the same repaired schema');
});

test('valid code-only contracts and unfamiliar unions are not upgraded to newer tool capabilities', () => {
  const registry = new ToolRegistry();
  const codeOnly = { name: 'run_tools', description: 'Before usage support', inputSchema: z.toJSONSchema(z.object({ code: z.string() }).strict()) };
  const unfamiliar = legacy(); unfamiliar.inputSchema.anyOf.push({ type: 'null' });
  for (const definition of [codeOnly, unfamiliar]) {
    const request = requestWithSnapshot([definition]);
    assert.deepEqual(modelToolDefinitions(registry, request), [definition]);
  }
});
