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
  conversationWorkspaceMode,
  isOnlyTalkConversation,
} = module.exports;

const taskRoot = String.raw`C:\Users\tester\AppData\Local\bushserver\task\local-task`;
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
assert.equal(isOnlyTalkConversation(pollutedTaskConversation), true);

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

// BushServer project sessions use session_workspace_dir for the user project
// while task_dir points at an internal per-session runtime directory. The
// former must never be treated as evidence of Only Talk/task mode.
const treelkProjectRoot = String.raw`C:\Users\tester\Desktop\treelk`;
const treelkTaskRoot = String.raw`C:\Users\tester\AppData\Local\bushserver\task\local-treelk`;
const projectWithEmptyInitialHistory = {
  id: 'local-treelk',
  projectDir: treelkProjectRoot,
  metadata: {
    workspace_mode: 'project',
    project_dir: treelkProjectRoot,
    user_project_dir: treelkProjectRoot,
    workspace_dir: treelkProjectRoot,
    session_workspace_dir: treelkProjectRoot,
    session_workspace_alias_path: String.raw`C:\Users\tester\AppData\Local\bushserver\task\_short\treelk`,
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

console.log('conversation workspace contract tests passed');
