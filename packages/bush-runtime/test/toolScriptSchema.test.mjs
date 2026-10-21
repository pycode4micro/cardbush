import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { ToolRegistry, modelToolDefinitions } from '../dist/index.js';

const legacy = () => ({ name: 'run_tools', description: 'Saved method declaration', inputSchema: z.toJSONSchema(z.union([
  z.object({ code: z.string().min(1).max(64000) }).strict(), z.object({ script_id: z.string() }).strict(),
])) });
const requestWithSnapshot = tools => ({ sessionId: 's', turnId: 't', tools: [{ name: 'new_tool', description: 'Not part of the frozen catalog', inputSchema: { type: 'object' } }],
  metadata: { mcpModelToolSnapshot: { identity: JSON.stringify(['s', 't']), tools } } });

test('reading a recovered catalog never repairs or replaces its historical declarations', () => {
  const registry = new ToolRegistry(), original = [legacy(), { ...legacy(), name: 'other_tool' }];
  const before = structuredClone(original), request = requestWithSnapshot(original);
  const snapshot = request.metadata.mcpModelToolSnapshot;
  assert.deepEqual(modelToolDefinitions(registry, request), before);
  assert.deepEqual(original, before);
  assert.equal(request.metadata.mcpModelToolSnapshot, snapshot, 'read leaves the snapshot identity intact');
  assert.deepEqual(modelToolDefinitions(registry, request), before, 'repeated reads remain byte-stable');
});

test('valid code-only contracts and unfamiliar unions are not upgraded to newer tool capabilities', () => {
  const registry = new ToolRegistry();
  const codeOnly = { name: 'run_tools', description: 'Code-only contract', inputSchema: z.toJSONSchema(z.object({ code: z.string() }).strict()) };
  const unfamiliar = legacy(); unfamiliar.inputSchema.anyOf.push({ type: 'null' });
  for (const definition of [codeOnly, unfamiliar]) {
    const request = requestWithSnapshot([definition]);
    assert.deepEqual(modelToolDefinitions(registry, request), [definition]);
  }
});
