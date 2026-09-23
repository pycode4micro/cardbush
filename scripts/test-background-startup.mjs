import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.createSourceFile('hook.tsx', readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat');
const effect = hook.body.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
  && node.expression.expression.getText(source) === 'useEffect' && node.getText(source).includes('async function load()'));
assert.ok(effect);
const helpers = ['mergeLoadedConversationsPreservingLocalTitles', 'shouldAutoTitleConversation'].map(name =>
  source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source));
const compiled = ts.transpileModule([...helpers, effect.getText(source)].join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const row = (id, title = id) => ({ id, title });
function fixture(initial = {}) {
  const state = { conversations: [], active: '', messages: {}, skills: [], error: null, loading: true, ...initial };
  const sessions = deferred(), skills = deferred();
  const context = {
    requestContext: { runtimeReady: true }, conversationsRef: { current: state.conversations },
    activeConversationIdRef: { current: state.active }, messagesByConversationRef: { current: state.messages },
    preparedConversationsRef: { current: {} }, fetchConversations: () => sessions.promise, fetchSkills: () => skills.promise,
    conversationListRevisionRef: { current: 0 },
    useEffect: fn => { context.cancel = fn(); }, errorMessage: String,
  };
  for (const [setter, field] of Object.entries({ setConversations: 'conversations', setActiveConversationId: 'active',
    setMessagesByConversation: 'messages', setSkills: 'skills', setError: 'error', setLoading: 'loading' })) {
    context[setter] = value => { state[field] = typeof value === 'function' ? value(state[field]) : value; };
  }
  vm.runInNewContext(compiled, context);
  return { state, sessions, skills, cancel: () => context.cancel() };
}

const independent = fixture();
independent.sessions.resolve([row('history')]); await flush();
assert.equal(independent.state.loading, false, 'conversation readiness must not wait for Skills');
assert.equal(independent.state.conversations[0].id, 'history');
independent.skills.resolve([{ name: 'late-skill' }]); await flush();
assert.equal(independent.state.skills[0].name, 'late-skill');

const old = row('old', 'Original'), removed = row('removed');
const concurrent = fixture({ conversations: [old, removed], active: 'old', messages: { old: ['original'] } });
const updated = row('old', 'Renamed while loading'), created = row('new', 'Created while loading');
concurrent.state.conversations = [created, updated]; concurrent.state.active = 'new';
concurrent.state.messages = { old: ['live message'], new: ['draft message'] };
concurrent.sessions.resolve([row('old', 'Stale title'), removed, row('remote')]); await flush();
assert.equal(JSON.stringify(concurrent.state.conversations.map(item => item.id)), JSON.stringify(['new', 'old', 'remote']));
assert.equal(concurrent.state.conversations[1].title, updated.title);
assert.equal(concurrent.state.active, 'new');
assert.equal(JSON.stringify(concurrent.state.messages), JSON.stringify({ old: ['live message'], new: ['draft message'] }));

const failed = fixture();
failed.state.conversations = [created]; failed.state.active = 'new'; failed.state.messages = { new: ['keep'] };
failed.sessions.reject(new Error('fixture failure')); await flush();
assert.equal(failed.state.conversations[0], created);
assert.equal(failed.state.active, 'new'); assert.equal(failed.state.messages.new[0], 'keep');
assert.match(failed.state.error, /fixture failure/);

const cancelled = fixture(); cancelled.cancel();
cancelled.sessions.resolve([row('cancelled')]); cancelled.skills.resolve([{ name: 'cancelled' }]); await flush();
assert.equal(cancelled.state.conversations.length, 0); assert.equal(cancelled.state.skills.length, 0);
console.log('Background startup passed: independent requests, concurrent create/rename/delete, message and selection retention, failure and cancellation.');
