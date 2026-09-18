const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    localStorage.removeItem('cardbush.review_file_nav_width');
    localStorage.removeItem('cardbush.review_file_nav_collapsed');
    window.reviewWidth=600; window.reviewEmbedded=true; window.reviewReverts=[];
    window.reviewDirectoryReads=[]; window.reviewInitialPath=''; window.reviewTurns=undefined;
    cardbushDesktop.readWorkspaceDirectory=async ({directoryPath})=>{
      reviewDirectoryReads.push(directoryPath);
      const names=directoryPath.replaceAll('\\\\','/').replace(/\\/$/,'')==='C:/fixture'
        ? ['src/','README.md','markdown-test.md','notes.md'] : ['report.ts','index.ts'];
      return {entries:names.map(name=>({name:name.replace(/\\/$/,''),path:directoryPath+'/'+name.replace(/\\/$/,''),kind:name.endsWith('/')?'folder':'file'}))};
    };
    cardbushDesktop.readTextPreview=async path=>({path,content:'Current file contents',size:21,modifiedAt:0,truncated:false});
    window.reviewReports=views.changeReportsFromMessages([{id:'review-message',role:'assistant',content:'Done',
      conversationId:'review-fixture',turnId:'review-turn',createdAt:'2026-09-17T00:00:00Z',toolExecutions:[{
        id:'review-edit',name:'workspace_checkpoint',state:'completed',success:true,summary:'Edits',output:'',durationMs:1,
        turnId:'review-turn',createdAt:'2026-09-17T00:00:00Z',metadata:{kind:'file_change',workspaceCheckpoint:true,
          workspaceChanges:['markdown-test.md','src/report.ts','notes.md'].map((name,index)=>({
            change_id:'file-'+index,path:'C:/fixture/'+name,status:'created',additions:60,deletions:0,
            metadata:{diff:'@@ -0,0 +1,60 @@\\n'+Array.from({length:60},(_,i)=>'+Line '+i+' in '+name).join('\\n')},
          }))},
      }]}]);
    window.showReview=()=>renderView(h('aside',{className:'right-inspector',style:{position:'relative',width:reviewWidth,
      height:660,maxWidth:'none',flex:'none',margin:12}},h(views.ConversationChangeDialog,{
        embedded:reviewEmbedded,language:'zh',conversation:{id:'review-fixture',title:'Review',projectDir:'C:/fixture'},reports:reviewReports,
        turns:reviewTurns,initialFilePath:reviewInitialPath,
        notice:'',revertingChangeId:'',revertedChangeIds:new Set(),onClose:()=>{},
        onRevert:async report=>reviewReverts.push({id:report.id,turnId:report.turnId}),onRevertAll:async()=>{},
      })));
    window.navSize=()=>document.querySelector('.change-review-file-nav').getBoundingClientRect().width;
    window.navViewport=()=>document.querySelector('.change-review-file-nav-viewport');
    window.navClosed=()=>navViewport().hidden;
    window.navOpen=()=>!navClosed() && navViewport().getAttribute('aria-hidden')==='false'
      && Math.abs(navViewport().getBoundingClientRect().width-navSize())<1
      && Number(getComputedStyle(navViewport()).opacity)>.99
      && navViewport().getAnimations().length===0;
    window.reviewMotionFrames=()=>new Promise(resolve=>{
      const frames=[],start=performance.now();
      const sample=()=>{
        if (!navClosed()) frames.push({width:navViewport().getBoundingClientRect().width,content:navSize(),
          opacity:Number(getComputedStyle(navViewport()).opacity)});
        if (performance.now()-start<320) requestAnimationFrame(sample); else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    window.beginReviewDrag=(button=0)=>{
      const handle=document.querySelector('.change-review-column-resizer');
      handle.setPointerCapture=()=>{};
      window.reviewStartX=handle.getBoundingClientRect().x+5;
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:17,clientX:reviewStartX,button}));
    };
    window.moveReviewDrag=(delta,pointerId=17)=>window.dispatchEvent(new PointerEvent('pointermove',{pointerId,clientX:reviewStartX+delta}));
    showReview();
  `);
  await until("document.querySelectorAll('.change-review-file-item').length===4 && navOpen()", 'review fixture');
  await pause(320);
  assert.equal(await run('navSize()'), 210);
  const [sidebarMotion, fileNavMotion]=await run(`(()=>{
    const sidebar=document.createElement('aside'); sidebar.className='sidebar';
    document.querySelector('.app').append(sidebar);
    const motion=node=>{const s=getComputedStyle(node);return[s.transitionProperty,s.transitionDuration,s.transitionTimingFunction]};
    const result=[motion(sidebar),motion(navViewport())]; sidebar.remove(); return result;
  })()`);
  assert.deepEqual(fileNavMotion, sidebarMotion, 'file list shares the sidebar motion duration and easing');
  assert.equal(await run("!!document.querySelector('.change-review-nav-toggle .lucide-folder-tree')"), true, 'directory tree icon identifies the file list without resembling copy');
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(row=>row.title.endsWith('notes.md')).click()");
  await pause();
  const selectedFile = await run("document.querySelector('.change-review-file-heading strong').textContent");
  await run("window.reviewDiff=document.querySelector('.change-review-diff-pane .tool-file-change'); reviewDiff.scrollTop=160; window.reviewScroll=reviewDiff.scrollTop;");
  await run('beginReviewDrag(2)');
  assert.equal(await run("document.body.classList.contains('change-review-resizing')"), false, 'right click cannot resize');
  for (const end of ['cancel','blur','lost','resize','unmount']) {
    await run('beginReviewDrag(); moveReviewDrag(-40);');
    await pause(50);
    assert.equal(await run('navSize()'), 250, 'drag follows the pointer before release: '+end);
    assert.equal(await run("localStorage.getItem('cardbush.review_file_nav_width')"), null, 'preview does not persist intermediate widths');
    await run("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:99})); moveReviewDrag(200,99);");
    assert.equal(await run("document.body.classList.contains('change-review-resizing')"), true, 'unrelated pointer is ignored');
    if (end==='cancel') await run("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:17}))");
    if (end==='lost') await run("document.querySelector('.change-review-column-resizer').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:17}))");
    if (end==='blur'||end==='resize') await run(`window.dispatchEvent(new Event('${end}'))`);
    if (end==='unmount') { await run('renderView(null)'); await pause(); }
    assert.equal(await run("document.body.classList.contains('change-review-resizing')"), false, 'drag cleanup: '+end);
    await run("window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17})); moveReviewDrag(500);");
    assert.equal(await run("localStorage.getItem('cardbush.review_file_nav_width')"), null, 'cancelled handlers cannot commit: '+end);
    if (end==='unmount') { await run('showReview()'); await until("!!document.querySelector('.change-review-file-nav') && navOpen()", 'remount'); await pause(320); }
    assert.equal(await run('navSize()'), 210, 'cancel restores width: '+end);
  }
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(row=>row.title.endsWith('notes.md')).click()");
  await pause();
  await run("window.reviewDiff=document.querySelector('.change-review-diff-pane .tool-file-change'); reviewDiff.scrollTop=160; window.reviewScroll=reviewDiff.scrollTop; beginReviewDrag(); moveReviewDrag(-60);");
  await pause(50);
  assert.equal(await run("reviewDiff===document.querySelector('.change-review-diff-pane .tool-file-change')"), true, 'pointer movement does not remount the diff');
  await run("window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17}))");
  await until("localStorage.getItem('cardbush.review_file_nav_width')==='270'", 'final width saved');
  const snapFrames=await run('beginReviewDrag(); moveReviewDrag(220); reviewMotionFrames();');
  assert.ok(snapFrames.length>2 && snapFrames.every(frame=>frame.width<=51), 'edge snap animates from the pointer width without bouncing back to the saved width');
  assert.equal(new Set(snapFrames.map(frame=>Math.round(frame.content))).size, 1, 'snap clips stable content while sliding out');
  await until('navClosed()', 'drag snaps closed before pointer release');
  assert.equal(await run("document.body.classList.contains('change-review-resizing')"), false);
  assert.equal(await run("localStorage.getItem('cardbush.review_file_nav_width')"), '270', 'snap keeps the last usable width');
  assert.equal(await run("document.querySelector('.change-review-diff-pane').clientWidth >= document.querySelector('.change-review-workspace').clientWidth-2"), true, 'diff receives the released space');
  await run("window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17})); document.querySelector('.change-review-nav-toggle').click()");
  await until('navOpen()', 'button restores file list');
  assert.equal(await run('navSize()'), 270);
  assert.equal(await run("document.querySelector('.change-review-file-heading strong').textContent"), selectedFile, 'selection survives collapse');
  assert.equal(await run('reviewDiff.scrollTop===reviewScroll'), true, 'diff reading position survives collapse and restore');

  const collapseFrames=await run("window.retainedFileNav=document.querySelector('.change-review-file-nav'); document.querySelector('.change-review-nav-toggle').click(); reviewMotionFrames();");
  assert.ok(new Set(collapseFrames.map(frame=>Math.round(frame.width))).size>2, 'button collapse releases space gradually');
  assert.equal(new Set(collapseFrames.map(frame=>Math.round(frame.content))).size, 1, 'file names do not reflow during collapse');
  assert.ok(collapseFrames.some(frame=>frame.opacity>0 && frame.opacity<1), 'list fades with the slide');
  const revealFrames=await run("document.querySelector('.change-review-nav-toggle').click(); reviewMotionFrames();");
  assert.ok(new Set(revealFrames.map(frame=>Math.round(frame.width))).size>2, 'button expansion animates intermediate widths');
  assert.equal(new Set(revealFrames.map(frame=>Math.round(frame.content))).size, 1, 'file names do not reflow during expansion');
  await until('navOpen()', 'reveal complete');
  await run("document.querySelector('.change-review-nav-toggle').click()"); await pause(65);
  await run("document.querySelector('.change-review-nav-toggle').click()");
  await until('navOpen()', 'reopening interrupts exit smoothly'); await pause(300);
  assert.equal(await run("navOpen() && retainedFileNav===document.querySelector('.change-review-file-nav') && navSize()===270"), true, 'interrupted exit retains the list, saved width and cancels stale hiding');

  await run("document.querySelector('.change-review-nav-toggle').click()");
  await until('navClosed()', 'manual collapse');
  await run('renderView(null)'); await pause(); await run('showReview()');
  await until('!!document.querySelector(".change-review-nav-toggle")', 'collapsed remount');
  assert.equal(await run('navClosed()'), true, 'collapsed preference survives remount');
  await run("document.querySelector('.change-review-nav-toggle').click()");
  await until('navOpen()', 'restore after remount');
  await run("document.querySelector('.change-review-column-resizer').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));");
  await until('navSize()===246', 'keyboard resize');
  await until('navOpen()', 'keyboard resize settled');
  assert.equal(await run("document.activeElement.classList.contains('change-review-column-resizer')"), true, 'arrow keys keep focus for repeated resizing');
  await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));");
  await until('navClosed()', 'keyboard collapse');
  assert.equal(await run("document.activeElement.classList.contains('change-review-nav-toggle')"), true, 'collapse moves keyboard focus to the restore control');
  await run("document.querySelector('.change-review-nav-toggle').click()");
  await until('navOpen()', 'restore for native pointer');
  const point=await run("(()=>{const r=document.querySelector('.change-review-column-resizer').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+100)}})()");
  window.webContents.sendInputEvent({type:'mouseMove',...point});
  window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  window.webContents.sendInputEvent({type:'mouseMove',x:point.x+200,y:point.y});
  await until('navClosed()', 'native mouse drag uses pointer capture and snaps while held');
  window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+200,y:point.y});

  await run(`
    const base=reviewReports[0];
    reviewReports=Array.from({length:200},(_,index)=>({...base,id:'report-'+index,turnId:'turn-'+index,
      turnIndex:index+1,createdAt:new Date(Date.UTC(2026,8,17,0,index)).toISOString(),
      userPrompt:'修改成片和素材 '+(index+1),fileCount:5,
      files:['make_graphics_4k.py','verify_4k.py','src/index.ts','tests/index.ts','notes.md'].map(name=>({
        ...base.files[0],path:'C:/fixture/'+name,
        diff:'@@ -1 +1 @@\\n-before\\n+version-'+(index+1),
        lines:[{kind:'hunk',text:'@@ -1 +1 @@'},{kind:'deletion',text:'-before'},{kind:'addition',text:'+version-'+(index+1)}],
      })),
    }));
    reviewInitialPath='C:/fixture/make_graphics_4k.py';
    showReview(); document.querySelector('.change-review-nav-toggle').click();
  `);
  await until('navOpen() && document.querySelectorAll(".change-review-version-picker [role=option]").length===2', '200 turns retain two review options');
  assert.equal(await run("document.querySelectorAll('.change-review-summary,.change-review-file-heading').length"), 1, 'one merged toolbar');
  assert.equal(await run("document.querySelector('.change-review-tree-root strong').textContent"), 'fixture', 'workspace prefix appears once');
  assert.equal(await run("document.querySelectorAll('.change-review-group-toggle,.change-review-file-item .diff-count').length"), 0, 'repeated turn groups and per-row statistics are absent');
  assert.equal(await run("document.querySelectorAll('.change-review-file-item small').length"), 0, 'directory hierarchy replaces repeated paths');
  assert.equal(await run("reviewDirectoryReads.every(path=>path==='C:/fixture')"), true, 'closed folders are not scanned');
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('version-200')", 'latest version opens initially');
  await run("document.querySelector('.change-review-version-picker [role=combobox]').click()");
  await run("document.querySelectorAll('.change-review-version-picker [role=option]')[1].click()");
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('version-199')", 'previous turn shows its actual diff');
  await run("document.querySelector('.change-review-file-heading .secondary-button').click()");
  assert.deepEqual(await run('reviewReverts.at(-1)'), {id:'report-198',turnId:'turn-198'}, 'revert targets the selected original turn');
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(button=>button.title.endsWith('verify_4k.py')).click()");
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('version-199')", 'changing files keeps the selected turn');
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(row=>row.title.endsWith('README.md')).click()");
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('Current file contents')", 'unchanged files are readable inside review');
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(row=>row.title.endsWith('/src')).click()");
  await until("reviewDirectoryReads.includes('C:/fixture/src') && !!document.querySelector('.change-review-file-item[title=\"C:/fixture/src/index.ts\"]')", 'folders load on expansion');
  await run("document.querySelector('.change-review-file-item[title=\"C:/fixture/src/index.ts\"]').click()");
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('version-199')", 'nested changed file uses selected turn');
  await run("reviewTurns=[{id:'no-edits',prompt:'没有修改的本轮'},{id:'turn-199'}]; showReview()");
  await until("document.querySelector('.change-review-version-picker [role=combobox]').value==='no-edits'", 'no-edit current turn remains selectable');
  assert.equal(await run("document.querySelector('.change-review-revert').disabled"), true, 'empty turn retains a disabled revert action');
  await until("document.querySelector('.change-review-diff-pane').textContent.includes('Current file contents')", 'empty turn displays current file explicitly');
  await run("reviewTurns=undefined; showReview()");
  await run("document.querySelector('.change-review-nav-toggle').click()"); await until('navClosed()', 'large fixture collapse');

  await window.webContents.insertCSS(await fs.readFile(path.join(root,'src/styles/themes/cyberpunk.css'),'utf8'));
  for (const theme of ['theme-bright','theme-dark','theme-dark theme-cyberpunk']) {
    await run(`viewTheme=${JSON.stringify(theme)}; reviewWidth=420; showReview();`); await pause();
    assert.equal(await run("document.querySelector('.change-review-nav-toggle').getBoundingClientRect().right<=document.querySelector('.change-review-dialog').getBoundingClientRect().right"), true, 'restore control fits narrow review');
    await fs.writeFile(path.join(root,'tmp/review-files-collapsed-'+theme+'.png'),(await window.capturePage()).toPNG());
    await run("document.querySelector('.change-review-nav-toggle').click()"); await until('navOpen()', 'theme restore');
    assert.ok(await run("document.querySelector('.change-review-diff-pane').clientWidth>=259"), 'narrow review preserves usable diff width');
    await fs.writeFile(path.join(root,'tmp/review-files-expanded-'+theme+'.png'),(await window.capturePage()).toPNG());
    await run("document.querySelector('.change-review-nav-toggle').click()"); await until('navClosed()', 'theme collapse');
  }
  window.setSize(650,800);
  await run('reviewEmbedded=false; showReview()');
  await until("!!document.querySelector('.change-review-dialog:not(.embedded)')", 'narrow standalone review');
  assert.equal(await run("document.querySelector('.change-review-diff-pane').clientHeight>=document.querySelector('.change-review-workspace').clientHeight-2"), true, 'collapsed standalone review has no reserved bottom row');
  await run("document.querySelector('.change-review-nav-toggle').click()");
  await until('!navClosed() && Math.abs(navViewport().getBoundingClientRect().height-150)<1', 'standalone review reveals its bottom file list');
  await pause(50);
  assert.equal(await run("navSize()===document.querySelector('.change-review-workspace').clientWidth"), true, 'standalone bottom list spans the review width');
  await run("document.querySelector('.change-review-nav-toggle').click()"); await until('navClosed()', 'standalone collapse');
  assert.equal(await run("document.querySelector('.change-review-diff-pane').clientHeight>=document.querySelector('.change-review-workspace').clientHeight-2"), true, 'standalone animation releases the whole bottom row');

  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await run("document.querySelector('.change-review-nav-toggle').click()");
    await until("!navClosed() && navViewport().getAttribute('aria-hidden')==='false'", 'reduced motion restore');
    assert.equal(await run("getComputedStyle(navViewport()).transitionDuration.split(',').every(value=>parseFloat(value)===0)"), true, 'reduced motion skips interpolation');
    await run("document.querySelector('.change-review-nav-toggle').click()");
    await until('navClosed()', 'reduced motion collapse finishes');
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    window.webContents.debugger.detach();
  }
  await run(`
    window.pagedReads=[];
    cardbushDesktop.readWorkspaceDirectory=async ({directoryPath,offset=0})=>{
      pagedReads.push({directoryPath,offset});
      return {entries:Array.from({length:200},(_,index)=>({name:'large-'+(offset+index)+'.ts',path:directoryPath+'/large-'+(offset+index)+'.ts',kind:'file'})),nextOffset:offset<400?offset+200:undefined};
    };
    document.querySelector('.change-review-nav-toggle').click();
    document.querySelector('.change-review-tree-root button').click();
  `);
  await until('navOpen() && pagedReads.length>0', 'large real directory pages');
  assert.ok(await run("document.querySelectorAll('.change-review-file-item').length<80"), 'large directories render only visible rows');
  await run("document.querySelector('.change-review-files').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));");
  await until("Array.from(document.querySelectorAll('.change-review-file-item')).some(row=>row.textContent.includes('加载更多'))", 'keyboard reaches paged directory footer');
  await run("Array.from(document.querySelectorAll('.change-review-file-item')).find(row=>row.textContent.includes('加载更多')).click()");
  await until('pagedReads.some(read=>read.offset===200)', 'next page requested explicitly');
  assert.ok(await run("document.querySelectorAll('.change-review-file-item').length<80"), 'loading another page keeps DOM bounded');
  await run("localStorage.removeItem('cardbush.review_file_nav_width'); localStorage.removeItem('cardbush.review_file_nav_collapsed'); renderView(null)");
  window.setSize(1200,800);
  console.log('Review passed: two-turn window over 200 Turns, no-edit Turns, merged toolbar, actual directory/unchanged-file reads, lazy folders, virtualized pagination, original-turn revert, shared sidebar motion, drag/edge snap, keyboard, cancellation, three themes, narrow layouts and reduced motion.');
};
