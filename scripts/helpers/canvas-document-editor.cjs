const assert = require('node:assert/strict');
// Retained editor regressions run through the current Canvas document surface.
module.exports = async ({ run: read, until, win }) => {
  const key=async(keyCode,modifiers=[])=>{keyCode=keyCode.replace(/^Arrow/,'');win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame();};
  if(!win.webContents.debugger.isAttached())win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  const frame=()=>read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const source=async value=>{await read(`(()=>{const el=document.querySelector('.md-source');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await frame();};
  const click = async text => {
    if (['添加任务','添加章节'].includes(text)) {
      await read('document.querySelector("[aria-label=插入内容]").click()'); await frame();
      text = text === '添加任务' ? 'Team 任务' : '可引用章节';
    }
    if (!(await read(`[...document.querySelectorAll('button')].some(button=>button.textContent.replace(/Ctrl\\+N/g,'').trim()===${JSON.stringify(text)})`))) await action('页面菜单');
    await read(`[...document.querySelectorAll('button')].find(button=>button.textContent.replace(/Ctrl\\+N/g,'').trim()===${JSON.stringify(text)}).click()`); await frame();
  };
  const action = async label => {
    if (!(await read(`!!document.querySelector('[aria-label="${label}"]')`))) { assert.notEqual(label,'页面菜单','page menu is available'); await action('页面菜单'); }
    await read(`document.querySelector('[aria-label="${label}"]').click()`); await frame();
  };
  const pointerClick = async selector => {
    if (!(await read(`!!document.querySelector(${JSON.stringify(selector)})`))) { assert.notEqual(selector,'[aria-label="页面菜单"]','page menu is available'); await pointerClick('[aria-label="页面菜单"]'); }
    const point = await read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'nearest'});const rect=element.getBoundingClientRect();return {x:Math.round(rect.left+rect.width/2),y:Math.round(rect.top+rect.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point}); await frame();
  };
  await click('新建文档'); await until('!!document.querySelector(".bush-page-content")');
    await action('插入内容块');
    assert.ok(await read('!!document.querySelector(".bush-insert-menu")'),'block insertion works before the first edit');
    await read('document.querySelector(".bush-page-title").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))'); await frame();
    await read(`(()=>{const title=document.querySelector('.bush-page-title');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(title,'协作设计笔记');title.dispatchEvent(new Event('input',{bubbles:true}));})()`); await frame();
    await read('document.querySelector(".bush-page-content").focus()');
    await win.webContents.insertText('先把理由写清楚。'); await frame();
    await read('window.bodyEditor=document.querySelector(".bush-page-content")');
    await win.webContents.insertText('再安排实践。'); await frame();
    assert.equal(await read('document.querySelector(".bush-page-content")===window.bodyEditor'),true,'typing retains the editor DOM and cursor');
    assert.equal(await read('document.activeElement===bodyEditor'),true);
    await key('Enter'); await win.webContents.insertText('/h2'); await until('!!document.querySelector(".bush-insert-menu")');
    await key('Enter'); await win.webContents.insertText('为什么这样做'); await frame();
    assert.equal(await read('bodyEditor.querySelector("h2").textContent'),'为什么这样做');
    assert.equal(await read('!!document.querySelector(".bush-insert-menu")'),false);
    await key('Enter'); await win.webContents.insertText('/todo'); await key('Enter'); await win.webContents.insertText('核对交付结果'); await frame();
    assert.equal(await read('bodyEditor.querySelectorAll("ul[data-type=taskList]").length'),1);
    await read('bodyEditor.querySelector("input[type=checkbox]").click()'); await frame();
    await read('bodyEditor.editor.commands.focus("end");bodyEditor.editor.commands.createParagraphNear()'); await frame();
    await action('插入图片'); await until('!!document.querySelector(".bush-image-slot")');
    const pixel='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2uoAAAAASUVORK5CYII=';
    await read(`(()=>{const file=new File([Uint8Array.from(atob('${pixel}'),c=>c.charCodeAt(0))],'image.png',{type:'image/png'});const transfer=new DataTransfer();transfer.items.add(file);const input=document.querySelector('.bush-image-slot input[type=file]');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until('document.querySelector(".bush-page-image img")?.src.startsWith("data:image/png")');
    await read('bodyEditor.editor.commands.focus("end")'); await action('插入内容'); await click('插入表格');
    await until('!!bodyEditor.querySelector("table")');
    await click('Markdown');
    const composed=await read('document.querySelector(".md-source").value');
    assert.ok(composed.includes('# 协作设计笔记') && composed.includes('## 为什么这样做') && composed.includes('[x] 核对交付结果') && composed.includes('data:image/png;base64,'));
    assert.ok(composed.includes('|'),'tables serialize to Markdown');
  await until('!!document.querySelector(".md-source")');
    const literal='# 保留特殊内容\n\n可以继续编辑的正文。\n\n[[#note|背景]]\n\n<div data-example="true">原始 HTML</div>\n\n[保留引用][ref]、[ref][]、[ref]\n\n[ref]: https://example.com\n\n```js\nconst value = 1;\n```';
    await source(literal); await click('文档'); await read('document.querySelector(".bush-page-content").editor.commands.focus("start")'); await frame();
    assert.equal(await read(`document.querySelectorAll('.bush-page-content a[href="https://example.com"]').length`),3,'full, collapsed and shortcut reference links render as actual links');
    assert.ok(await read('document.querySelector(".bush-page-content").editor.getJSON().content.filter(node=>node.type==="paragraph"&&!node.content).length<=1'),'unsupported blocks do not create extra empty paragraphs');
    await win.webContents.insertText('新增内容。'); await frame(); await click('Markdown');
    const preserved=await read('document.querySelector(".md-source").value');
    assert.ok(preserved.includes('新增内容。'),'editing changes the current page before persistence');
    for(const fragment of ['[[#note|背景]]','<div data-example="true">原始 HTML</div>','[保留引用][ref]','[ref][]','、[ref]','[ref]: https://example.com','const value = 1;']) assert.ok(preserved.includes(fragment),fragment+' survives unrelated editing: '+preserved);
    await click('文档');
    await read(`(()=>{const editor=document.querySelector('.bush-page-content').editor;let range;editor.state.doc.descendants((node,pos)=>{if(!range&&node.marks.some(mark=>mark.type.name==='link'&&mark.attrs.markdownReference?.kind==='collapsed'))range={from:pos,to:pos+node.nodeSize};});editor.chain().setTextSelection(range).toggleBold().run();})()`); await frame();
    await click('Markdown'); await click('文档');
    assert.equal(await read(`document.querySelectorAll('.bush-page-content a[href="https://example.com"]').length`),3,'formatting a collapsed reference label retains its destination after reloading');
    assert.ok(await read(`!!document.querySelector('.bush-page-content a strong,.bush-page-content strong a')`),'reference labels retain formatting');
    await read(`(()=>{const editor=document.querySelector('.bush-page-content').editor;let range;editor.state.doc.descendants((node,pos)=>{if(node.type.name==='literalMarkdown'&&node.textContent==='[ref]: https://example.com')range={from:pos+1,to:pos+node.nodeSize-1};});editor.commands.insertContentAt(range,{type:'text',text:'[ref]: https://example.org/updated'});})()`); await frame();
    assert.equal(await read(`document.querySelectorAll('.bush-page-content a[href="https://example.org/updated"]').length`),3,'editing a definition immediately updates every reference destination');
    await read(`document.querySelector('.bush-page-content').editor.commands.undo()`); await frame();
    assert.equal(await read(`document.querySelectorAll('.bush-page-content a[href="https://example.com"]').length`),3,'undo restores reference destinations together with the definition');

  await click('Markdown'); await source('# 输入法核对\n\n'); await click('文档'); await frame();
    await read('window.imeEditor=document.querySelector(".bush-page-content");imeEditor.focus();imeEditor.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));imeEditor.editor.commands.insertContent("输入法组合文字");'); await frame();
    assert.ok(await read('!canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("输入法组合文字")'),'IME intermediate composition is not rewritten by a parent update');
    await read('imeEditor.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"输入法组合文字"}))'); await frame();
    await until('canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("输入法组合文字")');
    await read('imeEditor.editor.commands.focus("start");imeEditor.editor.commands.setTextSelection({from:1,to:4})'); await frame();
    await action('粗体');
    assert.ok(await read('canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("**输入法**")'),'selection formatting uses the current selection');
    await read('imeEditor.editor.commands.undo()'); await frame();
    assert.ok(await read('!canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("**")'),'formatting can be undone');

    await click('Markdown'); await source('# 让想法成为可以实践的文档\n\n先写清楚为什么，再组织内容与协作。\n\n## 从这里开始\n\n- 在页面里直接写作\n- 用 / 插入标题、列表和表格\n- 需要协作时，再加入 Team 任务\n\n![]()\n\n![]()'); await click('文档'); await frame();
    win.setSize(720,900); await frame();
    assert.ok(await read('document.querySelector(".bush-page-article").scrollWidth<=document.querySelector(".md-article-scroll").clientWidth'),'the document fits narrow windows without horizontal overflow');
    win.setSize(1120,1000); await frame(); await click('Markdown');
    const chapters='# 交互核对\n\n介绍文字。\n\n## first\n```md-node\nname: 第一章节\n```\n\n第一节内容。\n\n## last\n```md-node\nname: 第二章节\n```\n\n最后一节内容。';
    await source(chapters); await click('文档');
    assert.equal(await read('document.querySelector(".bush-page-title").spellcheck'),false);
    await pointerClick('[aria-label="插入内容"]');
    assert.ok(await read('(()=>{const menu=document.querySelector(".bush-insert-menu").getBoundingClientRect();const button=document.querySelector("[aria-label=插入内容]").getBoundingClientRect();return Math.abs(menu.left-button.left)<20&&menu.top>=button.bottom&&menu.right<=innerWidth-8;})()'),'toolbar menu opens next to its button instead of the last chapter');
    await pointerClick('[aria-label="插入内容"]');
    assert.equal(await read('!!document.querySelector(".bush-insert-menu")'),false,'clicking the same toolbar button dismisses its menu');
    await pointerClick('[aria-label="插入图片"]'); await pointerClick('[aria-label="插入图片"]');
    assert.equal(await read('document.querySelector(".md-article-introduction").querySelectorAll(".bush-page-image").length'),2,'successive image insertions preserve previous images and target the introduction by default');
    assert.equal(await read('document.querySelector("[data-document-section=last]").querySelectorAll(".bush-page-image").length'),0);
    await pointerClick('[data-document-section=last] .bush-section-title');
    await pointerClick('[aria-label="插入图片"]');
    assert.equal(await read('document.querySelector("[data-document-section=last]").querySelectorAll(".bush-page-image").length'),1,'focusing a section title changes the toolbar insertion target');
    await action('编辑章节 第二章节'); await click('删除章节'); await pointerClick('[aria-label="插入图片"]');
    assert.equal(await read('document.querySelector(".md-article-introduction").querySelectorAll(".bush-page-image").length'),3,'deleting the active editor falls back to a live editor');
    await pointerClick('[aria-label="页面菜单"]');
    assert.equal(await read('!!document.querySelector(".bush-page-menu")'),true);
    await pointerClick('.bush-page-title');
    assert.equal(await read('!!document.querySelector(".bush-page-menu")'),false,'page tools dismiss on an outside pointer click');
    await pointerClick('[aria-label="页面菜单"]'); await key('Escape');
    assert.equal(await read('!!document.querySelector(".bush-page-menu")'),false,'page tools dismiss on Escape');
    assert.equal(await read('document.activeElement.getAttribute("aria-label")'),'页面菜单','Escape returns focus to the menu trigger');
    await key('ArrowDown'); await until('!!document.querySelector(".bush-page-menu")'); await key('Home');
    assert.equal(await read('document.activeElement.textContent.trim()'),'文档','Home focuses the first page tool');
    await key('Escape');
    await click('Markdown'); await source('# 继续写作\n\n需要保留的文字。'); await click('文档');
    await read('window.slashEditor=document.querySelector(".bush-page-content");slashEditor.editor.commands.focus("end")'); await frame();
    await key('Enter'); await win.webContents.insertText('/'); await until('!!document.querySelector(".bush-insert-menu")'); await key('Escape'); await frame();
    assert.equal(await read('!!document.querySelector(".bush-insert-menu")'),false,'Escape does not immediately reopen slash commands');
    await win.webContents.insertText('section'); await until('!!document.querySelector(".bush-insert-menu")'); await key('Enter');
    assert.equal(await read('document.querySelectorAll("[data-document-section]").length'),1);
    assert.ok(await read('!canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("/section")'),'creating a linked section does not restore the deleted slash command from stale parent state');
    assert.ok(await read('canvasPages.getBushItPages().pages.find(page=>page.id===canvasPages.getBushItPages().selectedId).source.includes("需要保留的文字。")'));
    // Earlier Canvas cases can leave the sidebar collapsed. Size the content
    // viewport explicitly so the document is narrow in either sidebar state.
    win.setContentSize(700,900); await until('innerWidth===700'); await frame();
    await pointerClick('[aria-label="显示文档目录"]');
    assert.equal(await read('getComputedStyle(document.querySelector(".md-node-list")).display'),'block');
    assert.equal(await read('getComputedStyle(document.querySelector(".md-node-list")).position'),'absolute');
    assert.ok(await read('document.querySelector(".md-article-scroll").clientWidth>=document.querySelector(".md-presentation-body").clientWidth-2'),'compact outlines do not reserve an empty grid column');
    // The outline can cover the title when the Canvas sidebar is collapsed.
    // Click an actually visible article point, not a covered element's centre.
    const outside=await read(`(()=>{const r=document.querySelector('.md-article-scroll').getBoundingClientRect();const p={x:Math.round(r.right-18),y:Math.round(r.top+80)};return {...p,covered:!!document.elementFromPoint(p.x,p.y)?.closest('.md-node-list')}})()`);
    assert.equal(outside.covered,false,'the pointer targets article content outside the outline');
    for(const type of ['mouseMove','mouseDown','mouseUp'])win.webContents.sendInputEvent({type,button:'left',clickCount:1,x:outside.x,y:outside.y});await frame();
    assert.equal(await read('document.querySelector(".bush-page").dataset.outline'),'false','clicking outside the compact outline dismisses it');
    await pointerClick('[aria-label="显示文档目录"]');
    await pointerClick('[data-outline-node]');
    assert.equal(await read('document.querySelector(".bush-page").dataset.outline'),'false','choosing a chapter closes the compact outline');
    await click('图谱'); await frame();
    assert.ok(await read('document.querySelector(".md-graph").clientWidth>=250'),'the graph keeps usable width beside its editor at medium window sizes');
    await click('文档'); await pointerClick('[aria-label="插入内容"]'); await until('!!document.querySelector(".bush-insert-menu")');
    win.setSize(720,430); await frame();
    assert.ok(await read('(()=>{const r=document.querySelector(".bush-insert-menu").getBoundingClientRect();return r.left>=8&&r.right<=innerWidth-8&&r.top>=8&&r.bottom<=innerHeight-8;})()'),'popup placement remains inside a short narrow window after resize');
    await key('Escape'); win.setSize(1120,1000); await frame();
  await require('./canvas-document-streaming.cjs')({read,until,source,click,action,key,pointerClick,frame,win});
  console.log('Canvas editor passed: literal/reference preservation, reference updates and undo, IME composition and formatting.');
};
