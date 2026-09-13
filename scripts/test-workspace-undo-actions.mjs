import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';

const require = createRequire(import.meta.url);
const source = file => ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const evaluate = (code, globals = {}) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require, ...globals });
  context.exports = context.module.exports;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.module.exports;
};
const stateHelpers = evaluate(fs.readFileSync('src/features/tools/WorkspaceChangeStateContext.ts', 'utf8'));
const main = source('electron/main.ts');
const names = ['applyFileChanges', 'revertFileChanges', 'buildReversePatchInput', 'normalizePatchPath', 'normalizePatchDiff', 'requireProjectDirectory', 'runGitWithInput', 'commandErrorMessage'];
const desktop = evaluate(main.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
  .map(node => node.getText(main)).join('\n') + '\nmodule.exports = { applyFileChanges, revertFileChanges };', { fs, path, execFileSync });
let actionSource;
const app = source('src/App.tsx');
const visit = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'setChangeReportsReverted') actionSource = node.initializer.arguments[0].getText(app);
  ts.forEachChild(node, visit);
};
visit(app);
assert.ok(actionSource);

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'cardbush-undo-actions-'));
  t.after(() => {
    assert.ok(root.startsWith(path.join(tmpdir(), 'cardbush-undo-actions-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  execFileSync('git', ['-C', root, 'init', '-q'], { windowsHide: true });
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false'], { windowsHide: true });
  const state = { states: new Map(), calls: [], legacy: { current: new Set() }, busy: { current: false }, notices: [], alerts: [] };
  const apply = (files, reverse) => desktop.applyFileChanges(root, files, reverse);
  const runtime = async (kind, turns) => {
    state.calls.push([kind, [...turns]]);
    if (options.failRuntime) throw options.failRuntime;
    return kind === 'revert' ? { revertedFiles: 1 } : { restoredFiles: 1 };
  };
  const execute = evaluate('module.exports = ' + actionSource, {
    ...stateHelpers, language: 'zh', legacyRevertKeysRef: state.legacy, workspaceChangeBusyRef: state.busy,
    chat: { conversations: [{ id: 'a', root }], processingConversationIds: new Set(options.active ? ['a'] : []) },
    changeRootForConversation: conversation => conversation?.root,
    setChangeReviewNotice: text => state.notices.push(text), setRevertingChangeId: () => {},
    setRevertedChangeStates: update => { state.states = update(state.states); }, saveLegacyRevertKeys: () => {},
    serializeToolChangeReport: report => report.files,
    revertSessionWorkspaceChanges: (_, turns) => runtime('revert', turns),
    restoreSessionWorkspaceChanges: (_, turns) => runtime('restore', turns),
    snapshotRevertFallbackAllowed: error => error.code === 'runtime_workspace_snapshot_unavailable',
    refreshProjectGitStatus: async () => {}, errorMessage: error => error.message, workspaceRevertErrorMessage: error => error.message,
    window: { confirm: () => true, alert: text => state.alerts.push(text), cardbushDesktop: {
      revertFileChanges: async (_, files) => ({ revertedFiles: apply(files, true).fileCount }),
      restoreFileChanges: async (_, files) => ({ restoredFiles: apply(files, false).fileCount }),
    } },
  });
  return { root, state, execute, apply };
}
const report = (turnId, before = 'before', after = 'after', file = 'file.txt') => ({
  id: turnId + file, turnId, messageId: turnId + file, fileCount: 1,
  files: [{ path: file, diff: `@@ -1 +1 @@\n-${before}\n+${after}\n` }],
});

test('shared App action preserves reverse/forward Turn order and blocks running sessions', async t => {
  const { state, execute } = fixture(t);
  await execute('a', [report('one'), report('two')], true, 'bulk');
  await execute('a', [report('one'), report('two')], false, 'bulk');
  assert.deepEqual(state.calls, [['revert', ['two', 'one']], ['restore', ['one', 'two']]]);
  assert.ok([...state.states.values()].every(value => value === false));
  const active = fixture(t, { active: true });
  await active.execute('a', [report('one')], false, 'one');
  assert.equal(active.state.calls.length, 0);
  assert.equal(active.state.notices.length, 1);
});

test('undo conflicts do not invoke a desktop fallback or change the reverted state', async t => {
  const { state, root, execute } = fixture(t, { failRuntime: new Error('revision conflict') });
  fs.writeFileSync(path.join(root, 'file.txt'), 'before\n');
  state.states.set(stateHelpers.workspaceChangeKey('a', report('one')), true);
  await execute('a', [report('one')], false, 'one');
  assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'before\n');
  assert.equal([...state.states.values()][0], true);
  assert.equal(state.alerts.length, 1);
  assert.equal(state.busy.current, false);
});

test('legacy diff undo survives multiple edits to the same file and clears routing after restoration', async t => {
  const unavailable = Object.assign(new Error('legacy'), { code: 'runtime_workspace_snapshot_unavailable' });
  const { root, state, execute } = fixture(t, { failRuntime: unavailable });
  const reports = [report('one', 'A', 'B'), report('two', 'B', 'C')];
  fs.writeFileSync(path.join(root, 'file.txt'), 'C\n');
  await execute('a', reports, true, 'bulk');
  assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'A\n');
  assert.equal(state.legacy.current.size, 2);
  await execute('a', reports, false, 'bulk');
  assert.equal(fs.readFileSync(path.join(root, 'file.txt'), 'utf8'), 'C\n');
  assert.equal(state.legacy.current.size, 0);
  assert.equal(state.calls.length, 1, 'redo uses the original fallback route');
  assert.deepEqual(state.alerts, []);
});

test('a failing legacy change set rolls back its earlier files and retains its undo state', async t => {
  const { root, state, execute } = fixture(t);
  const reports = [report('one', 'A', 'B', 'a.txt'), report('one', 'X', 'Y', 'b.txt')];
  const key = stateHelpers.workspaceChangeKey('a', reports[0]);
  state.legacy.current.add(key); state.states.set(key, true);
  fs.writeFileSync(path.join(root, 'a.txt'), 'A\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'user edit\n');
  await execute('a', reports, false, 'one');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'A\n');
  assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'user edit\n');
  assert.equal(state.states.get(key), true);
  assert.equal(state.legacy.current.has(key), true);
  assert.equal(state.alerts.length, 1);
});
