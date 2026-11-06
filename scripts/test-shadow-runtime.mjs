import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import * as productAgent from '@cardbush/bush-product-agent';
import * as protocol from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ToolExecutionCoordinator, ToolRegistry } from '@cardbush/bush-runtime';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync('src/backend/shadowRuntime.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const projectionModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/backend/runtimeSessionMessageProjection.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: projectionModule, exports: projectionModule.exports,
  require: name => name === '@cardbush/bush-protocol' ? protocol : require(name) });
const associationModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/backend/historyToolAssociation.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: associationModule, exports: associationModule.exports });

function fixture({ legacyRuntime = false } = {}) {
  const requests = [], executed = [], hooks = [], sessions = new Map();
  const registry = new ToolRegistry();
  const register = (name, mutating, extras = {}) => registry.register({
    definition: { name, description: 'Frozen declaration: ' + name, inputSchema: { type: 'object' } },
    manifest: { effect_kind: mutating ? 'mutation' : 'observation', operation: 'fixture.' + name,
      risk: 'low', owner: 'fixture', dispatch_scope: 'resource', mutating },
    decodeInput: input => input,
    execute: () => { executed.push(name); return { ok: true }; },
    ...extras,
  });
  register('read_file', false);
  register('write_file', true);
  register('subagent', false);
  register('root_only', false, { visibleToChild: false });
  register('checkpoint_context', true);
  register('indirect', false, { delegatesToolExecution: true,
    execute: context => context.invokeTool('write_file', {}) });
  sessions.set('source', { sessionId: 'source', revision: 1, metadata: { projectDir: 'D:/fixture' },
    supersededMessageIds: [], turns: [{ turnId: 'source-turn', turnSequence: 1,
      messages: [{ messageId: 'original-input', message: { role: 'user', content: 'Original task' } },
        { messageId: 'original-result', message: { role: 'assistant', content: 'Original result' } }] }] });
  const client = {
    getSession: async id => sessions.get(id),
    getLiveSession: async id => structuredClone(sessions.get(id)),
    listSessionSummaries: async () => [...sessions.values()],
    listTurnToolExecutionSummaries: async ({ turnId }) => ['read', 'after-snapshot'].map(id => ({ turnId, toolCall: { id, name: 'read_file' } })),
    createSession: async input => sessions.set(input.sessionId, { ...input, revision: 1, turns: [], supersededMessageIds: [] }),
    deleteSession: async id => sessions.delete(id),
    updateSessionMetadata: async input => { Object.assign(sessions.get(input.sessionId), { metadata: input.metadata }); },
    getToolCatalogDetails: async () => registry.catalog(),
    getCapabilities: async () => legacyRuntime ? { features: [] } : new InMemoryRuntimeHost({
      provider: { async *stream() { throw Error('Unexpected live model call'); } },
    }).capabilities(),
    events: async function* () {},
    runSessionTurn: async request => {
      requests.push(request);
      const createdAt = new Date().toISOString();
      sessions.get(request.sessionId).turns.push({ turnId: request.turnId, messages: [
        { messageId: request.turnId, message: { role: 'assistant', content: 'Shadow answer' } },
      ] });
      return { kind: 'turn_terminal', createdAt, payload: { status: 'completed', finalMessageId: request.turnId } };
    },
  };
  const imports = {
    '@cardbush/bush-product-agent': productAgent,
    '@cardbush/bush-protocol': protocol,
    '../i18n': { uiText: () => key => key },
    '../features/settings/conversationStyle': { resolveConversationStyle: () => undefined },
    '../features/settings/individuation': { readIndividuation: () => undefined },
    './runtimeMessageVisibility': { isInternalRuntimeMessage: protocol.isInternalSessionMessage },
    './runtimeSessionMessageProjection': projectionModule.exports,
    './historyToolAssociation': associationModule.exports,
    './runtimeHistoryToolExecution': { runtimeHistoryToolExecution: record => ({ id: record.toolCall.id, turnId: record.turnId, name: record.toolCall.name, state: 'completed' }) },
    '../runtime-client/ElectronRuntimeSession': { createDesktopRuntimeSession: () => ({ client, dispose() {} }) },
    './runtimeChat': { resolveProductModel: async () => ({ model: 'fixture' }) },
  };
  const reload = () => {
    const module = { exports: {} };
    vm.runInNewContext(compiled, { module, exports: module.exports,
      require: name => imports[name] ?? require(name), crypto: { randomUUID }, AbortController, setTimeout,
    });
    return module.exports;
  };
  const shadow = reload();
  const coordinator = new ToolExecutionCoordinator({ registry,
    permissions: { request: async () => { throw Error('Unexpected permission request'); } },
    hooks: { before: async ({ toolCall }) => { hooks.push(toolCall.name); return { messages: [] }; },
      after: async () => ({ messages: [] }) },
  });
  const send = async (conversation, projectDir) => {
    await shadow.streamRuntimeShadowConversationMessage({ conversationId: conversation.id,
      content: 'Continue', clientMessageId: randomUUID(), modelConfig: { id: 'fixture' }, projectDir });
    return requests.at(-1);
  };
  const call = (turn, name) => coordinator.execute({ id: 'call-' + name, name, argumentsText: '{}' },
    { requestId: turn.requestId, sessionId: turn.sessionId, turnId: turn.turnId, round: 1, ordinal: 0 },
    undefined, { request: { ...turn, messages: [...turn.prefixMessages, ...turn.inputMessages.map(item => item.message)] }, contextMessages: [] });
  return { registry, shadow, sessions, send, call, executed, hooks, requests, reload };
}

