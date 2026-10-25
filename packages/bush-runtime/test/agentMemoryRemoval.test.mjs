import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AGENT_REGISTRY_COMMAND, registeredAgentSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, RegisteredAgentStore, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';

const role = { id: 'reviewer', name: 'Reviewer', system_prompt: 'Review verified evidence.', allowed_tools: [] };
const retiredTools = ['agent_memory_read', 'agent_memory_write'];
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-memory-removal-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-memory-removal-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

test('registered definitions reject removed memory settings on save and reload', async t => {
  const root = await temporary(t), store = new RegisteredAgentStore(root);
  assert.equal(Object.hasOwn(registeredAgentSchema.parse(role), 'memory'), false);
  for (const memory of ['user', 'project', 'local', 'none', null]) {
    assert.equal(registeredAgentSchema.safeParse({ ...role, memory }).success, false);
    await assert.rejects(async () => store.put({ ...role, memory }, 0), /memory/);
  }
  assert.deepEqual(await store.list(), []);
  const saved = await store.put(role, 0);
  const file = join(root, createHash('sha256').update(role.id).digest('hex') + '.json');
  await writeFile(file, JSON.stringify({ ...saved, definition: { ...saved.definition, memory: 'none' } }));
  await assert.rejects(new RegisteredAgentStore(root).list(), /memory/);
  await writeFile(file, JSON.stringify(saved));
  assert.deepEqual(await new RegisteredAgentStore(root).get(role.id), saved);
});

test('host has no private memory routes while shared habits, predictions and reference tools remain usable', async t => {
  const root = await temporary(t), registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry,
    provider: { async *stream() { throw Error('No model call expected'); } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const catalog = await host.sendCommand({ kind: 'runtime.get_tool_catalog', payload: {} });
  for (const name of retiredTools) assert.equal(catalog.some(tool => tool.name === name), false);
  for (const name of ['summary_for_user', 'check_habit', 'revise_memory', 'checkpoint_context', 'search_execution_history', 'read_conversation_history', 'remember_file', 'read_file_memos', 'remember_source', 'read_source_memos']) {
    assert.ok(registry.resolve(name), `${name} remains registered`);
  }
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 'turn',
    model: 'fixture', permissionMode: 'all_free', tools: catalog, messages: [{ role: 'user', content: 'Please use concise tables for comparisons.' }],
    metadata: { individuation: { habits: true, predictions: true }, autoMemoryEnabled: true, pluginAgentMemoryActive: true } };
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request() { throw Error('Unexpected permission'); } } });
  let serial = 0;
  const call = (name, args) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `call-${++serial}`, name, argumentsText: JSON.stringify(args) },
    { requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId, round: 1, ordinal: serial },
    undefined, { request, contextMessages: request.messages });
  for (const name of retiredTools) {
    assert.equal((await call(name, {})).kind, 'failed');
    const schema = await call('get_tool_schema', { name });
    assert.ok(schema.kind === 'failed' || !schema.result?.matches?.some(tool => tool.name === name));
  }
  const signal = await call('summary_for_user', {});
  assert.equal(signal.kind, 'returned'); assert.equal(signal.result.final_response, true);
  const written = await call('summary_for_user', { habit: { text: 'Use concise tables for comparisons.' }, prediction: { text: 'Compare the two options in a table.' } });
  assert.equal(written.kind, 'returned'); assert.equal(written.result.saved, true);
  assert.deepEqual(written.result.writes.map(item => item.category).sort(), ['habit', 'prediction']);
  const read = await call('check_habit', { mode: 'list' });
  assert.equal(read.kind, 'returned'); assert.equal(read.result.memories.length, 2);
  await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'save', definition: role, expected_revision: 0 } });
  const saved = await host.sendCommand({ kind: AGENT_REGISTRY_COMMAND, payload: { action: 'get', agent_id: role.id } });
  assert.equal(Object.hasOwn(saved.definition, 'memory'), false);
  assert.ok(!(await readdir(root)).includes('plugin-agent-memory'));
});

test('plugin Agent startup and restart do not load private notes or inject memory capabilities', async t => {
  const root = await temporary(t), project = join(root, 'project');
  const observed = [], profile = { id: 'demo:reviewer', pluginId: 'demo', root: project, name: 'reviewer',
    description: 'Review evidence', prompt: 'Review only the assigned evidence.', tools: [] };
  const legacyRoot = join(project, '.cardbush', 'agent-memory', `${profile.name}-${createHash('sha256').update(profile.id).digest('hex').slice(0, 12)}`);
  await mkdir(legacyRoot, { recursive: true });
  const note = join(legacyRoot, 'MEMORY.md'); await writeFile(note, 'RETIRED_PRIVATE_NOTE_MUST_NOT_ENTER_CONTEXT');
  for (const iteration of [1, 2]) {
    const registry = new ToolRegistry(), rounds = new Map();
    const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
      loadPluginExtensions: async () => ({ hooks: [], agents: [profile] }),
      provider: { async *stream(request) {
        const round = (rounds.get(request.sessionId) ?? 0) + 1; rounds.set(request.sessionId, round);
        const child = request.metadata.agentRole === 'child';
        if (child) observed.push(structuredClone(request));
        const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
        if (!child && round === 1) {
          yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `delegate-${iteration}`, nameDelta: 'subagent',
            argumentsDelta: JSON.stringify({ agent_type: profile.id, prompt: 'Review the assigned evidence.' }) };
          yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'tool_calls' };
        } else {
          yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Reviewed the assigned evidence.' };
          yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' };
        }
      } } });
    try {
      const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `r-${iteration}`, sessionId: `parent-${iteration}`, turnId: `turn-${iteration}`,
        model: 'fixture', permissionMode: 'all_free', tools: registry.definitions(), metadata: { projectDir: project },
        inputMessages: [{ messageId: `user-${iteration}`, message: { role: 'user', content: 'Delegate this review.' } }] });
      assert.equal(terminal.payload.status, 'completed');
    } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
  }
  assert.equal(observed.length, 2);
  for (const request of observed) {
    assert.ok(!request.tools.some(tool => retiredTools.includes(tool.name)));
    assert.ok(!request.messages.some(message => message.name?.startsWith('plugin_agent_memory')));
    assert.doesNotMatch(JSON.stringify(request.messages), /RETIRED_PRIVATE_NOTE_MUST_NOT_ENTER_CONTEXT/);
  }
  assert.equal(await readFile(note, 'utf8'), 'RETIRED_PRIVATE_NOTE_MUST_NOT_ENTER_CONTEXT');
  assert.ok(!(await readdir(root)).includes('plugin-agent-memory'));
});
