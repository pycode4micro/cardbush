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
              onClose: ()=>{}, onRevert: act })))));
    };
    showUndo();
  `);
  const inline = '.assistant-changed-files-revert';
  const single = '.change-review-file-heading .secondary-button';
  await until(`document.querySelector('${inline}')?.textContent === '撤回'`, 'initial inline revert');
  await run(`document.querySelector('${inline}').click()`);
  await until(`document.querySelector('${inline}').disabled && document.querySelector('${single}').disabled`, 'both entry points disable during a mutation');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '取消撤回'`, 'inline undo revert');
  assert.equal(await run(`document.querySelector('${single}').textContent`), '取消撤回');
  assert.equal(await run("document.querySelectorAll('.change-review-summary .danger-soft-button').length"), 0, 'duplicate bulk action is removed');
  assert.equal(await run('document.querySelectorAll(".assistant-changed-file").length'), 1, 'reverted file remains reviewable');
  await run(`document.querySelector('${single}').click(); void 0;`);
  await until('undoCalls.length === 2', 'review can restore inline revert');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'restore re-enables revert');
  await run(`document.querySelector('${single}').click()`);
  await until('undoCalls.length === 3', 'selected turn revert');
  await run('finishUndo()');
  await until(`document.querySelector('${single}').textContent === '取消撤回'`, 'selected turn undo is actionable');
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
  await run(`document.querySelector('${single}').click()`);
  await until('undoCalls.length === 4', 'selected turn restore after history reload');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'successful restore overrides stale replay until next refresh');
  await run(`
    window.terminalReviewCalls = []; window.terminalRevertCalls = [];
    window.showTerminalChanges = (status, withChanges = true) => {
      const edit = undoMessage().toolExecutions[0];
      const tools = withChanges ? [{ ...edit, metadata: { ...edit.metadata, revert_status: undefined } }] : [];
      const message = { id: 'terminal-answer', role: 'assistant', content: '', status,
        conversationId: 'terminal-edits', turnId: 'one', toolExecutions: tools,
        loopHistory: [{ id: 'edit-progress', role: 'assistant', content: '正在检查修改结果。',
          turnId: 'one', toolExecutions: tools }] };
      renderView(h(views.MessageBubble, { message, language: 'zh', sending: status === 'running',
        activeTurnId: status === 'running' ? 'one' : '', activeAssistantMessageId: 'terminal-answer',
        onRegenerate: async()=>{}, onEditUserMessage: async()=>{}, onRetryGuidance: async()=>{},
        onRevertChangeReport: async (report, source) => terminalRevertCalls.push({ report, turnId: source.turnId }),
        onOpenChangeReview: file => terminalReviewCalls.push(file ?? 'all'), onOpenScene: ()=>{} }));
    };
    showTerminalChanges('running');
  `);
  await pause();
  assert.equal(await run(`document.querySelector('.assistant-changed-files-summary') === null`), true,
    'the live turn keeps its existing progress presentation');
  await run("showTerminalChanges('failed')");
  await pause();
  assert.equal(await run("document.querySelector('.assistant-changed-files-summary') === null"), true,
    'failure does not expose the completion-only changed-files summary');
  for (const status of ['stopped', 'completed']) {
    await run(`showTerminalChanges('${status}')`);
    await until(`document.querySelector('.assistant-changed-files-title')?.textContent === '已编辑 1 个文件'`,
      status + ' retains changes even without a final answer');
    assert.equal(await run(`document.querySelectorAll('.assistant-changed-files-summary').length`), 1,
      'one summary across the turn and its loop history');
    assert.equal(await run(`document.querySelectorAll('.assistant-changed-file').length`), 1,
      'the same execution in loop history is not counted twice');
    assert.equal(await run(`document.querySelector('.assistant-changed-files-totals').textContent`), '+1-1');
    await run(`document.querySelector('.assistant-changed-files-review').click();
      document.querySelector('.assistant-changed-file').click();
      document.querySelector('${inline}').click();`);
  }
  assert.deepEqual(await run('terminalReviewCalls'), ['all', 'src/file.ts', 'all', 'src/file.ts']);
  assert.deepEqual(await run(`terminalRevertCalls.map(call => ({ turnId: call.turnId, files: call.report.files.map(file => file.path) }))`),
    Array.from({ length: 2 }, () => ({ turnId: 'one', files: ['src/file.ts'] })),
    'terminal summaries retain review and revert actions with the original turn');
  await run(`showTerminalChanges('stopped', false)`);
  await pause();
  assert.equal(await run(`document.querySelector('.assistant-changed-files-summary') === null`), true,
    'stopping without file changes does not create an empty summary');
  await run('renderView(null)');
  console.log('Undo revert UI passed: inline/selected-turn actions, one review toolbar, history replay, session isolation, both themes, and stopped/completed change summaries.');
};
