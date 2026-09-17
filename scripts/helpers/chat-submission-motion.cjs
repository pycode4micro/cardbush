const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, root }) => {
  await run('window.submissionSaved = { ...chatProps }; window.submissionTheme = window.viewTheme; void 0;');
  try {
    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`
        window.viewTheme = ${JSON.stringify(theme)};
        window.submissionFrames = [];
        window.submissionFast = false;
        window.submissionHistory = Array.from({ length: 8 }, (_, i) => ({
          id: 'submit-history-' + i, role: i % 2 ? 'assistant' : 'user',
          content: ('History ' + i + '.\\n\\n').repeat(3), turnId: 'old-' + Math.floor(i / 2),
        }));
        window.submitFromComposer = () => {
          document.querySelector('textarea[data-composer-input]').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        };
        window.sampleSubmission = () => {
          const list = document.querySelector('.message-list');
          const old = list?.querySelector('[data-message-id="submit-history-7"]');
          const user = list?.querySelector('[data-message-id="submit-user"]');
          const reply = list?.querySelector('[data-message-id="submit-reply"]');
          const guide = list?.querySelector('[data-message-id="submit-guide"]');
          if (old) submissionFrames.push({ top: list.scrollTop, oldHeight: old.getBoundingClientRect().height,
            userTop: user ? user.getBoundingClientRect().top - list.getBoundingClientRect().top : null,
            userOpacity: user ? +getComputedStyle(user.querySelector('.user-bubble')).opacity : null,
            guideGap: guide && reply ? guide.getBoundingClientRect().top - reply.querySelector('.message-row').getBoundingClientRect().bottom : null,
            spacer: list.querySelector('.assistant-response-spacer')?.getBoundingClientRect().height ?? 0,
            motion: list.dataset.scrollAnimating ?? null });
          window.submissionFrame = requestAnimationFrame(sampleSubmission);
        };
        updateChat({ activeConversationId: 'submission-' + viewTheme, messages: submissionHistory,
          sending: false, activeTurnId: '', loading: false, historyLoading: false, draft: '',
          goalWaiting: false, pendingInteraction: null, changeReports: [], error: null,
          guidanceDeliveryMode: 'immediate', onDraftChange: draft => updateChat({ draft }),
          onSend: async text => {
            updateChat({ sending: true });
            await new Promise(resolve => setTimeout(resolve, 180));
            updateChat({ activeTurnId: 'submission-turn', messages: [...submissionHistory,
              { id: 'submit-user', role: 'user', content: text, turnId: 'submission-turn' },
              { id: 'submit-reply', role: 'assistant', content: 'Working on it.', turnId: 'submission-turn' }] });
            if (submissionFast) {
              await new Promise(resolve => setTimeout(resolve, 30));
              updateChat({ messages: chatProps.messages.map(message => message.id === 'submit-reply'
                ? { ...message, content: ('Fast response.\\n\\n').repeat(35) } : message) });
            }
          },
          onGuideMessage: async () => updateChat({ messages: [...chatProps.messages,
            { id: 'submit-guide', role: 'user', content: 'Use the same data', turnId: 'submission-turn',
              metadata: { turn_guidance: true, guidance_delivery: 'pending' } }] }),
        });
      `);
      await until('!!document.querySelector("[data-message-id=submit-history-7]")', 'submission history ready');
      await pause(450);
      const oldHeight = await run('document.querySelector("[data-message-id=submit-history-7]").getBoundingClientRect().height');
      await run('updateChat({ draft: "Start a new task" }); sampleSubmission();');
      await pause(30);
      await run('submitFromComposer()');
      await until('!!document.querySelector("[data-message-id=submit-user]")', 'optimistic submission arrives');
      await pause(550);
      const frames = await run('submissionFrames');
      assert.ok(frames.some(frame => frame.userTop == null), 'captures the asynchronous admission window');
      assert.ok(frames.every(frame => Math.abs(frame.oldHeight - oldHeight) < 2),
        'starting a task never stretches the previous reply: ' + JSON.stringify({ oldHeight, heights: [...new Set(frames.map(frame => frame.oldHeight))] }));
      assert.ok(frames.filter(frame => frame.userOpacity != null).every(frame => frame.userOpacity === 1),
        'submission never fades the new bubble during its scroll');
      const positions = frames.filter(frame => frame.userTop != null).map(frame => frame.userTop);
      assert.ok(positions.every((top, i) => i === 0 || top <= positions[i - 1] + 2),
        'submission scroll does not reverse or get restarted by stream following');
      assert.ok(positions.at(-1) > 100, 'the new short bubble does not occupy the top of the viewport');
      assert.ok(positions[0] - positions.at(-1) > 80,
        'the bubble travels from the composer toward its reading position');
      assert.ok(positions.filter(top => top > positions.at(-1) + 8 && top < positions[0] - 8).length >= 4,
        'submission has visible intermediate positions instead of an immediate jump');
      require('node:fs').writeFileSync(require('node:path').join(root, 'tmp', `submission-position-${theme}.png`),
        (await window.capturePage()).toPNG());

      const placedTop = await run('document.querySelector(".message-list").scrollTop');
      await run(`window.submissionInProgress = { ...chatProps };
        updateChat({ activeConversationId: 'submission-other', sending: false, activeTurnId: '',
          messages: [{ id: 'other-user', role: 'user', content: 'Another task' }] });`);
      await until('!!document.querySelector("[data-message-id=other-user]")', 'switch away with reserved tail');
      await run('submissionFrames = []; updateChat(submissionInProgress);');
      await until('!!document.querySelector("[data-message-id=submit-reply]")', 'restore submitted turn');
      await pause(150);
      assert.ok(await run(`submissionFrames.every(frame => Math.abs(frame.top - ${placedTop}) < 2)`),
        'returning to a short running turn restores its reading position from the first frame');

      const beforeGuidance = await run('document.querySelector(".message-list").scrollTop');
      await run('submissionFrames = []; updateChat({ draft: "Use the same data" });');
      await pause(30);
      await run('submitFromComposer()');
      await until('!!document.querySelector("[data-message-id=submit-guide]")', 'pending guidance appears');
      await pause(400);
      const guidance = await run('submissionFrames.filter(frame => frame.guideGap != null)');
      assert.ok(guidance.length > 0);
      assert.ok(guidance.every(frame => frame.guideGap >= 0 && frame.guideGap < 80),
        'guidance has normal message spacing in every frame, including pending delivery');
      assert.ok(guidance.every(frame => Math.abs(frame.top - beforeGuidance) < 3),
        'a visible guidance message does not create a new top-aligned turn: ' + JSON.stringify({ beforeGuidance, guidance: guidance.slice(0, 5) }));
      assert.ok(guidance.every(frame => frame.motion !== 'submission'), 'guidance never starts submission positioning');

      await run(`updateChat({ messages: [...chatProps.messages,
        { id: 'submit-continuation', role: 'assistant', content: ('Continued response.\\n\\n').repeat(24),
          turnId: 'submission-turn' }] });`);
      await until('!!document.querySelector("[data-message-id=submit-continuation]")', 'continued loop renders');
      await pause(400);
      assert.equal(await run('document.querySelector(".assistant-response-spacer")?.getBoundingClientRect().height'), 0,
        'real content consumes the reserved tail space');
      await run('cancelAnimationFrame(submissionFrame); updateChat({ sending: false, activeTurnId: "" });');
      await pause(60);
      await run('updateChat({ messages: submissionHistory, draft: "Start a new task" }); submissionFast = true;');
      await pause(120);
      await run('submissionFrames = []; sampleSubmission(); submitFromComposer();');
      await until('document.querySelector("[data-message-id=submit-reply]")?.textContent.includes("Fast response.")', 'fast response during placement');
      await pause(950);
      assert.equal(await run(`(() => {
        const list = document.querySelector('.message-list');
        const tail = list.querySelector('[data-message-id="submit-reply"]').getBoundingClientRect();
        const composer = document.querySelector('.composer-surface').getBoundingClientRect();
        return tail.bottom <= composer.top && tail.bottom >= list.getBoundingClientRect().top;
      })()`), true, 'a fast response is followed after placement completes, without losing its final update');
      await run(`updateChat({ messages: chatProps.messages.map(message => message.id === 'submit-reply'
        ? { ...message, content: 'Compact response' } : message) });`);
      await pause(100);
      assert.ok(await run('document.querySelector(".assistant-response-spacer").getBoundingClientRect().height > 0'));
      await run(`window.submissionFinished = { ...chatProps, sending: false, activeTurnId: '' };
        updateChat({ activeConversationId: 'submission-other', sending: false, activeTurnId: '',
          messages: [{ id: 'other-user', role: 'user', content: 'Another task' }] });`);
      await until('!!document.querySelector("[data-message-id=other-user]")', 'short task finishes while away');
      await run('submissionFrames = []; updateChat(submissionFinished);');
      await until('!!document.querySelector("[data-message-id=submit-reply]")', 'return to finished short task');
      await pause(100);
      assert.ok(await run('submissionFrames.length > 0 && submissionFrames.every(frame => frame.spacer === 0)'),
        'background completion never restores obsolete response padding');
      await run('cancelAnimationFrame(submissionFrame); updateChat({ sending: false, activeTurnId: "" });');
    }
    await run(`submissionHistory=[]; submissionFast=false;
      updateChat({activeConversationId:'submission-empty',messages:[],sending:false,activeTurnId:'',draft:'Start a new task'});`);
    await until('!!document.querySelector("textarea[data-composer-input]")', 'empty conversation composer');
    await pause(120);
    await run('submitFromComposer()');
    await until('!!document.querySelector("[data-message-id=submit-user]")', 'first user bubble');
    await pause(650);
    const firstPosition = await run(`(() => {
      const list=document.querySelector('.message-list').getBoundingClientRect();
      const user=document.querySelector('[data-message-id=submit-user] .user-bubble').getBoundingClientRect();
      const scroller=document.querySelector('.message-list');
      return {top:user.top-list.top,bottom:user.bottom,composer:document.querySelector('.composer-surface').getBoundingClientRect().top,
        scrollTop:scroller.scrollTop,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,
        padding:getComputedStyle(scroller.querySelector('.message-list-content')).paddingTop,
        spacer:scroller.querySelector('.assistant-response-spacer').getBoundingClientRect().height,
        readingAnchor:scroller.style.getPropertyValue('--submitted-user-reading-anchor')};
    })()`);
    assert.ok(firstPosition.top > 100 && firstPosition.bottom < firstPosition.composer,
      'the first bubble also settles below the top, with no history needed: '+JSON.stringify(firstPosition));
    console.log('First submission geometry:', firstPosition);
    await run(`window.shortCompletionFrames=[];
      window.sampleShortCompletion=()=>{
        const list=document.querySelector('.message-list');
        const user=list?.querySelector('[data-message-id=submit-user] .user-bubble');
        if(user) shortCompletionFrames.push(user.getBoundingClientRect().top-list.getBoundingClientRect().top);
        window.shortCompletionFrame=requestAnimationFrame(sampleShortCompletion);
      };
      sampleShortCompletion();
      updateChat({sending:false,activeTurnId:'',messages:chatProps.messages.map(message=>message.role==='assistant'
        ? {...message,status:'completed',metadata:{transcript_kind:'assistant_final'},content:'你好！有什么可以帮你的吗？'}:message)});`);
    await pause(450);
    const finishedPositions = await run('cancelAnimationFrame(shortCompletionFrame); shortCompletionFrames');
    assert.ok(finishedPositions.every(top=>Math.abs(top-firstPosition.top)<3),
      'a short completed reply must not push the user bubble down toward the composer: '+JSON.stringify(finishedPositions));
    require('node:fs').writeFileSync(require('node:path').join(root, 'tmp', 'short-completed-conversation.png'),
      (await window.capturePage()).toPNG());
    await run(`window.finishedShortChat={...chatProps}; updateChat({activeConversationId:'short-other',messages:[{id:'short-other-user',role:'user',content:'Another conversation'}]});`);
    await until('!!document.querySelector("[data-message-id=short-other-user]")', 'leave completed short conversation');
    await run('updateChat(finishedShortChat)');
    await until('!!document.querySelector("[data-message-id=submit-user]")', 'return to completed short conversation');
    const restoredShortTop = await run(`document.querySelector('[data-message-id=submit-user] .user-bubble').getBoundingClientRect().top-document.querySelector('.message-list').getBoundingClientRect().top`);
    assert.ok(Math.abs(restoredShortTop-firstPosition.top)<3,'completed short conversations retain their reading position on return');
    const originalSize = window.getSize();
    const responsiveStyle = await window.webContents.insertCSS('.app {width:100vw!important;height:100vh!important}');
    try {
      window.setSize(500, 620);
      for (const [name, text] of [['narrow', 'Small window request'], ['long', ('Detailed request, with readable context.\n\n').repeat(12)]]) {
        await run(`submissionHistory=[{id:'submit-history-7',role:'assistant',content:'Earlier context'}];
          updateChat({activeConversationId:${JSON.stringify('submission-'+name)},messages:submissionHistory,sending:false,activeTurnId:'',draft:${JSON.stringify(text)}});`);
        await until('!!document.querySelector("[data-message-id=submit-history-7]")', name+' history');
        await pause(120);
        await run('submitFromComposer()');
        await until('!!document.querySelector("[data-message-id=submit-user]")', name+' bubble');
        await pause(900);
        const position = await run(`(() => {
          const list=document.querySelector('.message-list'), bounds=list.getBoundingClientRect();
          const user=list.querySelector('[data-message-id=submit-user]').getBoundingClientRect();
          const reply=list.querySelector('[data-message-id=submit-reply]').getBoundingClientRect();
          const composer=document.querySelector('.composer-surface').getBoundingClientRect();
          return {top:user.top-bounds.top,bottom:user.bottom,replyBottom:reply.bottom,composerTop:composer.top,
            spacer:list.querySelector('.assistant-response-spacer').getBoundingClientRect().height,available:composer.top-bounds.top};
        })()`);
        assert.ok(position.replyBottom <= position.composerTop + 2, name+' reply remains above the composer: '+JSON.stringify(position));
        if (name === 'narrow') assert.ok(position.top > 80, 'short requests retain context in a narrow window');
        else assert.equal(position.spacer,0,'a long request uses the available height without an empty response stage');
        console.log(name+' submission geometry:', position);
      }
    } finally {
      window.setSize(...originalSize);
      await window.webContents.removeInsertedCSS(responsiveStyle);
      await pause(120);
    }
  } finally {
    await run('cancelAnimationFrame(window.submissionFrame); viewTheme = submissionTheme; updateChat(submissionSaved);');
  }
  console.log('Submission motion passed: delayed admission, opaque stable bubbles, compact guidance, and consumed tail space in both themes.');
};
