import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { CardbushAppsConfigStore, readCardbushSearchResultLimit } from '@cardbush/product-host';
import { InMemoryRuntimeHost, modelToolDefinitions, registerMcpDiscovery, registerSkillTools, ToolRegistry } from '@cardbush/bush-runtime';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

async function fixture(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'plugin-search-settings-'));
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(root.startsWith(parent + sep + 'plugin-search-settings-'));
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, 'apps.json'), store = new CardbushAppsConfigStore(path);
  const state = { commands: [], conflict: false };
  const api = await loadChatTranscript({ source: `export { savePluginSearchResultLimit } from ${JSON.stringify(resolve('src/backend/api.ts'))};`, globals: {
    structuredClone, AbortController, TextEncoder, TextDecoder, console, process: { env: { NODE_ENV: 'production' } },
    window: { setTimeout, clearTimeout, localStorage: { getItem: () => null }, cardbushDesktop: {
      productHostCommand: async command => {
        state.commands.push(command.kind);
        let value;
        if (command.kind === 'apps.get') value = await store.read();
        else if (command.kind === 'apps.update') {
          if (state.conflict) { state.conflict = false; await store.write({ ...await store.read(), serviceEnabled: false }); }
          value = await store.write(command.config);
        } else throw Error(`Unexpected command ${command.kind}`);
        return { protocol: 'cardbush.product_host_ipc.v1', ok: true, value };
      },
      runtime: { command: async () => { throw Error('Search settings must not request MCP synchronization'); } },
    } },
  } });
  return { root, hosts, path, store, state, api };
}

test('legacy settings default to 8; updates persist and preserve unrelated fields and revision conflicts', async t => {
  const { path, store, api, state } = await fixture(t);
  assert.equal(await readCardbushSearchResultLimit(), 8);
  assert.equal(await readCardbushSearchResultLimit(path), 8);
  const initial = await store.read();
  assert.equal(initial.searchResultLimit, 8);
  const legacy = { ...initial }; delete legacy.searchResultLimit;
  await writeFile(path, JSON.stringify(legacy));
  assert.equal((await store.read()).searchResultLimit, 8);
  assert.equal(await readCardbushSearchResultLimit(path), 8);
  const original = await store.write({ ...initial, proxy: { mode: 'system' }, plugins: initial.plugins.map(plugin => ({ ...plugin,
    config: { ...plugin.config, proxy: { mode: 'none' } },
  })) });
  const saved = await api.savePluginSearchResultLimit(13);
  assert.equal(saved.searchResultLimit, 13);
  assert.deepEqual((await store.read()).plugins, original.plugins);
  assert.deepEqual(structuredClone(saved.proxy), original.proxy);
  assert.equal(saved.serviceEnabled, original.serviceEnabled);
  assert.equal((await new CardbushAppsConfigStore(path).read()).searchResultLimit, 13);
  assert.equal(await readCardbushSearchResultLimit(path), 13);
  assert.deepEqual(state.commands, ['apps.get', 'apps.update'], 'saving a preference needs no runtime connection operation');
  const unrelated = { ...await store.read(), serviceEnabled: false }; delete unrelated.searchResultLimit;
  assert.equal((await store.write(unrelated)).searchResultLimit, 13, 'older writers preserve the saved count');
  state.conflict = true;
  await assert.rejects(() => api.savePluginSearchResultLimit(5), /configuration changed/i);
  assert.equal((await store.read()).searchResultLimit, 13);
  assert.equal((await store.read()).serviceEnabled, false);
});

