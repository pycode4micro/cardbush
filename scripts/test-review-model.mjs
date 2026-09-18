import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
function load(path) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', compiled)(name => name === '@cardbush/bush-protocol' ? protocol : require(name), module, module.exports);
  return module.exports;
}
const { recentReviewTurns, reviewPathKey, reviewRelativePath } = load('src/features/sidebar/reviewModel.ts');
const { conversationWorkspaceRoot } = load('src/features/conversationWorkspace.ts');

test('review roots follow the actual project, worktree and generated task directory', () => {
  assert.equal(conversationWorkspaceRoot({ projectDir: 'D:/source', metadata: { runtimeWorkspace: { workspaceDir: 'D:/worktree' } } }), 'D:/worktree');
  assert.equal(conversationWorkspaceRoot({ projectDir: 'D:/source' }), 'D:/source');
  assert.equal(conversationWorkspaceRoot({ metadata: { workspace_mode: 'task', task_dir: 'D:/task-workspaces/task' } }), 'D:/task-workspaces/task');
});

test('a no-edit Turn is retained and loop messages do not consume extra review slots', () => {
  const messages = Array.from({ length: 200 }, (_, index) => [
    { id: `user-${index}`, turnId: `turn-${index}`, role: 'user', content: `Request ${index}` },
    { id: `answer-${index}`, turnId: `turn-${index}`, role: 'assistant', content: 'Done', loopHistory: [{ id: `progress-${index}`, turnId: `turn-${index}`, role: 'assistant', content: 'Working' }] },
  ]).flat();
  assert.deepEqual(recentReviewTurns(messages).map(turn => turn.id), ['turn-199', 'turn-198']);
  assert.equal(recentReviewTurns(messages)[0].prompt, 'Request 199');
  messages.push(messages[1]);
  assert.deepEqual(recentReviewTurns(messages).map(turn => turn.id), ['turn-199', 'turn-198'], 'late replay of an old Tool message cannot replace the current window');
});

test('tree paths respect directory boundaries and platform case rules', () => {
  assert.equal(reviewRelativePath('C:/project', 'c:\\PROJECT\\src\\index.ts'), 'src/index.ts');
  assert.equal(reviewRelativePath('C:/project', 'C:/project-other/secret'), null);
  assert.equal(reviewRelativePath('C:/', 'c:/project/file'), 'project/file');
  assert.equal(reviewRelativePath('/repo', '/repo/src/a'), 'src/a');
  assert.notEqual(reviewPathKey('/repo/File'), reviewPathKey('/repo/file'));
});
