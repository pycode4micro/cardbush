import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const root = process.cwd();

function compile(relativePath, imports = {}) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: (request) => imports[request] ?? {},
    String,
    Object,
  });
  return module.exports;
}

const localPaths = compile('src/shared/localPaths.ts');
const workspace = compile('src/features/conversationWorkspace.ts');
const scope = compile('src/features/conversationScope.ts', {
  '../shared/localPaths': localPaths,
  './conversationWorkspace': workspace,
});

const task = {
  id: 'task-1',
  title: 'task',
  preview: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
  metadata: { workspace_mode: 'task' },
};
const legacyProject = {
  id: 'legacy-project',
  title: 'legacy',
  preview: '',
  updatedAt: '2026-01-02T00:00:00.000Z',
  projectDir: String.raw`D:\projects\alpha`,
  metadata: { workspace_mode: 'project' },
};
const movedProject = {
  ...legacyProject,
  id: 'moved-project',
  projectId: 'project-stable',
  projectDir: String.raw`D:\projects\renamed`,
  metadata: { workspace_mode: 'project', project_id: 'project-stable' },
};

assert.equal(scope.conversationMatchesScope(task, { mode: 'task' }), true);
assert.equal(
  scope.conversationMatchesScope(task, {
    mode: 'project',
    projectId: 'project-stable',
    projectDir: movedProject.projectDir,
  }),
  false,
);
assert.equal(
  scope.conversationMatchesScope(legacyProject, {
    mode: 'project',
    projectDir: String.raw`d:\PROJECTS\alpha`,
  }),
  true,
  'legacy sessions must retain path-based project grouping',
);
assert.equal(
  scope.conversationMatchesScope(movedProject, {
    mode: 'project',
    projectId: 'project-stable',
    projectDir: String.raw`D:\anywhere`,
  }),
  true,
  'stable project identity must survive a folder rename',
);
assert.equal(
  scope.conversationMatchesScope(movedProject, {
    mode: 'project',
    projectId: 'different-project',
    projectDir: movedProject.projectDir,
  }),
  false,
  'two stable project identities must never collapse because their paths match',
);
assert.equal(
  scope.firstConversationInScope([task, movedProject], {
    mode: 'project',
    projectId: 'missing-project',
    projectDir: String.raw`D:\missing`,
  }),
  undefined,
  'an empty project scope must not fall back to the newest task session',
);
assert.equal(
  scope.remapProjectPath(String.raw`D:\projects\alpha\src\file.ts`, [
    { from: String.raw`D:\projects\alpha`, to: String.raw`D:\projects\beta` },
    { from: String.raw`D:\projects\beta`, to: String.raw`D:\projects\gamma` },
  ]),
  String.raw`D:\projects\gamma\src\file.ts`,
  'historical local links must follow every recorded project rename',
);
assert.equal(
  scope.remapProjectPath(String.raw`D:\projects\alphabet\file.ts`, [
    { from: String.raw`D:\projects\alpha`, to: String.raw`D:\projects\beta` },
  ]),
  String.raw`D:\projects\alphabet\file.ts`,
  'path aliases must respect directory boundaries',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(scope.conversationProjectPathAliases({
    ...movedProject,
    metadata: {
      project_path_aliases: [
        { from: String.raw`D:\projects\old`, to: String.raw`D:\projects\renamed` },
        { from: 'relative', to: String.raw`D:\redirected` },
        { from: String.raw`D:\same`, to: String.raw`d:\SAME` },
      ],
    },
  }))),
  [{ from: String.raw`D:\projects\old`, to: String.raw`D:\projects\renamed` }],
  'only absolute, meaningful aliases may redirect a historical file reference',
);

