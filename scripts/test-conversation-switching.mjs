import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const load = file => {
  const exports = {};
  vm.runInNewContext(compile(fs.readFileSync(file, 'utf8')), { exports });
  return exports;
};
const { SessionReadFence, canApplySessionSnapshot } = load('src/shared/sessionReadFence.ts');
const { trimConversationCache } = load('src/shared/conversationCache.ts');
const entries = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(i), ['message-' + i]]));
const visits = new Map(Object.keys(entries).map(id => [id, Number(id)]));
const pruned = trimConversationCache(entries, visits, new Set(['0', '1', '2']), 24);
assert.equal(Object.keys(pruned).length, 27);
for (const id of ['0', '1', '2', '36', '59']) assert.equal(pruned[id], entries[id], 'active/live/pending and recently viewed snapshots survive');
assert.equal(pruned['35'], undefined);
assert.equal(Object.keys(entries).length, 60, 'eviction never mutates a React snapshot');
assert.equal(trimConversationCache(pruned, visits, new Set(['0', '1', '2']), 24), pruned, 'unchanged caches preserve identity');

// Execute the real selection/read callbacks with deferred transport and queued
// React updates. Test response ordering, not strings copied from the source.
const source = ts.createSourceFile('hook.tsx', fs.readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'useCardbushChat');
const names = ['beginHistoryRead', 'isHistoryReadCurrent', 'loadSessionHistory', 'openStoredConversation', 'openConversation', 'clearConversationSelection'];
const declarations = names.map(name => hook.body.statements.find(s => ts.isVariableStatement(s)
  && s.declarationList.declarations.some(d => d.name.getText(source) === name)).getText(source)).join('\n');
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const ref = current => ({ current });
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshots = [], supplements = [], promotions = [], messageQueue = [];
let messages = {}, conversations = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], active = '', error;
const context = {
  exports: {}, useCallback: fn => fn, SessionReadFence, canApplySessionSnapshot,
  requestContext: { workspaceChangesAvailable: true },
  historyRequestsRef: ref(new Map()), historyReadsRef: ref(new SessionReadFence()), liveTranscriptSessionsRef: ref(new Set()),
  navigationRevisionRef: ref(0), activeConversationIdRef: ref(''), conversationsRef: ref(conversations), preparedConversationsRef: ref({}),
  messagesByConversationRef: ref(messages), conversations, messagesByConversation: messages,
  setMessagesByConversation: fn => messageQueue.push(fn),
  setConversations: fn => { conversations = fn(conversations); context.conversationsRef.current = conversations; context.conversations = conversations; },
  setActiveConversationId: id => { active = id; context.activeConversationIdRef.current = id; },
  setError: value => { error = value; }, errorMessage: String,
  setPendingInteraction() {}, setMessageHistoryLoading() {}, clearSessionAttention() {},
  persistAutoConversationTitle() {}, firstUserTitleSource: () => '', refreshMeasuredContextWindowUsage() {},
  mergeLoadedMessagesPreservingLocalState: (_old, loaded) => loaded,
  mergeWorkspaceChangeExecutions: (old, changes) => [...old, ...changes],
  fetchSessionMessages: sessionId => { const request = { sessionId, ...defer() }; snapshots.push(request); return request.promise; },
  fetchSessionWorkspaceChanges: sessionId => { const request = { sessionId, ...defer() }; supplements.push(request); return request.promise; },
  updateConversation: input => { const request = { ...input, ...defer() }; promotions.push(request); return request.promise; },
};
vm.runInNewContext(compile(declarations + '\n' + names.map(name => `exports.${name}=${name};`).join('\n')), context);
const api = context.exports;
const flush = () => {
  while (messageQueue.length) messages = messageQueue.shift()(messages);
  context.messagesByConversationRef.current = messages;
  context.messagesByConversation = messages;
};
const result = (id, text) => ({ conversation: { id, title: id }, messages: [{ id: text }] });

const a = api.loadSessionHistory('a');
assert.equal(api.loadSessionHistory('a'), a, 'simultaneous first load and job watcher share the same read');
assert.equal(snapshots.length, 1);
api.openConversation('b');
const b = api.loadSessionHistory('b');
snapshots[1].resolve(result('b', 'B now')); await b; flush();
assert.equal(messages.b[0].id, 'B now', 'transcript does not wait for full workspace changes');
snapshots[0].resolve(result('a', 'A late')); await a; flush();
assert.equal(active, 'b', 'a late history read cannot navigate');
assert.equal(messages.a[0].id, 'A late', 'late history remains usable on return');

