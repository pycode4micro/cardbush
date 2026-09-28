const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.crypto.randomUUID ??= () => require('node:crypto').randomUUID();
    window.shadowFixture = {
      createShadowConversation: async input => ({ id: input.clientConversationId, mode: input.mode, sourceTurnId: 'source-turn', workspaceDir: 'D:/fixture' }),
      closeShadowConversation: async () => {},
      fetchSessionMessages: async () => ({ messages: [] }),
      updateShadowConversationMode: (id, mode) => new Promise(resolve => { window.finishShadowMode = () => resolve({ id, mode, workspaceDir: 'D:/fixture' }); }),
      streamShadowConversationMessage: request => new Promise(resolve => {
        window.appendShadowReply = request.onDelta;
        window.finishShadowReply = () => { request.onDone({ content: 'Shadow fixture completed', createdAt: new Date().toISOString() }); resolve(); };
        request.signal.addEventListener('abort', () => resolve(), { once: true });
      }),
    };
    window.shadowContext = { sessionId: 'source', sourceTurnId: 'source-turn', title: 'Shadow rendering check',
      initialMode: 'readonly', theme: 'dark', language: 'zh', modelConfig: { id: 'fixture', modelName: 'Fixture model' },
      projectDir: 'D:/fixture', accentColor: '#7f9f8a' };
    renderView(h(views.ShadowWindow, { context: shadowContext, embedded: true }));
    window.typeShadowDraft = text => {
      const field = document.querySelector('.shadow-window-composer textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, text);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    void 0;
  `);
  await until('document.querySelector(".shadow-window-composer textarea")?.disabled === false', 'Shadow history initialized');
  const send = '.shadow-window-send';
  const animation = () => run(`getComputedStyle(document.querySelector('${send} svg')).animationName`);
  assert.equal(await run(`document.querySelector('${send}').disabled`), true, 'empty input disables Send');
  assert.equal(await animation(), 'none', 'disabled Send must not spin');
  await run(`typeShadowDraft('Read this history')`);
  await until(`document.querySelector('${send}').disabled === false`, 'draft enables Send');
  assert.equal(await animation(), 'none');
  await run(`document.querySelector('${send}').click()`);
  await until(`document.querySelector('${send}.stop') !== null`, 'active reply shows Stop');
  assert.equal(await animation(), 'none', 'Stop is not a spinner');
  assert.equal(await run('getComputedStyle(document.querySelector(".shadow-window-message.streaming")).contentVisibility'), 'visible', 'an active Shadow turn keeps its real height');
  await run('appendShadowReply("Shadow first"); appendShadowReply(" snapshot")');
  await until('document.querySelector(".shadow-window-message.streaming .markdown-content p")?.textContent === "Shadow first snapshot"', 'Shadow commits buffered deltas');
  await run('window.shadowParagraph = document.querySelector(".shadow-window-message.streaming .markdown-content p"); appendShadowReply(" grows")');
  await until('shadowParagraph.textContent === "Shadow first snapshot grows"', 'Shadow delivers the next snapshot');
  assert.equal(await run('shadowParagraph.isConnected'), true, 'Shadow updates retain the visible paragraph');
  await run('finishShadowReply()');
  await until(`document.querySelector('${send}:not(.stop)')?.disabled === true`, 'completed reply returns to idle Send');
  assert.equal(await run('document.querySelector(".shadow-window-transcript").textContent.includes("Shadow fixture completed")'), true, 'completion flushes Shadow output');
  assert.equal(await animation(), 'none');
  await run(`document.querySelectorAll('.shadow-window-mode-switch button')[1].click()`);
  await until('typeof finishShadowMode === "function"', 'mode switch in flight');
  assert.equal(await animation(), 'none', 'switching mode does not animate the disabled arrow');
  await run('finishShadowMode()');
  await until('document.querySelector(".shadow-mode-fork") !== null && !document.querySelector(".shadow-window-mode-switch button").disabled', 'Fork ready');
  assert.equal(await animation(), 'none');
  // Real loading indicators in the shared composer still animate explicitly.
  await run(`
    const loading = document.createElement('button'); loading.className = 'send-button fixture-loading'; loading.disabled = true;
    loading.innerHTML = '<svg class="spin"></svg>'; document.body.append(loading);
  `);
  assert.equal(await run('getComputedStyle(document.querySelector(".fixture-loading .spin")).animationName'), 'cardbush-spin');
  await window.webContents.insertCSS(require('node:fs').readFileSync(require('node:path').join(root,'src/components/global-tooltip.css'),'utf8')+'\n.app{width:100%!important}');
  await run("renderView(h(views.ShadowWindow,{context:shadowContext,embedded:false}))");
  await until("!!document.querySelector('.shadow-window-caption-actions')", 'standalone Shadow window controls mounted');
  await run("document.querySelector('.shadow-window-caption-actions button').title='Minimize'");
  await until("document.querySelector('.shadow-window-caption-actions button').title===''", 'standalone tooltip host captures native titles');
  // The hidden fixture needs Chromium focus emulation, without focusing a user window.
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const control = await run("(() => {const r=document.querySelector('.shadow-window-caption-actions button').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:control.x-10,y:control.y});
  await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...control});
  await until("document.querySelectorAll('.global-tooltip').length===1", 'standalone Shadow uses one shared tooltip host');
  assert.equal(await run("getComputedStyle(document.querySelector('.global-tooltip')).borderRadius"), '18px');
  await run("renderView(h(views.ShadowWindow,{context:shadowContext,embedded:true}))");
  await until("!document.querySelector('.global-tooltip')", 'embedded Shadow releases its standalone tooltip host');
  window.webContents.debugger.detach();
  await run(`
    shadowFixture.fetchSessionMessages=async()=>({messages:Array.from({length:16},(_,i)=>({
      id:'shadow-bottom-'+i,role:i%2?'assistant':'user',turnId:'shadow-bottom-turn-'+i,
      content:('History '+i+'\\n\\n').repeat(8),status:'completed'}))});
    renderView(h(views.ShadowWindow,{key:'bottom-hold',context:{...shadowContext,sessionId:'bottom-hold'},embedded:true}));
    window.shadowList=()=>document.querySelector('.shadow-window-transcript');
    window.shadowBottomButton=()=>document.querySelector('.shadow-window-scroll-bottom');
    void 0;
  `);
  await until("!!document.querySelector('[data-message-id=shadow-bottom-15]') || document.querySelectorAll('.shadow-window-message').length===16", 'Shadow history for arrival timing');
  await pause(150);
  await run('shadowList().scrollTop=0');
  await until("!shadowBottomButton().classList.contains('hidden')", 'Shadow jump button shown');
  const hold = await run(`(async()=>{
    shadowBottomButton().click();
    const start=performance.now(),frames=[];
    await new Promise(resolve=>{const sample=()=>{
      const time=performance.now()-start;
      frames.push({time,distance:shadowList().scrollHeight-shadowList().clientHeight-shadowList().scrollTop,hidden:shadowBottomButton().classList.contains('hidden')});
      if(time<750)requestAnimationFrame(sample);else resolve();
    };requestAnimationFrame(sample);});return frames;
  })()`);
  assert.ok(hold.every(frame=>frame.distance<=1), 'Shadow click lands at the actual bottom');
  assert.ok(hold.filter(frame=>frame.time<180).every(frame=>!frame.hidden), 'Shadow also holds for 200ms after arrival');
  assert.equal(hold.at(-1).hidden,true,'Shadow button eventually dismisses');
  console.log('Shadow idle, sending, completed and mode-switch rendering passed');
};
