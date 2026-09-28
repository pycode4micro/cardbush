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
  const inline = '.turn-artifacts-revert';
  const openArtifacts = async () => {
    await run("if(document.querySelector('.turn-artifacts-trigger')?.getAttribute('aria-expanded')!=='true') document.querySelector('.turn-artifacts-trigger')?.click(); void 0");
    await until("document.querySelector('.turn-artifacts-popover')?.matches(':popover-open')", 'artifact popover');
  };
  await until("!!document.querySelector('.turn-artifacts-trigger')", 'artifact entry');
  assert.equal(await run("document.querySelector('.assistant-changed-files-summary')"), null, 'old body card is removed');
  assert.equal(await run("document.querySelector('.turn-artifacts-trigger').closest('.message-actions').querySelector('time').nextElementSibling.className"), 'turn-artifacts');
  await openArtifacts();
  const single = '.change-review-file-heading .secondary-button';
  await until(`document.querySelector('${inline}')?.textContent === '撤回'`, 'initial inline revert');
  await run(`document.querySelector('${inline}').click()`);
  await until(`document.querySelector('${inline}').disabled && document.querySelector('${single}').disabled`, 'both entry points disable during a mutation');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤销撤回'`, 'inline undo revert');
  assert.equal(await run(`document.querySelector('${single}').textContent`), '取消撤回');
  assert.equal(await run("document.querySelectorAll('.change-review-summary .danger-soft-button').length"), 0, 'duplicate bulk action is removed');
  assert.equal(await run('document.querySelectorAll(".turn-artifacts-file").length'), 1, 'reverted file remains reviewable');
  await run(`document.querySelector('${single}').click(); void 0;`);
  await until('undoCalls.length === 2', 'review can restore inline revert');
  await run('finishUndo()');
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'restore re-enables revert');
  await run(`document.querySelector('${single}').click()`);
  await until('undoCalls.length === 3', 'selected turn revert');
  await run('finishUndo()');
  await until(`document.querySelector('${single}').textContent === '取消撤回'`, 'selected turn undo is actionable');
  await run(`undoSession = 'session-b'; showUndo()`);
  await pause(); await openArtifacts();
  await until(`document.querySelector('${inline}').textContent === '撤回'`, 'same Turn id in another session stays independent');
  await run(`undoSession = 'session-a'; undoLanguage = 'en'; showUndo()`);
  await pause(); await openArtifacts();
  await until(`document.querySelector('${inline}').textContent === 'Undo revert'`, 'English and original session state');
  await run(`undoStates = new Map(); persistedReverted = true; undoLanguage = 'zh'; showUndo()`);
  await until(`document.querySelector('${inline}').textContent === '撤销撤回'`, 'persisted backend state works without overrides');
  for (const theme of ['theme-bright', 'theme-dark']) {
    await run(`viewTheme = '${theme}'; showUndo()`);
    await pause();
    assert.equal(await run(`(() => {
      const button = document.querySelector('${inline}'), card = document.querySelector('.turn-artifacts-popover');
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
  assert.equal(await run(`document.querySelector('.turn-artifacts-trigger') === null`), true,
    'the live turn keeps its existing progress presentation');
  await run("showTerminalChanges('failed')");
  await pause();
  assert.equal(await run("document.querySelector('.turn-artifacts-trigger') === null"), true,
    'failure does not expose the completion-only changed-files summary');
  for (const status of ['stopped', 'completed']) {
    await run(`showTerminalChanges('${status}')`);
    await until(`document.querySelector('.turn-artifacts-trigger')?.textContent === '产物1'`, status + ' has artifacts');
    await openArtifacts();
    assert.equal(await run(`document.querySelectorAll('.turn-artifacts-file').length`), 1, 'loop evidence is deduplicated');
    assert.equal(await run(`document.querySelector('.turn-artifacts-file small').textContent`), '+1-1');
    assert.equal(await run(`document.querySelector('.turn-artifacts-popover [role=menuitem]').className`), 'turn-artifacts-revert', 'revert is the first row');
    assert.equal(await run(`document.querySelector('.assistant-changed-files-review')`), null, 'review action is removed');
    await run(`document.querySelector('${inline}').click();`);
    await pause();
    await run(`document.querySelector('.turn-artifacts-file').click();`);
    await until(`document.querySelector('.turn-artifacts-trigger').getAttribute('aria-expanded') === 'false'`, 'file opens and menu closes');
  }
  assert.deepEqual(await run('terminalReviewCalls'), [], 'artifact preview does not route to review');
  assert.deepEqual(await run(`terminalRevertCalls.map(call => ({ turnId: call.turnId, files: call.report.files.map(file => file.path) }))`),
    Array.from({ length: 2 }, () => ({ turnId: 'one', files: ['src/file.ts'] })), 'revert stays scoped to the original turn');
  await run(`showTerminalChanges('stopped', false)`);
  await pause();
  assert.equal(await run(`document.querySelector('.turn-artifacts-trigger') === null`), true,
    'stopping without file changes does not create an empty summary');
  await run(`
    window.artifactOpened = [];
    window.captureArtifact = event => artifactOpened.push(event.detail.target);
    window.addEventListener('cardbush:open-inspector', captureArtifact);
    persistedReverted = false;
    window.artifactOne = { ...undoMessage(), conversationId: 'artifacts', turnId: 'one', status: 'completed' };
    artifactOne.toolExecutions[0].artifacts = [
      { id: 'same-edit', path: 'src/file.ts', name: 'file.ts', type: 'document' },
      { id: 'report', path: 'report.md', name: 'report.md', type: 'document' },
      { id: 'report-duplicate', path: 'report.md', name: 'Duplicate report', type: 'document' }
    ];
    window.artifactTwo = { ...structuredClone(artifactOne), id: 'assistant-two', turnId: 'two' };
    artifactTwo.toolExecutions = [{ ...artifactTwo.toolExecutions[0], id: 'edit-two', turnId: 'two', artifacts: [],
      metadata: { ...artifactTwo.toolExecutions[0].metadata, workspaceChanges: [{ path: 'second.cs', status: 'added', additions: 1, deletions: 0 }] } }];
    window.artifactMessages = [artifactOne, artifactTwo];
    window.showArtifacts = (readOnly = false, single = false) => renderView(h('div', { style: { padding: 24 } },
      (single ? [artifactOne] : artifactMessages).map(message => h(views.MessageBubble, { key: message.id, message,
        changeSummaryMessages: artifactMessages, language: 'zh', sending: false, keepActionsVisible: true,
        activeTurnId: '', activeAssistantMessageId: '',
        readOnlyActions: readOnly, onRegenerate: async()=>{}, onEditUserMessage: async()=>{}, onRetryGuidance: async()=>{},
        onRevertChangeReport: async()=>{throw Error('The file changed after this turn.');}, onOpenScene: ()=>{} }))));
    showArtifacts();
  `);
  await until(`document.querySelectorAll('.turn-artifacts-trigger').length === 2`, 'separate artifact entries');
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.turn-artifacts-trigger')).map(button=>button.textContent)`), ['产物2', '产物1']);
  assert.equal(await run(`document.querySelector('.message-tool-outputs')`), null, 'completed document artifacts use the menu, without a second body list');
  const before = await run(`({ height: document.documentElement.scrollHeight, top: document.querySelectorAll('.message-row')[1].getBoundingClientRect().top })`);
  await openArtifacts();
  assert.deepEqual(await run(`Array.from(document.querySelectorAll('.turn-artifacts-file > span:not(.local-file-type-icon)')).map(row=>row.textContent)`), ['file.ts', 'report.md']);
  assert.deepEqual(await run(`({ height: document.documentElement.scrollHeight, top: document.querySelectorAll('.message-row')[1].getBoundingClientRect().top })`), before,
    'opening artifacts does not shift the conversation');
  assert.equal(await run(`(() => {
    const button = document.querySelector('.turn-artifacts-revert'), sample = document.createElement('i');
    sample.style.color = 'var(--danger)'; button.appendChild(sample);
    const red = getComputedStyle(button).color === getComputedStyle(sample).color; sample.remove(); return red;
  })()`), true, 'revert uses the theme danger red');
  await run(`document.querySelector('.turn-artifacts-revert').click()`);
  await until(`document.querySelector('.turn-artifacts-error')?.textContent.includes('changed after')`, 'revert errors remain visible');
  await run(`document.querySelector('.turn-artifacts-popover').dispatchEvent(new KeyboardEvent('keydown', {key:'End',bubbles:true}));`);
  assert.equal(await run(`document.activeElement.title`), 'report.md', 'keyboard reaches the last artifact');
  await run(`document.activeElement.click()`);
  await until(`artifactOpened.includes('report.md')`, 'artifact opens in the file inspector');
  await run(`document.querySelectorAll('.turn-artifacts-trigger')[1].click()`);
  await until(`document.querySelectorAll('.turn-artifacts-popover:popover-open .turn-artifacts-file').length === 1`, 'second turn opens its own list');
  assert.equal(await run(`document.querySelector('.turn-artifacts-popover:popover-open .turn-artifacts-file').title`), 'second.cs');
  await run(`document.querySelector('.turn-artifacts-popover:popover-open').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true,cancelable:true}))`);
  await until(`!document.querySelector('.turn-artifacts-popover:popover-open')`, 'Escape dismisses');
  assert.equal(await run(`document.activeElement === document.querySelectorAll('.turn-artifacts-trigger')[1]`), true, 'Escape restores trigger focus');
  const originalSize = window.getSize();
  window.setSize(460, 410);
  await run(`artifactOne.toolExecutions[0].artifacts.push(...Array.from({length:25},(_,index)=>({id:'more-'+index,path:'generated/long-artifact-name-'+index+'.md',name:'long-artifact-name-'+index+'.md',type:'document'}))); showArtifacts(false, true);`);
  await pause();
  await run(`document.querySelector('.message-row').parentElement.style.cssText='position:fixed;bottom:12px;right:12px;width:calc(100% - 24px)';
    document.querySelector('.message-actions').style.justifyContent='flex-end';`);
  await openArtifacts();
  assert.equal(await run(`(() => {
    const menu = document.querySelector('.turn-artifacts-popover'), r = menu.getBoundingClientRect(), t = document.querySelector('.turn-artifacts-trigger').getBoundingClientRect();
    return r.left>=11 && r.right<=innerWidth-11 && r.top>=11 && r.bottom<=t.top && menu.scrollWidth<=menu.clientWidth+1 && menu.scrollHeight>menu.clientHeight;
  })()`), true, 'long list opens upward, within the narrow viewport, without horizontal overflow');
  await run(`document.querySelector('.turn-artifacts-popover').scrollTop=100`); await pause();
  assert.equal(await run(`!!document.querySelector('.turn-artifacts-popover:popover-open')`), true, 'scrolling the list keeps it open');
  fs.writeFileSync(path.join(root, 'tmp', 'turn-artifacts-narrow.png'), (await window.webContents.capturePage()).toPNG());
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: 4, y: 4 });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: 4, y: 4 });
  await until(`!document.querySelector('.turn-artifacts-popover:popover-open')`, 'outside click dismisses');
  window.setSize(...originalSize); await pause();
  await run(`showArtifacts(true, true)`); await pause(); await openArtifacts();
  assert.equal(await run(`document.querySelector('.turn-artifacts-revert')`), null, 'read-only histories allow preview but no file mutation');
  await run(`window.removeEventListener('cardbush:open-inspector', captureArtifact)`);
  await run('renderView(null)');
  console.log('Turn artifacts UI passed: turn/session isolation, deduplication, direct preview, red revert/undo, history replay, keyboard/outside dismissal, read-only mode, both themes and narrow scrolling.');
};