const hookSource = fs.readFileSync(
  path.join(root, 'src/hooks/useCardbushChat.ts'),
  'utf8',
);
assert.doesNotMatch(hookSource, /loadedConversations\[0\]/);
assert.doesNotMatch(
  hookSource.match(/const activeConversation = useMemo\([\s\S]*?\n  \);/)?.[0] ?? '',
  /conversations\[0\]/,
);
assert.match(hookSource, /const prepareConversation = useCallback/);
assert.match(hookSource, /const persistPreparedConversation = useCallback/);
const prepareBlock = hookSource.match(
  /const prepareConversation = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\);/,
)?.[0] ?? '';
assert.doesNotMatch(
  prepareBlock,
  /await createConversation|setConversations/,
  'reserving a draft must not persist it or expose it in the sidebar',
);
assert.match(
  hookSource,
  /conversation = await persistPreparedConversation\(candidate\)/,
  'a prepared conversation must be persisted only from the first send path',
);
assert.match(
  hookSource,
  /markSessionRunning\(sessionId\);[\s\S]*?conversation = await persistPreparedConversation\(candidate\)/,
  'the first send must claim its local session before asynchronous persistence to prevent duplicate submissions',
);
assert.match(
  hookSource,
  /conversation = await persistPreparedConversation\(candidate\);[\s\S]*?catch \{[\s\S]*?clearSessionRunning\(sessionId\)/,
  'a failed first persistence must release the local send lock and preserve a retryable draft',
);
assert.match(
  hookSource,
  /const projectPathAliases = conversationProjectPathAliases\(conversation\)[\s\S]*?remapProjectPath\(pathValue, projectPathAliases\)/,
  'retrying a historical attachment must use its renamed project path',
);
assert.match(
  hookSource,
  /const \[messageHistoryLoadingIds, setMessageHistoryLoadingIds\][\s\S]*?messageHistoryLoadingIds\.has\(activeConversationIdForState\)/,
  'history loading state must be scoped to the selected conversation',
);
const openConversationBlock = hookSource.match(
  /const openConversation = useCallback\([\s\S]*?\n  \);/,
)?.[0] ?? '';
assert.match(
  openConversationBlock,
  /setMessageHistoryLoading\([\s\S]*?setActiveConversationId\(normalized\)/,
  'selecting uncached history must enter loading state in the same event as the route change',
);
assert.match(
  hookSource,
  /const finishLoading = beginHistoryLoading\(sessionId\);[\s\S]*?fetchSessionMessages\(sessionId,[\s\S]*?finally \{\s*finishLoading\(\)/,
  'history fetch completion must only clear the loading marker for its own conversation',
);

const appSource = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
assert.match(
  appSource,
  /const activeMatchesMode = onlyTalkMode[\s\S]*?Boolean\(chat\.activeConversation && !isOnlyTalkConversation\(chat\.activeConversation\)\)/,
  'project navigation must retain an explicitly selected project session instead of snapping back to the fallback project',
);
assert.match(
  appSource,
  /if \(scope\.projectDir\) \{[\s\S]*?chat\.prepareConversation\(scope\.projectDir, undefined, scope\.projectId\)/,
  'an empty project must create only an in-memory draft for its own scope',
);
assert.match(
  appSource,
  /const changeWelcomeProject[\s\S]*?if \(!normalized\) \{[\s\S]*?changeOnlyTalkMode\(true\)/,
  'leaving a project from the welcome switcher must use the explicit task route',
);
assert.match(
  appSource,
  /<WelcomeProjectSwitcher[\s\S]*?disabled=\{sending\}[\s\S]*?if \(disabled\) setOpen\(false\)/,
  'a project draft cannot change scope while its first Turn is being created or executed',
);
assert.match(
  appSource,
  /const recoveredProjectConversation = chat\.conversations[\s\S]*?samePath\(projectDir, selected\)[\s\S]*?const projectId = conversationProjectId\(recoveredProjectConversation\)[\s\S]*?id: projectId \|\| stableProjectId\(selected\)/,
  'removing and re-adding the same folder must recover its session-backed project identity',
);
assert.match(
  appSource,
  /historyLoading=\{!chat\.loading && chat\.messagesLoading\}/,
  'project conversation navigation must distinguish history loading from runtime startup',
);

const messageBubbleSource = fs.readFileSync(
  path.join(root, 'src/features/chatMessages/MessageBubble.tsx'),
  'utf8',
);
assert.match(
  messageBubbleSource,
  /const resolvedAttachments = attachments\.map[\s\S]*?remapProjectPath\(attachment\.path, pathAliases\)/,
  'historical user file attachments must resolve through project rename aliases',
);
assert.match(
  messageBubbleSource,
  /const resolvedPaths = paths\.map\(\(pathValue\) => remapProjectPath\(pathValue, pathAliases\)\)/,
  'historical image attachments must resolve through project rename aliases',
);
assert.match(
  messageBubbleSource,
  /videoPaths\.map\(\(storedPathValue\)[\s\S]*?remapProjectPath\(storedPathValue, pathAliases\)[\s\S]*?audioPaths\.map\(\(storedPathValue\)[\s\S]*?remapProjectPath\(storedPathValue, pathAliases\)/,
  'historical video and audio attachments must resolve through project rename aliases',
);

console.log('conversation scope contract tests passed');
