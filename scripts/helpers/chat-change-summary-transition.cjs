const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
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
        window.changeTransitionComposer = document.querySelector('.composer-surface textarea');
        window.changeTransitionFrames = [];
        window.sampleChangeTransition = () => {
          changeTransitionFrames.push({
            live: document.querySelectorAll('.composer-top-accessory .turn-change-review').length,
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
        window.changeTransitionReview = null;
        updateChat({ messages: changeTransitionMessages, changeReports: views.changeReportsFromMessages(changeTransitionMessages),
          onOpenChangeReview: (...args) => { window.changeTransitionReview = args; } });
      `);
      await until("!!document.querySelector('.composer-top-accessory .turn-change-review')", 'actual new edits render above the input');
      assert.equal(await run("document.querySelector('.composer-surface textarea') === changeTransitionComposer"), true,
        'showing file changes does not remount the input');
      assert.equal(await run("document.querySelector('.turn-change-review').textContent"), 'file 1|+3-1',
        'live summary counts only this turn');
      await run("document.querySelector('.turn-change-review').click();void 0");
      assert.equal(await run('changeTransitionReview'), null, 'the statistics capsule does not open review');
      assert.equal(await run("document.querySelector('.turn-change-review').matches('button,[role=button]')"), false,
        'the capsule is a summary, not an action button');
      await run("document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));void 0");
      await until("!!document.querySelector('.turn-change-preview:popover-open')", 'file hover preview opens above the summary');
      assert.equal(await run("document.querySelector('.turn-change-files').textContent"), 'next-turn.ts+3-1',
        'hover shows only the active turn file and its counts');
      assert.equal(await run(`(()=>{const tip=document.querySelector('.turn-change-preview').getBoundingClientRect();
        const trigger=document.querySelector('.turn-change-review').getBoundingClientRect();
        return tip.bottom <= trigger.top && tip.left >= 0 && tip.right <= innerWidth;})()`), true,
        'hover is above the summary and within the window');
      await pause(180);
      await fs.writeFile(path.join(root, 'tmp', `file-change-hover-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      const pointer = (type, point) => window.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1 });
      const targets = await run(`(()=>{const card=document.querySelector('.turn-change-preview').getBoundingClientRect(),
        trigger=document.querySelector('.turn-change-review').getBoundingClientRect(),row=document.querySelector('.turn-change-file-action').getBoundingClientRect();
        return{trigger:{x:trigger.x+trigger.width/2,y:trigger.y+trigger.height/2},gap:{x:trigger.x+trigger.width/2,y:(trigger.top+card.bottom)/2},row:{x:row.x+row.width/2,y:row.y+row.height/2}}})()`);
      pointer('mouseMove', targets.trigger); await pause(40);
      pointer('mouseMove', targets.gap); await pause(200);
      assert.equal(await run("!!document.querySelector('.turn-change-preview:popover-open')"), true,
        'slow movement across the gap keeps file actions reachable');
      pointer('mouseMove', targets.row); pointer('mouseDown', targets.row); await pause(80);
      assert.equal(await run("!!document.querySelector('.turn-change-preview:popover-open')"), true,
        'pointerdown inside a file row does not dismiss it before click');
      pointer('mouseUp', targets.row);
      await until("changeTransitionReview?.[0] === 'src/next-turn.ts' && !document.querySelector('.turn-change-preview')", 'clicking the file opens its changes and closes the list');
      assert.equal(await run('changeTransitionReview[1]'), 'next-turn', 'file review stays scoped to its owning turn');
      await run("document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));void 0");
      await until("!!document.querySelector('.turn-change-preview')", 'file list reopens after review');
      await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0");
      await until("!document.querySelector('.turn-change-preview')", 'Escape dismisses the file hover');
      await run(`
        window.changeHoverReports = chatProps.changeReports;
        updateChat({changeReports:[...changeHoverReports,
          {id:'more-edits',messageId:'change-new-reply',turnId:'next-turn',fileCount:2,additions:6,deletions:1,
            files:[{path:'src/next-turn.ts',additions:2,deletions:1,diff:'',lines:[]},
              {path:'lib/next-turn.ts',additions:4,deletions:0,diff:'',lines:[]}]},
          {id:'reverted-edit',messageId:'change-new-reply',turnId:'next-turn',fileCount:1,additions:100,deletions:50,reverted:true,
            files:[{path:'reverted.ts',additions:100,deletions:50,diff:'',lines:[]}]}]});
        document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));
        document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));void 0;
      `);
      await until("document.querySelectorAll('.turn-change-files > li').length === 2", 'multiple edits to one file are combined');
      assert.deepEqual(await run("[...document.querySelectorAll('.turn-change-files > li')].map(el=>el.textContent)"),
        ['next-turn.tssrc/next-turn.ts+5-2','next-turn.tslib/next-turn.ts+4-0'],
        'same-name files are distinguished by path; reverted changes stay excluded');
      await run("document.querySelectorAll('.turn-change-file-action')[1].click();void 0");
      assert.deepEqual(await run('changeTransitionReview'), ['lib/next-turn.ts', 'next-turn'], 'same-name files open their own path');
      await run("document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));void 0");
      await run(`updateChat({changeReports:[...changeHoverReports,
        {id:'many-edits',messageId:'change-new-reply',turnId:'next-turn',fileCount:20,additions:20,deletions:0,
          files:Array.from({length:20},(_,index)=>({path:'src/file-'+index+'.ts',additions:1,deletions:0,diff:'',lines:[]}))}]});`);
      await until("document.querySelectorAll('.turn-change-files > li').length === 21", 'hover refreshes while new changes arrive');
      await run("document.querySelector('.turn-change-files').scrollTop=1000;void 0"); await pause(50);
      assert.equal(await run("!!document.querySelector('.turn-change-preview:popover-open') && document.querySelector('.turn-change-files').scrollTop > 0"), true,
        'a long file list scrolls without dismissing the hover');
      await run("updateChat({changeReports:changeHoverReports});document.querySelector('.composer-surface textarea').dispatchEvent(new Event('scroll',{bubbles:false}));void 0");
      await until("!document.querySelector('.turn-change-preview')", 'surrounding scroll dismisses the hover');
      await run("document.querySelector('.turn-change-review').dispatchEvent(new PointerEvent('pointerout',{bubbles:true,pointerType:'mouse'}));void 0");
      const ownsDebugger = !window.webContents.debugger.isAttached();
      if (ownsDebugger) window.webContents.debugger.attach('1.3');
      try {
        // Hidden Chromium windows need focus emulation for :focus-visible.
        await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await run("document.querySelector('.turn-change-review').focus();void 0");
        await until("!!document.querySelector('.turn-change-preview')", 'keyboard focus can reveal file details');
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
        await until("document.activeElement?.classList.contains('turn-change-file-action')", 'keyboard can move from capsule into the file list');
        await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));void 0");
        await until("!document.querySelector('.turn-change-preview') && document.activeElement?.classList.contains('turn-change-review')", 'Escape restores focus to the summary');
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38});
        await until("document.activeElement?.classList.contains('turn-change-file-action')", 'keyboard reopens file actions after dismissal');
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
        await until("!document.querySelector('.turn-change-preview')", 'activating a file opens review and dismisses the hover');
      } finally {
        await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:false});
        if (ownsDebugger) window.webContents.debugger.detach();
      }
      assert.equal(await run('changeTransitionReview[1]'), 'next-turn', 'review opens the owning turn');
      assert.equal(await run('changeTransitionReview[0]'), 'src/next-turn.ts', 'keyboard review receives the file path');
      await run(`changeTransitionRunning = changeTransitionRunning.map(message => message.role === 'assistant'
        ? { ...message, content: 'Finishing the result.', metadata: { transcript_kind: 'assistant_final' } } : message);
        updateChat({messages:[...changeTransitionHistory, ...changeTransitionRunning]});`);
      await until("!!document.querySelector('.assistant-final-answer')", 'final response starts streaming');
      assert.equal(await run("document.querySelectorAll('.composer-top-accessory .turn-change-review').length"), 1,
        'file changes remain above the input until the turn finishes');
      assert.equal(await run("document.querySelectorAll('.assistant-activity-line .turn-change-review').length"), 0,
        'thinking and generation lines contain no duplicate changes button');
      await run(`updateChat({ sending: false, activeTurnId: '', messages: [...changeTransitionHistory,
        ...changeTransitionRunning.map(message => ({ ...message, status: 'completed',
          content: message.role === 'assistant' ? 'Next file updated.' : message.content }))] });`);
      await until("!!document.querySelector('[data-message-id=change-new-reply] .turn-artifacts-trigger')", 'new edits remain available after completion');
      assert.equal(await run("document.querySelectorAll('.turn-change-review').length"), 0, 'completed progress leaves no duplicate summary');
      assert.equal(await run("document.querySelector('.composer-surface textarea') === changeTransitionComposer"), true,
        'hiding file changes does not remount the input');
      assert.equal(await run("document.querySelectorAll('.turn-artifacts-trigger').length"), 2, 'both turns retain their own artifacts');
    }
  } finally {
    await run('cancelAnimationFrame(window.changeTransitionFrame); viewTheme = changeTransitionTheme; updateChat(changeTransitionSaved);');
  }
  console.log('File-change submission transitions passed: no stale summary flash, stable history, and correctly scoped new edits.');
};
