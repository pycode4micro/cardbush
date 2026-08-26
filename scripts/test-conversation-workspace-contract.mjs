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

console.log('conversation workspace contract tests passed');
