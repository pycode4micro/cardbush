import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'conversationWorkspace.ts'),
  'utf8',
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module,
  exports: module.exports,
  require: () => ({}),
  String,
});

const {
  conversationProjectDir,
  conversationWorkspaceRoot,
  conversationWorkspaceMode,
  isOnlyTalkConversation,
} = module.exports;

const taskRoot = String.raw`C:\Users\tester\AppData\Local\CardBush\runtime\sessions\local-task`;
const pollutedTaskConversation = {
  id: 'local-task',
  projectDir: taskRoot,
  metadata: {
    workspace_mode: 'project',
    project_dir: taskRoot,
    user_project_dir: taskRoot,
    session_workspace_dir: taskRoot,
    session_workspace_alias_path: taskRoot,
  },
  workspaceContext: {
    mode: 'project',
    executionRoot: taskRoot,
    projectDir: taskRoot,
    taskDir: taskRoot,
  },
};

assert.equal(conversationWorkspaceMode(pollutedTaskConversation), 'task');
assert.equal(conversationProjectDir(pollutedTaskConversation), '');
assert.equal(conversationWorkspaceRoot(pollutedTaskConversation), taskRoot);
assert.equal(isOnlyTalkConversation(pollutedTaskConversation), true);

const cleanTaskConversation = {
  id: 'local-clean-task',
  metadata: {
    workspace_mode: 'task',
    workspace_dir: taskRoot,
    task_dir: taskRoot,
    session_workspace_dir: taskRoot,
  },
  workspaceContext: {
    mode: 'task',
    executionRoot: taskRoot,
    taskDir: taskRoot,
  },
};

assert.equal(conversationWorkspaceMode(cleanTaskConversation), 'task');
assert.equal(conversationProjectDir(cleanTaskConversation), '');
assert.equal(conversationWorkspaceRoot(cleanTaskConversation), taskRoot);
assert.equal(isOnlyTalkConversation(cleanTaskConversation), true);

const genuineProjectRoot = String.raw`C:\Users\tester\Desktop\game`;
const genuineProjectConversation = {
  id: 'project-task',
  projectDir: genuineProjectRoot,
  metadata: {
    workspace_mode: 'project',
    project_dir: genuineProjectRoot,
    session_workspace_dir: taskRoot,
  },
  workspaceContext: {
    mode: 'project',
    executionRoot: genuineProjectRoot,
    projectDir: genuineProjectRoot,
    taskDir: taskRoot,
  },
};

assert.equal(conversationWorkspaceMode(genuineProjectConversation), 'project');
assert.equal(conversationProjectDir(genuineProjectConversation), genuineProjectRoot);
assert.equal(isOnlyTalkConversation(genuineProjectConversation), false);

const worktreeConversation = {
  ...genuineProjectConversation,
  metadata: { ...genuineProjectConversation.metadata,
    runtimeWorkspace: { mode: 'worktree', sourceDir: genuineProjectRoot, workspaceDir: taskRoot },
    workspaceDir: taskRoot,
  },
  workspaceContext: { ...genuineProjectConversation.workspaceContext, executionRoot: taskRoot },
};
assert.equal(conversationWorkspaceMode(worktreeConversation), 'project');
assert.equal(conversationProjectDir(worktreeConversation), genuineProjectRoot);
assert.equal(conversationWorkspaceRoot(worktreeConversation), taskRoot);

// Product Runtime project sessions keep the user project separate from an
// internal per-session execution directory. The
// former must never be treated as evidence of Only Talk/task mode.
const treelkProjectRoot = String.raw`C:\Users\tester\Desktop\treelk`;
const treelkTaskRoot = String.raw`C:\Users\tester\AppData\Local\CardBush\runtime\sessions\local-treelk`;
const projectWithEmptyInitialHistory = {
  id: 'local-treelk',
  projectDir: treelkProjectRoot,
  metadata: {
    workspace_mode: 'project',
    project_dir: treelkProjectRoot,
    user_project_dir: treelkProjectRoot,
    workspace_dir: treelkProjectRoot,
    session_workspace_dir: treelkProjectRoot,
    session_workspace_alias_path: String.raw`C:\Users\tester\AppData\Local\CardBush\runtime\aliases\treelk`,
  },
  workspaceContext: {
    mode: 'project',
    executionRoot: treelkProjectRoot,
    projectDir: treelkProjectRoot,
    taskDir: treelkTaskRoot,
  },
};

assert.equal(conversationWorkspaceMode(projectWithEmptyInitialHistory), 'project');
assert.equal(conversationProjectDir(projectWithEmptyInitialHistory), treelkProjectRoot);
assert.equal(isOnlyTalkConversation(projectWithEmptyInitialHistory), false);

// A project session may temporarily execute inside its per-session task
// sandbox. The list payload can also carry stale `workspace_mode: task`, but
// the preserved user project fields must keep it under the project.
const conflictedProjectConversation = {
  id: 'local-conflicted-project',
  projectDir: treelkTaskRoot,
  metadata: {
    workspace_mode: 'task',
    project_dir: treelkProjectRoot,
    user_project_dir: treelkProjectRoot,
    workspace_dir: treelkProjectRoot,
    session_workspace_dir: treelkTaskRoot,
    session_workspace_alias_path: treelkProjectRoot,
  },
};

assert.equal(conversationWorkspaceMode(conflictedProjectConversation), 'project');
assert.equal(conversationProjectDir(conflictedProjectConversation), treelkProjectRoot);
assert.equal(isOnlyTalkConversation(conflictedProjectConversation), false);

const conflictedProjectDetail = {
  ...conflictedProjectConversation,
  workspaceContext: {
    mode: 'project',
    executionRoot: treelkTaskRoot,
    projectDir: treelkTaskRoot,
    taskDir: treelkTaskRoot,
  },
};

assert.equal(conversationWorkspaceMode(conflictedProjectDetail), 'project');
assert.equal(conversationProjectDir(conflictedProjectDetail), treelkProjectRoot);
assert.equal(isOnlyTalkConversation(conflictedProjectDetail), false);

const legacyEditorRoot = 'C:/Users/test/AppData/Roaming/cardbush/task-workspaces/ff2074d0c0227a1eecf7b01e';
for (const origin of ['creation_workspace', 'team_workspace']) {
  const legacy = { id: 'old-editor', projectDir: legacyEditorRoot, metadata: { [origin]: true, workspace_mode: 'project', projectDir: legacyEditorRoot, project_dir: legacyEditorRoot, user_project_dir: legacyEditorRoot, workspace_dir: legacyEditorRoot } };
  assert.equal(conversationProjectDir(legacy), '', 'generated editor directory must not become a project');
  assert.equal(conversationWorkspaceMode(legacy), 'task');
  assert.equal(conversationWorkspaceRoot(legacy), legacyEditorRoot, 'existing files remain accessible in the original directory');
  assert.equal(conversationProjectDir({ ...legacy, metadata: { ...legacy.metadata, user_project_dir: 'D:/writing' } }), 'D:/writing');
}
assert.equal(conversationProjectDir({ projectDir: legacyEditorRoot }), legacyEditorRoot, 'unrelated explicit projects are untouched');
assert.equal(conversationProjectDir({ projectDir: 'D:/task-workspaces/research', metadata: { creation_workspace: true } }), 'D:/task-workspaces/research');

console.log('conversation workspace contract tests passed');
