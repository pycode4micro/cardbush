const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

module.exports = async ({ run, until, pause, window, root }) => {
  // Exercise the real deletion callback and views with an isolated backend.
  const source = fs.readFileSync(path.join(root, 'src/hooks/useCardbushChat.ts'), 'utf8');
  const start = source.indexOf('  const deleteConversation = useCallback(');
  assert.ok(start > 0);
  const deletion = ts.transpileModule(source.slice(start, source.indexOf('\n  const renameConversation', start)), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText + '\nreturn deleteConversation;';
  window.setContentSize(1160, 780);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/components/confirm-action.css'), 'utf8') +
    '\n.app{width:100% !important}.delete-focus-layout{display:flex;height:100vh}.delete-focus-layout>.chat-panel{flex:1;min-width:0}');
  await run(`
    window.deleteState={active:'s',conversations:[
      {id:'s',title:'当前会话',updatedAt:'2026-09-27T00:00:00Z',preview:''},
      {id:'other',title:'其他会话',updatedAt:'2026-09-27T00:00:00Z',preview:''},
    ],messages:{s:[{id:'u',role:'user',content:'原有消息',createdAt:'2026-09-27T00:00:00Z'}],other:[]},
      drafts:{s:'保留的草稿',other:'另一份草稿','':'欢迎页草稿'},calls:[],error:null};
    window.confirm=()=>{throw Error('Deletion must not use the blocking native confirm');};
    const conversationsRef={current:deleteState.conversations};
    window.drawDelete=()=>{
      conversationsRef.current=deleteState.conversations;
      Object.assign(chatProps,{language:'zh',activeConversationId:deleteState.active,loading:false,historyLoading:false,
        messages:deleteState.messages[deleteState.active] || [],draft:deleteState.drafts[deleteState.active] || '',error:deleteState.error,
        onDraftChange:text=>{deleteState.drafts[deleteState.active]=text;drawDelete();}});
      renderView(h('div',{className:'delete-focus-layout'},h(views.ChatSidebar,{
        language:'zh',section:'chat',activeConversationId:deleteState.active,conversations:deleteState.conversations,
        projects:[],changeReportsByConversation:{},onSectionChange:()=>{},onCreateConversation:()=>{throw Error('No new conversation needed');},
        onConversationChange:id=>{deleteState.active=id;drawDelete();},onDeleteConversation:id=>{void deleteUnderTest(id);},
        onAddProject:()=>{},onProjectAction:()=>{},onRenameConversation:async()=>true,onOpenConversationChanges:()=>{},onOpenSettings:()=>{},
      }),h(views.ChatPanel,chatProps)));
    };
    const bindings={useCallback:fn=>fn,confirmAction:views.confirmAction,conversationsRef,localize:chinese=>chinese,
      historyReadsRef:{current:{invalidate:()=>{}}},contextUsageReadsRef:{current:{invalidate:()=>{}}},
      clearSessionAttention:()=>{},setMessageHistoryLoading:()=>{},errorMessage:error=>error.message,
      setError:error=>{deleteState.error=error;drawDelete();},
      setConversations:update=>{deleteState.conversations=update(deleteState.conversations);drawDelete();},
      setMessagesByConversation:update=>{deleteState.messages=update(deleteState.messages);drawDelete();},
      setActiveConversationId:update=>{deleteState.active=update(deleteState.active);drawDelete();},
      deleteConversationApi:id=>new Promise((resolve,reject)=>{deleteState.calls.push(id);deleteState.settle=error=>error?reject(Error(error)):resolve(true);}),
    };
    window.deleteUnderTest=new Function(...Object.keys(bindings),${JSON.stringify(deletion)})(...Object.values(bindings));
    drawDelete();
  `);
  await until('!!document.querySelector("textarea[data-composer-input]")', 'deletion fixture composer');
  window.focusOnWebView();
  await until('document.hasFocus()', 'real hidden renderer has keyboard focus');
  const click = async selector => {
    const point = await run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for (const type of ['mouseMove','mouseDown','mouseUp']) window.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
    await pause(60);
  };
  const type = async text => {
    const before = await run('deleteState.drafts[deleteState.active]');
    for (const character of text) {
      window.webContents.sendInputEvent({type:'char',keyCode:character});
      await pause(25);
    }
    await until(`deleteState.drafts[deleteState.active]!==${JSON.stringify(before)}`, 'real keyboard input updates the current draft');
    assert.ok((await run('deleteState.drafts[deleteState.active]')).includes(text));
  };
  const open = async title => {
    await run(`[...document.querySelectorAll('.conversation-row')].find(row=>row.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:180}))`);
    await until('!!document.querySelector("[data-sidebar-menu-item=delete]")', 'delete menu action');
    await click('[data-sidebar-menu-item=delete]');
    await until('!!document.querySelector(".confirm-action-dialog:modal")', 'asynchronous confirmation');
    assert.equal(await run('!!document.querySelector(".sidebar-context-menu")'), false, 'menu unmounts before confirmation');
    assert.equal(await run('document.activeElement.textContent'), '取消', 'cancel is the safe initial focus');
  };
  const confirm = async title => {
    await open(title);
    await click('.confirm-action-dialog .danger');
    await until('!document.querySelector(".confirm-action-dialog")', 'confirmation closes');
  };

  await click('textarea[data-composer-input]');
  await type('A');
  await open('当前会话');
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/delete-confirmation-dark.png'), (await window.webContents.capturePage()).toPNG());
  await run('void deleteUnderTest("other")'); await pause(50);
  assert.deepEqual(await run('deleteState.calls'), [], 'another request cannot reuse this confirmation');
  await click('.confirm-action-dialog .secondary-button');
  await until('document.activeElement.matches("[data-composer-input]")', 'cancel restores the composer');
  await type('取消后输入');
  assert.deepEqual(await run('deleteState.calls'), [], 'cancel never deletes');

  await run("window.viewTheme='theme-bright';drawDelete()");
  await open('当前会话');
  fs.writeFileSync(path.join(root, 'tmp/delete-confirmation-bright.png'), (await window.webContents.capturePage()).toPNG());
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until('!document.querySelector(".confirm-action-dialog")', 'Escape cancels without a deletion');
  await type('D');
  assert.deepEqual(await run('deleteState.calls'), [], 'Escape never deletes');

  await confirm('当前会话');
  await until('deleteState.calls.length===1', 'confirmed deletion starts');
  await run('deleteState.settle("删除失败，请重试")');
  await until('deleteState.error!==null', 'failed delete reported');
  await type('失败后输入');
  assert.equal(await run('deleteState.conversations.length'), 2, 'failure preserves the session and draft');

  await confirm('其他会话');
  await until('deleteState.calls.length===2', 'inactive deletion starts');
  await run('deleteState.settle()');
  await until('deleteState.conversations.length===1', 'inactive deletion completes');
  assert.equal(await run('deleteState.active'), 's');
  await type('B');

  await confirm('当前会话');
  await until('deleteState.calls.length===3', 'current deletion starts');
  await run('deleteState.settle()');
  await until('deleteState.active==="" && !!document.querySelector(".welcome-composer")', 'current deletion opens the existing welcome page');
  await click('textarea[data-composer-input]');
  await type('删除后中英文C');
  assert.equal(await run('document.hasFocus()'), true, 'keyboard stays in the renderer without switching apps');
  assert.equal(window.isVisible(), false, 'test never takes over the desktop');
  console.log('Deletion input passed: real sidebar, async confirm/cancel, failure, inactive/current deletion, retained drafts and Chinese/English input without opening a new conversation.');
};