// A new stream is queued before a slow diff returns, without a render between.
messageQueue.push(current => ({ ...current, b: [...current.b, { id: 'live B' }] }));
supplements[1].resolve([{ id: 'stale diff' }]); await tick(); flush();
assert.deepEqual(messages.b.map(message => message.id), ['B now', 'live B']);
supplements[0].resolve([{ id: 'valid diff' }]); await tick(); flush();
assert.deepEqual(Array.from(messages.a, message => message.id), ['A late', 'valid diff']);

const old = api.loadSessionHistory('a');
context.historyReadsRef.current.invalidate('a'); // send/edit/rerun invalidates the old read
const newer = api.loadSessionHistory('a');
snapshots[3].resolve(result('a', 'replacement')); await newer; flush();
snapshots[2].resolve(result('a', 'stale replacement')); await old; flush();
assert.equal(messages.a[0].id, 'replacement');
supplements[2].resolve([{ id: 'old supplement' }]); supplements[3].resolve([]); await tick(); flush();
assert.equal(messages.a.length, 1);

const failed = api.loadSessionHistory('a');
snapshots[4].reject(new Error('connection lost')); await assert.rejects(failed, /connection lost/);
assert.equal(context.historyRequestsRef.current.has('a'), false, 'failed single-flight reads release their slot');
assert.equal(messages.a[0].id, 'replacement', 'a refresh failure never blanks cached history');
supplements[4].resolve([]);
assert.equal(await api.openStoredConversation('a'), true);
assert.equal(promotions.length, 0, 'known visible conversations do not write hidden=false');

const hidden = api.openStoredConversation('hidden');
api.openConversation('b');
promotions[0].resolve({ id: 'hidden', title: 'Hidden' });
assert.equal(await hidden, false);
assert.equal(active, 'b', 'a late promotion cannot override a newer sidebar click');
const hidden2 = api.openStoredConversation('hidden2');
api.clearConversationSelection();
promotions[1].reject(new Error('late promotion failure'));
assert.equal(await hidden2, false);
assert.equal(active, ''); assert.equal(error, null, 'a stale request cannot show an error in a new conversation');

const agentSource = ts.createSourceFile('connections.ts', fs.readFileSync('src/features/agents/useAgentConnections.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const agentHook = agentSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useAgentConnections');
const agentCallbacks = ['select', 'forkSession'].map(name => agentHook.body.statements.find(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(d => d.name.getText(agentSource) === name)).getText(agentSource)).join('\n');
const forks = [];
let selectedAgent = '', selectedSessions = {}, views = {};
const agentContext = {
  exports: {}, useCallback: fn => fn, navigationRevision: ref(0), selectionRevision: ref(new Map()), loads: ref(new Map()),
  setSelectedId: id => { selectedAgent = id; }, setSelectedSessions: fn => { selectedSessions = fn(selectedSessions); },
  setViews: fn => { views = fn(views); }, refreshSessions: async () => {}, updateList() {}, message: String,
  api: () => ({ call: () => { const fork = defer(); forks.push(fork); return fork.promise; } }),
};
vm.runInNewContext(compile(agentCallbacks + '\nexports.select=select;exports.fork=forkSession;'), agentContext);
const agentApi = agentContext.exports;
agentApi.select('a', 'original');
const oldFork = agentApi.fork('a', 'original');
agentApi.select('b', 'latest');
forks[0].resolve({ sessionId: 'late-fork' }); await oldFork;
assert.equal(selectedAgent, 'b'); assert.equal(selectedSessions.b, 'latest', 'a late fork cannot navigate away from another host');
const firstFork = agentApi.fork('b', 'latest'), lastFork = agentApi.fork('b', 'latest');
forks[2].resolve({ sessionId: 'last-fork' }); await lastFork;
forks[1].resolve({ sessionId: 'first-fork' }); await firstFork;
assert.equal(selectedSessions.b, 'last-fork', 'latest fork intent wins even when responses arrive out of order');
console.log('Conversation switching passed: bounded cache, protected live work, coalesced reads, slow supplements, stale snapshots, failed refresh, navigation, promotion and fork races.');
