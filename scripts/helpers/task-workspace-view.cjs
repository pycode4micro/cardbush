const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/chat/taskWorkspace.css'), 'utf8'));
  await run(`
    if (!crypto.randomUUID) crypto.randomUUID = require('node:crypto').randomUUID;
    window.workspaceCalls = [];
    window.localStorage.removeItem('cardbush.workspace.mode');
    window.workspaceRefreshes = 0;
    window.confirmResult = false;
    window.confirm = () => confirmResult;
    window.workspaceFixture = {
      workspace: { sessionId: 'workspace-task', mode: 'worktree', sourceDir: 'D:/source',
        workspaceDir: 'C:/CardBush/workspaces/tasks/long-task-identity/checkout', status: 'ready', revision: 3 },
      snapshotId: 'reviewed-file-state', runningTerminals: false,
      checkpoints: [{ turnId: 'one', createdAt: new Date().toISOString(), status: 'complete', changes: [] }],
      changes: [{ change_id: 'file', path: 'C:/copy/file.ts', status: 'modified',
        metadata: { diff: '@@ -1,1 +1,1 @@\\n-before\\n+after' } }],
    };
    cardbushDesktop.runtime = {
      async command(message) {
        const { kind, payload } = message.command;
        let result;
        if (kind === 'runtime.get_capabilities') result = {
          protocol: 'bush.runtime_capabilities.v1', hostId: 'fixture', runtimeVersion: 'test',
          eventProtocol: 'bush.runtime_event.v1', supportedEvents: [],
          supportedCommands: ['runtime.get_workspace', 'runtime.update_workspace'], features: ['task_workspaces'],
        };
        else if (kind === 'runtime.get_workspace') result = structuredClone(workspaceFixture);
        else if (kind === 'runtime.update_workspace') {
          workspaceCalls.push(payload);
          if (payload.action === 'apply') workspaceFixture.changes = [];
          if (payload.action === 'stop_terminals') workspaceFixture.runningTerminals = false;
          if (payload.action === 'discard') workspaceFixture.workspace.status = 'discarded';
          if (payload.action === 'init_git') workspaceFixture.workspace.versioning = 'git';
          result = workspaceFixture.workspace;
        } else throw new Error('Unexpected workspace command: ' + kind);
        return { protocol: message.protocol, type: 'command_response', operationId: message.operationId, ok: true, result };
      },
      cancelOperation: async () => {}, startStream: async () => {}, stopStream: async () => {}, onStreamFrame: () => () => {},
    };
    window.workspaceBusy = false;
    window.showWorkspace = () => renderView(h(views.TaskWorkspaceBar, {
      key: 'workspace-task', sessionId: 'workspace-task', projectDir: 'D:/source', language: 'zh', busy: workspaceBusy,
      onChanged: async () => { workspaceRefreshes++; },
    }));
    window.workspaceButton = text => [...document.querySelectorAll('.task-workspace-bar button')].find(button => button.textContent === text);
    showWorkspace();
  `);
  await until("Boolean(workspaceButton('应用到原项目')) && !workspaceButton('应用到原项目').disabled", 'workspace review ready');
  assert.equal(await run('workspaceCalls.length'), 0, 'review must not apply files');
  await run("document.querySelector('.task-workspace-review').open = true; document.querySelector('.task-workspace-review details').open = true");
  await pause();
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/task-workspace-ui.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('.task-workspace-review').open = true; workspaceButton('应用到原项目').click()");
  assert.equal(await run('workspaceCalls.length'), 0, 'declined concrete action is not sent');
  await run('workspaceBusy = true; showWorkspace()');
  await until("workspaceButton('应用到原项目').disabled", 'active Turn disables workspace mutation');
  await run('workspaceBusy = false; showWorkspace()');
  await until("!workspaceButton('应用到原项目').disabled", 'settled Turn refreshes review');
  await run("confirmResult = true; workspaceButton('应用到原项目').click()");
  await until('workspaceRefreshes === 1', 'apply followed by actual refresh');
  assert.deepEqual(await run('workspaceCalls[0]'), { sessionId: 'workspace-task', action: 'apply', expectedRevision: 3, expectedSnapshotId: 'reviewed-file-state' });
  await until("workspaceButton('应用到原项目').disabled", 'empty pending diff cannot apply again');
  await until("!workspaceButton('刷新').disabled", 'apply action has fully settled');
  await run("workspaceFixture.runningTerminals = true; workspaceButton('刷新').click()");
  await until("Boolean(workspaceButton('停止工作区终端'))", 'background terminal action');
  assert.equal(await run("workspaceButton('丢弃副本').disabled"), true);
  await run("workspaceButton('停止工作区终端').click()");
  await until('workspaceRefreshes === 2', 'confirmed terminal stop');
  await until("!workspaceButton('丢弃副本').disabled", 'terminal stop action has fully settled');
  await run("workspaceButton('丢弃副本').click()");
  await until("document.querySelector('.task-workspace-bar')?.textContent.includes('任务副本已丢弃')", 'disposal status');
  await run('renderView(null)');
  await pause();
  await run("workspaceFixture.workspace = { ...workspaceFixture.workspace, mode: 'direct', workspaceDir: 'D:/source', status: 'ready', versioning: 'none' }; workspaceFixture.changes = []; showWorkspace()");
  await until("Boolean(workspaceButton('创建 Git 仓库'))", 'Local folder offers explicit repository creation');
  assert.equal(await run("document.querySelector('.task-workspace-heading span').textContent"), '项目目录', 'the Runtime Local workspace is shown as the project directory');
  assert.equal(await run("document.querySelector('.task-workspace-heading code').textContent"), 'D:/source');
  assert.equal(await run("document.querySelector('.task-workspace-bar select')"), null, 'automatic workspace presentation does not expose a mode selector');
  assert.equal(await run("Boolean(workspaceButton('丢弃副本')) || Boolean(workspaceButton('应用到原项目'))"), false, 'Local never offers source-copy disposal');
  await run("workspaceButton('创建 Git 仓库').click()");
  await until("!workspaceButton('创建 Git 仓库')", 'Git version capability refreshes after explicit initialization');
  assert.equal(await run("workspaceCalls.at(-1).action"), 'init_git');
  await run('renderView(null)');
  await pause();
};
