import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator, runtimeExtensionOwner } from '../dist/index.js';

const create = api => {
  api.tools.register({
    definition: { name: 'extension_echo', description: 'Echo fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.echo', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
    registrationOwner: runtimeExtensionOwner('fixture'), decodeInput: input => input, execute: ({ input }) => input,
  });
  return { id: 'fixture', features: ['fixture_feature'], commands: { 'fixture.read': payload => payload } };
};

test('optional extension commands and catalog are absent until enabled; toggling is idempotent', async () => {
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, extensions: [{ create }] });
  assert.equal(registry.definitions().some(tool => tool.name === 'extension_echo'), false);
  assert.equal(host.capabilities().features.includes('fixture_feature'), false);
  await assert.rejects(host.sendCommand({ kind: 'fixture.read', payload: {} }), /not enabled/);
  for (const enabled of [true, true, false, false, true]) {
    host.setExtensionEnabled('fixture', enabled);
    assert.equal(registry.catalog().some(tool => tool.definition.name === 'extension_echo'), enabled);
    assert.equal(host.capabilities().supportedCommands.includes('fixture.read'), enabled);
    assert.equal(host.capabilities().features.filter(feature => feature === 'fixture_feature').length, enabled ? 1 : 0);
    assert.ok(registry.definitions().some(tool => tool.name === 'subagent'));
  }
  assert.deepEqual(await host.sendCommand({ kind: 'fixture.read', payload: { ok: true } }), { ok: true });
});

test('disabling an extension retains the handler frozen into an already admitted request', async () => {
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, extensions: [{ create, enabled: true }] });
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', messages: [], tools: registry.definitions(), metadata: {} };
  host.setExtensionEnabled('fixture', false);
  assert.equal(registry.definitions().some(tool => tool.name === 'extension_echo'), false);
  const coordinator = new ToolExecutionCoordinator({ registry });
  const outcome = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c', name: 'extension_echo', argumentsText: '{"ok":true}' },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, undefined, { request, contextMessages: [] });
  assert.equal(outcome.kind, 'returned');
  assert.deepEqual(outcome.result, { ok: true });
  const hidden = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c-hidden', name: 'extension_echo', argumentsText: '{}' },
    { requestId: 'r-new', sessionId: 's', turnId: 't-new', round: 1, ordinal: 0 }, undefined,
    { request: { ...request, tools: registry.definitions() }, contextMessages: [] });
  assert.equal(hidden.kind, 'failed', 'new requests cannot call the disabled extension by guessing its name');
});

test('extension composition rejects duplicate IDs and collisions with core or other extension commands', () => {
  const factory = (id, command) => () => ({ id, features: [], commands: { [command]: () => null } });
  for (const extensions of [
    [{ create: factory('', 'fixture.empty') }],
    [{ create: factory('one', 'runtime.get_capabilities') }],
    [{ create: factory('one', 'fixture.same') }, { create: factory('two', 'fixture.same') }],
    [{ create: factory('one', 'fixture.first') }, { create: factory('one', 'fixture.second') }],
  ]) assert.throws(() => new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false, extensions }), /conflicts|Duplicate|empty/);
});
