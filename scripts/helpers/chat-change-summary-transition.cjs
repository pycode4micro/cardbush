const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause }) => {
  await run('window.changeTransitionSaved = { ...chatProps, transcriptDelivery: chatProps.transcriptDelivery }; window.changeTransitionTheme = window.viewTheme; void 0;');
  try {
    for (const [theme, delivery] of [['theme-dark', 'frame'], ['theme-bright', 'batched']]) {
      await run(`
        window.viewTheme = ${JSON.stringify(theme)};
        window.changeTransitionEdit = (turnId, additions, deletions) => ({
          id: 'edit-' + turnId, name: 'workspace_checkpoint', state: 'completed', success: true,
          summary: 'Workspace changes', output: '', durationMs: 1, turnId, metadata: {
            kind: 'file_change', workspaceCheckpoint: true,
            workspaceChanges: [{ path: 'src/' + turnId + '.ts', status: 'modified', additions, deletions }],
          },
        });
        window.changeTransitionHistory = [
          { id: 'change-old-user', role: 'user', turnId: 'previous-turn', content: 'Edit the file' },
          { id: 'change-old-reply', role: 'assistant', turnId: 'previous-turn', status: 'completed',
            content: 'File updated.', toolExecutions: [changeTransitionEdit('previous-turn', 7, 2)] },
        ];
        window.changeTransitionPending = [
          { id: 'change-new-user', role: 'user', content: 'Continue', status: 'pending' },
          { id: 'change-new-reply', role: 'assistant', content: '',
            metadata: { optimistic_request_id: 'change-new-user' } },
        ];
        updateChat({ activeConversationId: 'change-transition-' + viewTheme, language: 'en',
          messages: changeTransitionHistory, changeReports: views.changeReportsFromMessages(changeTransitionHistory),
          sending: false, activeTurnId: '', loading: false, historyLoading: false,
          transcriptDelivery: ${JSON.stringify(delivery)}, activeGoal: null, goalWaiting: false, stopping: false,
          pendingInteraction: null, error: null, draft: '', queuedMessageCount: 0, queuedMessages: [] });
      `);
      await until("!!document.querySelector('[data-message-id=change-old-reply] .turn-artifacts-trigger')", 'completed file edits render');
      await run(`
        window.changeTransitionOldArtifact = document.querySelector('[data-message-id=change-old-reply] .turn-artifacts-trigger');
        window.changeTransitionFrames = [];
        window.sampleChangeTransition = () => {
          changeTransitionFrames.push({
            live: document.querySelectorAll('.message-list .turn-change-review').length,
            retained: changeTransitionOldArtifact === document.querySelector('[data-message-id=change-old-reply] .turn-artifacts-trigger'),
          });
          window.changeTransitionFrame = requestAnimationFrame(sampleChangeTransition);
        };
        sampleChangeTransition();
        updateChat({ sending: true });
      `);
      await pause(80);
      await run('updateChat({ messages: [...changeTransitionHistory, ...changeTransitionPending] });');
      await until("!!document.querySelector('[data-message-id=change-new-reply] .assistant-thinking-process')", 'optimistic assistant waits for admission');
      await pause(100);
      // The runtime id can arrive before the optimistic row is reconciled.
      await run("updateChat({ activeTurnId: 'next-turn' });");
      await pause(80);
      await run(`
        window.changeTransitionRunning = changeTransitionPending.map(message => ({ ...message,
          turnId: 'next-turn', status: message.role === 'assistant' ? 'streaming' : 'completed' }));
        updateChat({ messages: [...changeTransitionHistory, ...changeTransitionRunning] });
      `);
      await pause(100);
      const frames = await run('cancelAnimationFrame(changeTransitionFrame); changeTransitionFrames');
      assert.ok(frames.length >= 4, 'samples the admission and optimistic render transitions');
      assert.ok(frames.every(frame => frame.live === 0),
        theme + ': previous edits never flash as new-turn progress: ' + JSON.stringify(frames));
      assert.ok(frames.every(frame => frame.retained), 'historical artifacts stay mounted throughout submission');

      await run(`
        changeTransitionRunning = changeTransitionRunning.map(message => message.role === 'assistant'
          ? { ...message, toolExecutions: [changeTransitionEdit('next-turn', 3, 1)] } : message);
        window.changeTransitionMessages = [...changeTransitionHistory, ...changeTransitionRunning];
        updateChat({ messages: changeTransitionMessages, changeReports: views.changeReportsFromMessages(changeTransitionMessages),
          onOpenChangeReview: (...args) => { window.changeTransitionReview = args; } });
      `);
      await until("!!document.querySelector('[data-message-id=change-new-reply] .turn-change-review')", 'actual new edits render');
      assert.equal(await run("document.querySelector('.turn-change-review').textContent"), '1 changed files+3-1',
        'live summary counts only this turn');
      await run("document.querySelector('.turn-change-review').click()");
      assert.equal(await run('changeTransitionReview[1]'), 'next-turn', 'review opens the owning turn');
      await run(`updateChat({ sending: false, activeTurnId: '', messages: [...changeTransitionHistory,
        ...changeTransitionRunning.map(message => ({ ...message, status: 'completed',
          content: message.role === 'assistant' ? 'Next file updated.' : message.content }))] });`);
      await until("!!document.querySelector('[data-message-id=change-new-reply] .turn-artifacts-trigger')", 'new edits remain available after completion');
      assert.equal(await run("document.querySelectorAll('.turn-change-review').length"), 0, 'completed progress leaves no duplicate summary');
      assert.equal(await run("document.querySelectorAll('.turn-artifacts-trigger').length"), 2, 'both turns retain their own artifacts');
    }
  } finally {
    await run('cancelAnimationFrame(window.changeTransitionFrame); viewTheme = changeTransitionTheme; updateChat(changeTransitionSaved);');
  }
  console.log('File-change submission transitions passed: no stale summary flash, stable history, and correctly scoped new edits.');
};
