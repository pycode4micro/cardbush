const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    if (!crypto.randomUUID) crypto.randomUUID = require('node:crypto').randomUUID;
    window.commentSession='session-a'; window.commentStates={}; window.commentReverts=[];
    window.commentBusy=false; window.commentEmpty=false; window.commentClosed=false;
    window.commentDrafts={'session-a':'保留原有输入'}; window.commentWidth=720;
    cardbushDesktop.readWorkspaceDirectory=async()=>({entries:['main.ts','other.ts'].map(name=>({name,path:'C:/fixture/'+name,kind:'file'}))});
    cardbushDesktop.readTextPreview=async path=>({path,content:'Unchanged source',truncated:false});
    window.commentFile=(name,version)=>({path:'C:/fixture/'+name,additions:2,deletions:1,diff:version,lines:[
      {kind:'hunk',text:'@@ -10,3 +10,4 @@'}, {kind:'context',text:' const before = true;'},
      {kind:'deletion',text:'-const old = 1;'}, {kind:'addition',text:'+const value = '+version+';'},
      {kind:'addition',text:'+const extra = true;'}, {kind:'context',text:' return value;'}]});
    window.commentReports=[1,2].map(version=>({id:'report-'+version,turnId:'turn-'+version,messageId:'message-'+version,
      fileCount:2,additions:4,deletions:2,files:['main.ts','other.ts'].map(name=>commentFile(name,version))}));
    window.showComments=()=>renderView(commentClosed?null:h('aside',{className:'right-inspector',style:{width:commentWidth,height:680,position:'relative',margin:16,flex:'none',maxWidth:'none'}},
      h(views.ConversationChangeDialog,{embedded:true,language:'zh',conversation:{id:commentSession,title:'Review',projectDir:'C:/fixture'},
        reports:commentReports,turns:commentEmpty?[{id:'empty'},{id:'turn-2'}]:[{id:'turn-2'},{id:'turn-1'}],
        reviewComments:commentStates[commentSession]??views.emptyReviewComments,
        onReviewCommentsChange:update=>{commentStates[commentSession]=typeof update==='function'?update(commentStates[commentSession]??views.emptyReviewComments):update;showComments();},
        onComposeReviewComments:comments=>{commentDrafts[commentSession]=views.appendReviewCommentsToDraft(commentDrafts[commentSession]??'',comments,'zh');},
        revertAvailable:!commentBusy,notice:'',revertingChangeId:'',revertedChangeIds:new Set(),onClose:()=>{},onRevert:async report=>commentReverts.push(report.id)})));
    window.commentInput=text=>{const input=document.querySelector('.review-comment-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
    window.clickLine=(side,line,shift=false)=>document.querySelector('.review-line-target[aria-label="'+side+line+'"]').dispatchEvent(new MouseEvent('click',{bubbles:true,shiftKey:shift}));
    showComments();
  `);
  await until("document.querySelectorAll('.review-add-comment').length===5", 'commentable diff');
  await run("document.querySelector('.change-review-version-picker [role=combobox]').click()");
  await until("document.querySelector('.change-review-version-picker [role=listbox]').matches(':popover-open')", 'themed menu opens');
  assert.equal(await run("document.querySelector('.change-review-version-picker select')===null"), true);
  await run("document.querySelector('.change-review-version-picker [role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));");
  await run("document.querySelector('.change-review-version-picker [role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));");
  await until("document.querySelector('.change-review-version-picker [role=combobox]').value==='turn-1'", 'keyboard picks previous turn');
  await run("document.querySelector('.change-review-revert').click()");
  assert.deepEqual(await run('commentReverts'), ['report-1']);
  await run("commentBusy=true;showComments()"); await pause();
  assert.equal(await run("document.querySelector('.change-review-revert').disabled"), true);
  await run("document.querySelector('.change-review-revert').click();commentEmpty=true;commentBusy=false;showComments()"); await pause();
  assert.equal(await run("document.querySelector('.change-review-revert').disabled"), true, 'empty turn keeps the same disabled button');
  assert.deepEqual(await run('commentReverts'), ['report-1']);
  await run("commentEmpty=false;showComments()");
  await until("!!document.querySelector('.review-line-target[aria-label=L11]')", 'current diff restored');
  await run("document.querySelector('.change-review-version-picker [role=combobox]').click()");
  await run("document.querySelectorAll('.change-review-version-picker [role=option]')[0].click()");
  await run("clickLine('L',11)");
  await until("!!document.querySelector('.review-comment-editor')", 'deleted line editor');
  assert.equal(await run("document.querySelector('.review-comment-save').disabled"), true, 'blank comments cannot be saved');
  await run("commentInput('删除前请保留兼容性')"); await pause();
  await run("document.querySelector('.review-comment-save').click()"); await pause();
  await until("commentStates['session-a'].comments.length===1", 'first comment saves');
  assert.deepEqual(await run("Object.fromEntries(['side','startLine','endLine','excerpt','turnId'].map(key=>[key,commentStates['session-a'].comments[0][key]]))"),
    {side:'old',startLine:11,endLine:11,excerpt:'const old = 1;',turnId:'turn-2'});
  await run("clickLine('R',11)"); await pause();
  await run("clickLine('R',12,true)"); await pause();
  await run("commentInput('请把这两行合并，并增加边界处理')"); await pause();
  assert.equal(await run("document.querySelectorAll('.review-comment-selected').length"), 2);
  await run("document.querySelector('.change-review-file-item[title=\"C:/fixture/other.ts\"]').click()");
  await until("!!document.querySelector('.review-comment-away textarea')", 'unfinished comment survives switching files');
  assert.equal(await run("document.querySelector('.review-comment-away textarea').value"), '请把这两行合并，并增加边界处理');
  await run("document.querySelector('.change-review-file-item[title=\"C:/fixture/main.ts\"]').click()");
  await until("!!document.querySelector('.review-line-comments textarea')", 'draft returns to its own anchor');
  await run("document.querySelector('.review-comment-save').click()"); await pause();
  assert.equal(await run("commentStates['session-a'].comments.length"), 2);
  await run("document.querySelector('.review-line-comments [aria-label=编辑评论]').click()"); await pause();
  await run("commentInput('请保留旧版调用方式')"); await pause();
  await run("document.querySelector('.review-comment-save').click()"); await pause();
  assert.equal(await run("commentStates['session-a'].comments.length"), 2, 'editing replaces a comment');
  await run("commentClosed=true;showComments()"); await pause();
  await run("commentClosed=false;showComments()"); await pause();
  assert.equal(await run("document.querySelectorAll('.review-line-comments .review-comment-card').length"), 2, 'closing review retains session comments');
  await run("commentSession='session-b';showComments()"); await pause();
  assert.equal(await run("document.querySelector('.review-comments-footer')===null"), true, 'other sessions never inherit comments');
  await run("commentSession='session-a';showComments()"); await pause();
  await run("document.querySelector('.change-review-version-picker [role=combobox]').click()");
  await run("document.querySelectorAll('.change-review-version-picker [role=option]')[1].click()"); await pause();
  assert.equal(await run("document.querySelectorAll('.review-line-comments .review-comment-card').length"), 0, 'same lines in another turn never inherit comments');
  await run("clickLine('R',11)"); await pause();
  await run("commentInput('上一轮的修改需要兼容')"); await pause();
  await run("document.querySelector('.review-comment-save').click()"); await pause();
  assert.equal(await run("commentStates['session-a'].comments.at(-1).turnId"), 'turn-1');
  await run("clickLine('R',13)"); await pause();
  await run("commentInput('这条用于检查删除')"); await pause();
  await run("document.querySelector('.review-comment-save').click()"); await pause();
  await run("Array.from(document.querySelectorAll('.review-line-comments .review-comment-card')).at(-1).querySelector('[aria-label=删除评论]').click()"); await pause();
  assert.equal(await run("commentStates['session-a'].comments.length"), 3, 'delete removes only the selected comment');
  await run("document.querySelector('.review-comment-compose').click()"); await pause();
  assert.equal(await run("commentStates['session-a'].comments.length"), 0);
  assert.equal(await run("commentDrafts['session-a'].startsWith('保留原有输入\\n\\n')"), true, 'existing draft is not overwritten');
  for (const value of ['L11','R11–R12','turn-1','turn-2','const value = 1;','const value = 2;','C:/fixture/main.ts']) {
    assert.equal(await run(`commentDrafts['session-a'].includes(${JSON.stringify(value)})`), true, 'outbound preserves '+value);
  }
  await run("clickLine('R',11)"); await pause();
  await run("commentInput('多主题下检查输入框和菜单的对比度')"); await pause();
  await window.webContents.insertCSS(await fs.readFile(path.join(root,'src/styles/themes/cyberpunk.css'),'utf8'));
  for (const theme of ['theme-bright','theme-dark','theme-dark theme-cyberpunk']) {
    await run(`window.viewTheme=${JSON.stringify(theme)};showComments()`); await pause();
    await run("document.querySelector('.change-review-version-picker [role=combobox]').click()"); await pause();
    const menu = await run("(()=>{const n=document.querySelector('.change-review-version-picker [role=listbox]'),r=n.getBoundingClientRect();return{open:n.matches(':popover-open'),right:r.right,bottom:r.bottom,color:getComputedStyle(n).color,bg:getComputedStyle(n).backgroundColor}})()");
    assert.equal(menu.open, true); assert.ok(menu.right <= 1200 && menu.bottom <= 800); assert.notEqual(menu.color, menu.bg);
    await fs.writeFile(path.join(root,'tmp',`review-comments-${theme}.png`),(await window.webContents.capturePage()).toPNG());
    await run("document.querySelector('.change-review-version-picker [role=combobox]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  }
  await run("commentWidth=360;showComments()"); await pause();
  assert.equal(await run("(()=>{const editor=document.querySelector('.review-comment-editor'),pane=document.querySelector('.change-review-dialog');return editor.getBoundingClientRect().right<=pane.getBoundingClientRect().right})()"), true, 'comment editor fits a narrow panel');
  console.log('Review comments: themed menu, disabled revert, line ranges, editing, session/turn isolation, compose and 3 themes passed.');
};