test('invalid preferences cannot overwrite settings; corrupt stored values are reported rather than replaced', async t => {
  const { path, store, api } = await fixture(t);
  await api.savePluginSearchResultLimit(50);
  const original = await store.read(), bytes = await readFile(path, 'utf8');
  for (const invalid of [0, -1, 51, 2.5, NaN, Infinity, '8', null]) {
    await assert.rejects(() => api.savePluginSearchResultLimit(invalid));
    await assert.rejects(() => store.write({ ...original, searchResultLimit: invalid }));
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  await writeFile(path, JSON.stringify({ ...original, searchResultLimit: 0 }));
  await assert.rejects(() => readCardbushSearchResultLimit(path));
  await assert.rejects(() => store.read());
  await writeFile(path, '{');
  await assert.rejects(() => readCardbushSearchResultLimit(path));
});

test('saved default immediately affects both searches, overrides and pagination, without changing model tools or history', async t => {
  const { root, path, store, api, hosts } = await fixture(t);
  const skills = join(root, 'skills');
  await Promise.all(Array.from({ length: 52 }, async (_, i) => {
    const name = `search-fixture-${String(i).padStart(2, '0')}`, directory = join(skills, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Shared search fixture\n---\nRead the source first.`);
  }));
  const makeRuntime = (withSettings = true) => {
    const registry = new ToolRegistry();
    const loadSearchResultLimit = withSettings ? () => readCardbushSearchResultLimit(path) : undefined;
    registerSkillTools(registry, [skills], loadSearchResultLimit);
    // Verify the actual host option wires the MCP search registration too.
    hosts.push(new InMemoryRuntimeHost({ toolRegistry: registry, loadSearchResultLimit, dataRoot: root,
      registerDefaultWorkspaceTools: false, provider: { generate: async () => { throw Error('No API calls expected'); } },
    }));
    for (let i = 0; i < 52; i++) {
      const name = `search_fixture_${String(i).padStart(2, '0')}`;
      registry.register({ definition: { name: `mcp__fixture__${name}`, description: 'Shared search fixture', inputSchema: { type: 'object' } },
        manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
        decodeInput: input => input, execute: () => { throw Error('Discovery must not execute the target'); },
        mcpHook: { server: 'fixture', tool: name, call: async () => { throw Error('No MCP calls expected'); } },
      });
    }
    const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), messages: [{ role: 'user', content: 'Find relevant tools' }], metadata: { mcpToolDiscovery: true } };
    const search = (name, input = {}) => {
      const tool = registry.resolve(name);
      return tool.execute({ input: tool.decodeInput({ query: 'fixture', ...input }), turn: { request, contextMessages: request.messages } });
    };
    return { registry, request, search };
  };
  const runtime = makeRuntime(), originalTools = JSON.stringify(modelToolDefinitions(runtime.registry, runtime.request));
  const originalMessages = JSON.stringify(runtime.request.messages);
  for (const name of ['search_skills', 'mcp_search']) assert.equal((await runtime.search(name)).matches.length, 8);
  // Reuse registrations and the turn: a UI edit changes only subsequent tool results.
  for (const limit of [13, 1, 50, 8]) {
    await api.savePluginSearchResultLimit(limit);
    for (const name of ['search_skills', 'mcp_search']) {
      assert.equal((await runtime.search(name)).matches.length, limit);
      assert.equal((await runtime.search(name, { limit: 3 })).matches.length, 3);
    }
    assert.equal(JSON.stringify(modelToolDefinitions(runtime.registry, runtime.request)), originalTools);
    assert.equal(JSON.stringify(runtime.request.messages), originalMessages);
    assert.equal(JSON.stringify(modelToolDefinitions(runtime.registry, { ...runtime.request, turnId: `next-${limit}`, metadata: { mcpToolDiscovery: true } })), originalTools);
  }
  await api.savePluginSearchResultLimit(13);
  const first = await runtime.search('mcp_search'), second = await runtime.search('mcp_search', { offset: first.next_offset });
  assert.equal(first.next_offset, 13); assert.equal(second.next_offset, 26);
  assert.equal(new Set([...first.matches, ...second.matches].map(item => item.name)).size, 26);
  const last = await runtime.search('mcp_search', { offset: 50 });
  assert.equal(last.matches.length, 2); assert.equal(last.more, false);
  assert.equal((await runtime.search('mcp_search', { query: 'absent_query_xyz' })).matches.length, 0);
  assert.equal(first.matches[0].inputSchema, undefined);
  assert.equal((await runtime.search('search_skills')).matches[0].mainResource, join(skills, 'search-fixture-00', 'SKILL.md'));
  const restarted = makeRuntime();
  for (const name of ['search_skills', 'mcp_search']) {
    assert.equal((await restarted.search(name)).matches.length, 13);
    for (const limit of [0, -1, 51, 1.2, '5', null]) assert.throws(() => restarted.search(name, { limit }));
  }
  const standalone = makeRuntime(false);
  for (const name of ['search_skills', 'mcp_search']) assert.equal((await standalone.search(name)).matches.length, 8);
  // A complete load is a single exact tool and does not depend on search preferences.
  const config = await store.read(); await writeFile(path, JSON.stringify({ ...config, searchResultLimit: 0 }));
  for (const name of ['search_skills', 'mcp_search']) {
    await assert.rejects(() => runtime.search(name));
    assert.equal((await runtime.search(name, { limit: 2 })).matches.length, 2);
  }
  const loaded = await runtime.search('mcp_search', { action: 'load', query: first.matches[0].name });
  assert.equal(loaded.matches.length, 1); assert.deepEqual(loaded.matches[0].inputSchema, { type: 'object' });
});

test('asynchronous settings lookup does not use a tool removed while it was pending', async () => {
  const registry = new ToolRegistry(); let release;
  registerMcpDiscovery(registry, () => new Promise(resolve => { release = resolve; }));
  const name = 'mcp__fixture__removed';
  registry.register({ definition: { name, description: 'fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'test', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: input => input, execute: () => ({}), mcpHook: { server: 'fixture', tool: 'removed', call: async () => ({}) },
  });
  const tool = registry.resolve('mcp_search'), request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: {} };
  const pending = tool.execute({ input: tool.decodeInput({ query: 'fixture' }), turn: { request } });
  registry.resolve(name).sessionScope = 'other-session'; release(8);
  assert.deepEqual((await pending).matches, []);
});
