const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.viewTheme = 'theme-bright';
    window.undoStates = new Map(); window.undoBusy = false; window.undoSession = 'session-a';
    window.undoCalls = []; window.undoLanguage = 'zh'; window.persistedReverted = false;
    window.undoMessage = () => ({ id: 'assistant-one', role: 'assistant', content: '修改完成。',
      conversationId: undoSession, turnId: 'one', createdAt: '2026-09-13T10:00:00Z',
      toolExecutions: [{ id: 'edit-one', name: 'workspace_checkpoint', state: 'completed',
        success: true, summary: 'Workspace changes', output: '', durationMs: 1, turnId: 'one',
        createdAt: '2026-09-13T10:00:00Z', metadata: { kind: 'file_change', workspaceCheckpoint: true,
          ...(persistedReverted ? { revert_status: 'reverted' } : {}),
          workspaceChanges: [{ change_id: 'file-one', path: 'src/file.ts', status: 'modified', additions: 1, deletions: 1,
            metadata: { diff: '@@ -1,1 +1,1 @@\\n-before\\n+after' } }] } }] });
    window.showUndo = () => {
      const message = undoMessage();
      const reports = views.changeReportsFromMessages([message]);
      const restored = views.workspaceChangeReverted(undoStates, undoSession, reports[0]);
      const act = async report => {
        undoCalls.push({ session: undoSession, restored });
        const session = undoSession;
        undoBusy = true; showUndo();
        await new Promise(resolve => { window.finishUndo = resolve; });
        undoStates = new Map(undoStates).set(views.workspaceChangeKey(session, report), !restored);
        undoBusy = false; showUndo();
      };
      renderView(h(views.WorkspaceChangeStateContext.Provider, { value: { states: undoStates, busy: undoBusy } },
        h('div', { style: { padding: 24, width: '100%' } },
          h(views.MessageBubble, { message, language: undoLanguage, sending: false,
            activeTurnId: '', activeAssistantMessageId: '', onRegenerate: async()=>{}, onEditUserMessage: async()=>{},
            onRetryGuidance: async()=>{}, onRevertChangeReport: act, onOpenScene: ()=>{} }),
          h('aside', { className: 'right-inspector', style: { height: 430, width: '100%', marginTop: 20, maxWidth: 'none', flex: 'none' } },
            h(views.ConversationChangeDialog, { embedded: true, language: undoLanguage,
              conversation: { id: undoSession, title: 'Undo fixture' }, reports, notice: '',
              revertingChangeId: undoBusy ? 'conversation:' + undoSession : '',
              revertedChangeIds: new Set(restored ? reports.map(report => report.id) : []),
              onClose: ()=>{}, onRevert: act, onRevertAll: ()=>act(reports[0]) })))));
    };
    showUndo();
  `);
  const inline = '.assistant-changed-files-revert';
  const all = '.change-review-summary .danger-soft-button';
  const single = '.change-review-diff-pane header .secondary-button';
  await until(`document.querySelector('${inline}')?.textContent === '撤回'`, 'initial inline revert');
  await run(`document.querySelector('${inline}').click()`);
  await until(`document.querySelector('${inline}').disabled && document.querySelector('${all}').disabled && document.querySelector('${single}').disabled`, 'all entry points disable during a mutation');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '取消撤回'`, 'inline undo revert');
  assert.equal(await run(`document.querySelector('${single}').textContent`), '取消撤回');
  assert.equal(await run(`document.querySelector('${all}').textContent`), '取消全部撤回');
  assert.equal(await run('document.querySelectorAll(".assistant-changed-file").length'), 1, 'reverted file remains reviewable');
  await run(`document.querySelector('${single}').click(); void 0;`);
  await until('undoCalls.length === 2', 'review can restore inline revert');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'restore re-enables revert');
  await run(`document.querySelector('${all}').click()`);
  await until('undoCalls.length === 3', 'bulk revert');
  await run('finishUndo()');
  await until(`document.querySelector('${all}').textContent === '取消全部撤回'`, 'bulk undo is actionable');
  await run(`undoSession = 'session-b'; showUndo()`);
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'same Turn id in another session stays independent');
  await run(`undoSession = 'session-a'; undoLanguage = 'en'; showUndo()`);
  await until(`document.querySelector('${inline}').textContent === 'Undo revert'`, 'English and original session state');
  await run(`undoStates = new Map(); persistedReverted = true; undoLanguage = 'zh'; showUndo()`);
  await until(`document.querySelector('${inline}').textContent === '取消撤回'`, 'persisted backend state works without overrides');
  for (const theme of ['theme-bright', 'theme-dark']) {
    await run(`viewTheme = '${theme}'; showUndo()`);
    await pause();
    assert.equal(await run(`(() => {
      const button = document.querySelector('${inline}'), card = document.querySelector('.assistant-changed-files-summary');
      return button.scrollWidth <= button.clientWidth + 1 && button.getBoundingClientRect().right <= card.getBoundingClientRect().right;
    })()`), true, 'longer undo label fits');
    fs.writeFileSync(path.join(root, 'tmp', 'undo-revert-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  await run(`document.querySelector('${all}').click()`);
  await until('undoCalls.length === 4', 'bulk restore after history reload');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'successful restore overrides stale replay until next refresh');
  await run('renderView(null)');
  console.log('Undo revert UI passed: inline/review/bulk actions, shared busy state, history replay, session isolation and both themes.');
};