for (const firstTurn of [true, false]) test(`Shadow freezes a running ${firstTurn ? 'first' : 'later'} Turn across completion and reload`, async () => {
  const f = fixture(), source = f.sessions.get('source');
  if (firstTurn) source.turns = [];
  const createdAt = new Date().toISOString(), turnSequence = firstTurn ? 1 : 2;
  const active = { turnId: 'running-turn', turnSequence, createdAt, supersededMessageIds: [],
    messages: [
      { role: 'user', content: 'Current task', images: [] },
      { role: 'assistant', content: 'Checked the file', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
      { role: 'tool', content: 'Frozen file result', toolCallId: 'read' },
    ].map((message, messageIndex) => ({ message, messageId: `active-${messageIndex}`, turnId: 'running-turn', turnSequence, messageIndex, createdAt })) };
  source.activeTurn = active;
  const conversation = await f.shadow.createRuntimeShadowConversation({ sessionId: 'source', sourceTurnId: active.turnId,
    clientConversationId: randomUUID(), mode: 'readonly' });
  assert.equal(conversation.sourceTurnId, active.turnId);
  assert.ok(conversation.sourceMessages.some(message => message.content === 'Current task'));
  assert.equal(JSON.stringify(conversation.sourceMessages.flatMap(message => message.toolExecutions ?? []).map(tool => tool.id)), '["read"]', 'tool cards include frozen receipts only');
  const before = await f.send(conversation);
  assert.ok(before.prefixMessages.some(message => message.content === 'Frozen file result'));
  source.turns.push({ ...active, messages: [...active.messages, { messageId: 'later', message: { role: 'assistant', content: 'Later final answer' } }] });
  delete source.activeTurn;
  source.revision++;
  source.supersededMessageIds = ['original-input'];
  const after = await f.send(conversation);
  assert.equal(JSON.stringify(after.prefixMessages), JSON.stringify(before.prefixMessages));
  const restored = f.reload();
  await restored.streamRuntimeShadowConversationMessage({ conversationId: conversation.id, content: 'Continue',
    clientMessageId: randomUUID(), modelConfig: { id: 'fixture' } });
  assert.equal(JSON.stringify(f.requests.at(-1).prefixMessages), JSON.stringify(before.prefixMessages));
  await restored.closeRuntimeShadowConversation(conversation.id);
});

test('selecting a historical Turn excludes a newer live Turn', async () => {
  const f = fixture();
  f.sessions.get('source').activeTurn = { turnId: 'newer-turn', messages: [], supersededMessageIds: [] };
  const conversation = await f.shadow.createRuntimeShadowConversation({ sessionId: 'source', sourceTurnId: 'source-turn', clientConversationId: randomUUID(), mode: 'readonly' });
  assert.equal(conversation.sourceTurnId, 'source-turn');
  assert.equal(conversation.raw.sourceActiveTurn, undefined);
  assert.equal((await f.send(conversation)).prefixMessages.at(-1).content, 'Original result');
  await f.shadow.closeRuntimeShadowConversation(conversation.id);
});

test('Shadow mode switches preserve declarations and enforce child state at execution', async () => {
  const f = fixture();
  let conversation = await f.shadow.createRuntimeShadowConversation({ sessionId: 'source', sourceTurnId: 'source-turn',
    clientConversationId: randomUUID(), mode: 'readonly' });
  const readonly = await f.send(conversation);
  assert.equal(JSON.stringify(readonly.tools), JSON.stringify(f.registry.definitions().sort((a, b) => a.name.localeCompare(b.name))));
  assert.equal(readonly.metadata.agentRole, 'child');
  assert.equal(readonly.inputMessages[0].message.visibility, 'internal');
  assert.match(readonly.inputMessages[0].message.content, /currently a child Agent.*read-only/s);
  assert.equal(readonly.inputMessages.at(-1).message.content, 'Continue');
  assert.equal(readonly.prefixMessages.at(-1).content, 'Original result');
  assert.equal(readonly.permissionMode, 'task_free');
  for (const [name, code] of [['write_file', 'shadow_read_only'], ['subagent', 'child_agent_dispatch_unavailable'], ['root_only', 'child_agent_tool_unavailable']]) {
    const outcome = await f.call(readonly, name);
    assert.equal(outcome.error.code, code);
    assert.match(outcome.error.message, /currently a child Agent/);
  }
  assert.equal((await f.call(readonly, 'indirect')).error.code, 'shadow_read_only');
  assert.deepEqual(f.executed, []);
  assert.deepEqual(f.hooks, [], 'rejected direct and indirect calls must not run hooks');
  assert.equal((await f.call(readonly, 'read_file')).kind, 'returned');
  assert.equal((await f.call(readonly, 'checkpoint_context')).kind, 'returned', 'context maintenance remains available');

  conversation = await f.shadow.updateRuntimeShadowConversationMode(conversation.id, 'fork');
  const fork = await f.send(conversation);
  assert.equal(JSON.stringify(fork.tools), JSON.stringify(readonly.tools), 'no declaration changes on a mode switch');
  assert.equal(JSON.stringify(fork.prefixMessages), JSON.stringify(readonly.prefixMessages), 'mode identity is appended to each new input');
  assert.match(fork.inputMessages[0].message.content, /Current mode: Fork/);
  assert.equal((await f.call(fork, 'write_file')).kind, 'returned');
  assert.equal((await f.call(fork, 'subagent')).error.code, 'child_agent_dispatch_unavailable');

  conversation = await f.shadow.updateRuntimeShadowConversationMode(conversation.id, 'readonly');
  assert.equal((await f.call(await f.send(conversation), 'write_file')).error.code, 'shadow_read_only');
  await f.shadow.closeRuntimeShadowConversation(conversation.id);
});

test('projectless Shadow Fork retains resource tools and reports the missing workspace on invocation', async () => {
  const f = fixture();
  f.sessions.get('source').metadata.projectDir = '';
  const conversation = await f.shadow.createRuntimeShadowConversation({ sessionId: 'source', clientConversationId: randomUUID(), mode: 'fork' });
  const request = await f.send(conversation);
  assert.ok(request.tools.some(tool => tool.name === 'write_file'));
  // Automatic Runtime workspace resolution must not bypass the attached-project boundary.
  request.metadata.projectDir = 'D:/automatic-workspace';
  assert.equal((await f.call(request, 'write_file')).error.code, 'shadow_workspace_required');
  assert.equal((await f.call(request, 'checkpoint_context')).kind, 'returned');
  await f.shadow.closeRuntimeShadowConversation(conversation.id);
});

test('new Shadow assets never start a Turn against an old host without execution enforcement', async () => {
  const f = fixture({ legacyRuntime: true });
  const conversation = await f.shadow.createRuntimeShadowConversation({ sessionId: 'source', clientConversationId: randomUUID(), mode: 'readonly' });
  await assert.rejects(f.send(conversation), { code: 'shadow_runtime_update_required' });
  assert.equal(f.requests.length, 0);
  await f.shadow.closeRuntimeShadowConversation(conversation.id);
});
