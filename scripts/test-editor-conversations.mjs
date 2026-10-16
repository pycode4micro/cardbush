import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(path, deps = {}) {
  const exports = {};
  new Function('exports', 'require', ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(exports, id => deps[id] ?? require(id));
  return exports;
}
const workspace = load('src/features/conversationWorkspace.ts');
const { isVisibleConversationSession: visible } = load('src/backend/runtimeSessionVisibility.ts');
const hookSource = ts.createSourceFile('hook.ts', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const hook = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat');
const flush = () => new Promise(resolve => setImmediate(resolve));
test('shared input status distinguishes user interaction from ongoing work and completed replies', () => {
  const { quickInputState } = load('src/features/composer/quickInputState.ts');
  const idle = { language: 'zh', messages: [], sending: false };
  assert.equal(quickInputState(idle).hasActivity, false);
  assert.equal(quickInputState({ ...idle, sending: true }).state, 'working');
  assert.equal(quickInputState({ ...idle, sending: true, waiting: true }).state, 'waiting');
  assert.equal(quickInputState({ ...idle, error: 'Network failed' }).state, 'error');
  const finished = quickInputState({ ...idle, messages: [{ role: 'assistant', status: 'completed' }] });
  assert.equal(finished.icon, 'complete'); assert.equal(finished.hasActivity, true);
});
function callback(node, context) {
  const exports = {}, code = ts.transpileModule(`exports.run = ${node.getText(hookSource)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', ...Object.keys(context), code)(exports, ...Object.values(context));
  return exports.run;
}

test('opening editor drafts never reads or creates runtime sessions; first send retains explicit project identity', async () => {
  const calls = [], sessions = new Map(), saved = [];
  const { creationConversationBackend } = load('src/features/mdPresentation/creationConversationBackend.ts', {
    '../../backend/conversationBackend': { localConversationBackend: {
      createConversation: async input => { calls.push(input); const result = { ...input, id: input.sessionId }; sessions.set(input.sessionId, result); return result; },
    } },
    '../../backend/conversationRuntime': { conversationRuntime: () => ({ client: { getSession: async id => { calls.push(id); return sessions.get(id); } }, dispose() {} }) },
    '../../backend/api': { runtimeConversation: value => value },
  });
  const backend = creationConversationBackend('local-writing', 'creation', { metadata: { creation_workspace: true }, onCreated: value => saved.push(value) });
  assert.deepEqual(await backend.fetchConversations(), []);
  assert.deepEqual(await backend.fetchConversations(), []);
  assert.equal(calls.length, 0);
  const created = await backend.createConversation({ sessionId: 'local-writing', title: '文档', projectDir: 'D:/writing', metadata: { title_manual: true } });
  assert.equal(calls[0].projectDir, 'D:/writing');
  assert.deepEqual(calls[0].metadata, { title_manual: true, creation_workspace: true, conversation_started: true });
  assert.deepEqual(saved, [created]);
  assert.deepEqual(await backend.fetchConversations(), [created]);
});

test('first-send failure remains retryable, and a lost creation response recovers only the same session', async () => {
  const sessions = new Map(), created = [], reads = [], saved = [];
  let loseResponse = false;
  const { creationConversationBackend } = load('src/features/mdPresentation/creationConversationBackend.ts', {
    '../../backend/conversationBackend': { localConversationBackend: {
      createConversation: async input => {
        created.push(input.sessionId);
        if (loseResponse) sessions.set(input.sessionId, { id: input.sessionId, metadata: { task_dir: 'D:/task' } });
        throw Error('connection reset');
      },
    } },
    '../../backend/conversationRuntime': { conversationRuntime: () => ({ client: { getSession: async id => { reads.push(id); return sessions.get(id); } }, dispose() {} }) },
    '../../backend/api': { runtimeConversation: value => value },
  });
  sessions.set('unrelated', { id: 'unrelated' });
  const backend = creationConversationBackend('local-team', 'team', { metadata: { team_workspace: true }, onCreated: value => saved.push(value) });
  await assert.rejects(backend.createConversation({ sessionId: 'local-team' }), /connection reset/);
  assert.deepEqual(await backend.fetchConversations(), []);
  assert.equal(saved.length, 0);
  loseResponse = true;
  assert.equal((await backend.createConversation({ sessionId: 'local-team' })).id, 'local-team');
  assert.deepEqual(created, ['local-team', 'local-team']);
  assert.deepEqual(reads, ['local-team', 'local-team']);
  assert.equal(saved.length, 1);
});

test('Team draft identity survives reopening and late creation cannot replace a newly started chat', () => {
  const previous = globalThis.localStorage, storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  try {
    const path = 'src/features/team/teamConversationStore.ts', deps = { '../conversationWorkspace': workspace };
    const first = load(path, deps), draft = first.prepareTeamConversation('team');
    assert.equal(draft.draft, true); assert.equal(draft.root, '');
    assert.equal(first.prepareTeamConversation('team').sessionId, draft.sessionId);
    const reopened = load(path, deps);
    assert.equal(reopened.prepareTeamConversation('team').sessionId, draft.sessionId);
    reopened.resetTeamConversation('team');
    const replacement = reopened.prepareTeamConversation('team');
    reopened.persistTeamConversation('team', { id: draft.sessionId, metadata: { task_dir: 'D:/old' } });
    assert.equal(reopened.prepareTeamConversation('team').sessionId, replacement.sessionId);
    reopened.persistTeamConversation('team', { id: replacement.sessionId, metadata: { task_dir: 'D:/new' } });
    assert.deepEqual(load(path, deps).prepareTeamConversation('team'), { sessionId: replacement.sessionId, root: 'D:/new' });
  } finally { globalThis.localStorage = previous; }
});

test('only legacy empty editor sessions are suppressed from normal history; first sends, failed, and ordinary sessions stay visible', () => {
  for (const origin of ['creation_workspace', 'team_workspace']) {
    assert.equal(visible({ metadata: { [origin]: true }, turns: [] }), false);
    assert.equal(visible({ metadata: { [origin]: true, conversation_started: true }, turns: [] }), true, 'first sends remain visible before a terminal turn is committed');
    for (const status of ['completed', 'failed', 'stopped']) {
      assert.equal(visible({ metadata: { [origin]: true }, turns: [{ status }] }), true);
    }
    assert.equal(visible({ metadata: { [origin]: true } }), true, 'summary-only transports cannot prove emptiness');
  }
  assert.equal(visible({ turns: [] }), true);
  assert.equal(visible({ metadata: { agentRole: 'child' }, turns: [{}] }), false);
  assert.equal(visible({ metadata: { hidden: true }, turns: [{}] }), false);
});

test('switching between editor and chat refreshes cached history while respecting the current stream and hidden views', async () => {
  const effect = hook.body.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(hookSource) === 'useEffect' && node.getText(hookSource).includes('if (!editorConversation'));
  const reads = [], errors = [];
  const result = { latestTurn: { status: 'completed', turnId: 'turn-existing' } };
  const context = { editorConversation: true, backend: {}, requestContext: { viewActive: true, runtimeReady: true }, activeConversationId: 'same-session',
    controllersRef: { current: {} }, loadSessionHistory: async id => { reads.push(id); return result; },
    setError: error => errors.push(error), errorMessage: String };
  const run = () => callback(effect.expression.arguments[0], context)();
  run(); await flush();
  assert.deepEqual(reads, ['same-session']);
  run(); await flush();
  assert.equal(reads.length, 2, 'returning to cached history loads the completed editor changes');
  context.requestContext.viewActive = false; run(); await flush();
  assert.equal(reads.length, 2, 'hidden views do not read the transcript');
  context.requestContext.viewActive = true; context.controllersRef.current['same-session'] = {};
  run(); await flush(); assert.equal(reads.length, 2, 'the current sender already owns its stream');
  delete context.controllersRef.current['same-session'];
  let reject; context.loadSessionHistory = () => new Promise((resolve, fail) => { reject = fail; });
  const cancel = run(); cancel(); reject(Error('late read failed')); await flush();
  assert.deepEqual(errors, []);
});

test('the shared first-send persistence deduplicates concurrent requests and retains drafts after failure', async () => {
  const declaration = hook.body.statements.flatMap(node => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find(node => node.name.getText(hookSource) === 'persistPreparedConversation');
  const draft = { id: 'local-draft', title: 'Writing', projectDir: 'D:/project', metadata: { ui_draft: true } };
  let release, calls = 0, conversations = [];
  const prepared = { current: { [draft.id]: draft } };
  const context = { preparedConversationsRef: prepared, conversationCreationPromisesRef: { current: new Map() },
    createConversation: input => { calls++; assert.equal(input.projectDir, draft.projectDir); return new Promise((resolve, reject) => { release = { resolve, reject }; }); },
    fetchConversations: async () => [], conversationProjectId: () => '', conversationProjectDir: workspace.conversationProjectDir,
    mergeSyncedConversationTitle: title => title, setConversations: update => { conversations = update(conversations); },
    setPreparedConversationsById: value => { prepared.current = value; }, activeConversationIdRef: { current: draft.id }, setError() {}, errorMessage: String };
  const persist = callback(declaration.initializer.arguments[0], context);
  const first = persist(draft), concurrent = persist(draft);
  const rejected = Promise.allSettled([first, concurrent]);
  assert.equal(calls, 1); release.reject(Error('offline')); await rejected;
  assert.equal(prepared.current[draft.id], draft); assert.equal(conversations.length, 0);
  const retry = persist(draft); assert.equal(calls, 2);
  release.resolve({ ...draft, metadata: { creation_workspace: true } });
  const created = await retry;
  assert.equal(conversations.length, 1); assert.equal(prepared.current[draft.id], undefined);
  await persist(created); assert.equal(calls, 2, 'subsequent sends use the same persisted conversation');
});
