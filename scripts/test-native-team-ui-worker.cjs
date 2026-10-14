const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Native Team/bush-it UI timed out'); app.exit(1); }, 55000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors=[]; win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
  const read = script => win.webContents.executeJavaScript(script).catch(error=>{throw Error(error.message+'; script='+script.slice(0,600)+'; errors='+errors.join('\n'))});
  const frame = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const capture = async () => {
    for (let attempt=0;attempt<3;attempt++) {
      try { const image=await win.webContents.capturePage(); assert.ok(!image.isEmpty()); return image; }
      catch (error) { if (!String(error).includes('UnknownVizError') || attempt===2) throw error; await frame(); await new Promise(resolve=>setTimeout(resolve,100)); }
    }
  };
  const key = async (keyCode,modifiers=[])=>{keyCode=keyCode.replace(/^Arrow/,'');win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});await frame()};
  const until = async script => {
    const end = Date.now() + 4000;
    while (!(await read(script))) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '; ' + await read('document.body.innerText') + '; editor=' + await read('JSON.stringify(window.bodyEditor?.editor && {focus:bodyEditor.editor.isFocused, composing:bodyEditor.editor.view.composing, selection:bodyEditor.editor.state.selection.toJSON(),parent:bodyEditor.editor.state.selection.$from.parent.textContent})'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
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
  const fill = async (name, value, scope = '.native-team-editor') => {
    await read(`(()=>{ const label=[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(label=>label.firstChild.textContent.trim()===${JSON.stringify(name)});
      const input=label.querySelector('input,textarea,select'); const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`); await frame();
  };
  const source = async value => { await read(`(()=>{const el=document.querySelector('.md-source');el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`); await frame(); };
  const dependency = async () => { await read('document.querySelector(".md-node-links input[type=checkbox]").click()'); await frame(); };
  try {
    await win.loadFile(join(directory, 'index.html'));
    // Hidden windows otherwise suppress focusin/blur, masking real multi-editor interactions.
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await require('./helpers/team-flow-workspace.cjs')({read,until,frame,click,action,fill,key,pointerClick,capture,win});
    await click('Markdown'); await read('window.sourceElement=document.querySelector(".md-source")');
    const plain = '# 普通文档\n\n## 为什么\n\n先解释理由，再决定是否执行。\n\n| 内容 | 作用 |\n| --- | --- |\n| 文档 | 说明与思考 |\n';
    await source(plain);
    assert.equal(await read('document.querySelector(".md-source")===window.sourceElement'),true,'removing Team metadata does not remount the source editor');
    assert.equal(await read('document.activeElement===window.sourceElement'),true);
    await click('文档');
    assert.equal(await read('document.querySelectorAll(".md-prose table").length'),1,'plain Markdown renders as a complete article');
    assert.equal(await read('document.querySelectorAll(".md-graph-stage,.md-graph-overview").length'),0,'ordinary writing does not require nodes');
    await click('用 Team 实践'); await click('添加任务');
    await fill('章节名称','验证文档中的想法','.md-node-editor'); await fill('员工','warehouse','.md-node-editor'); await fill('任务内容','核对依据并返回结论。','.md-node-editor');
    await click('保存到 Team'); await until('records.teams.length===2');
    assert.equal(await read('records.teams[1].definition.nodes.length'),1);
    assert.ok(await read('records.teams[1].definition.presentation.markdown.includes("先解释理由")'));
    win.setSize(1120,1000); await click('完成'); await frame();
    writeFileSync(resolve('tmp/bush-it-document.png'),(await capture()).toPNG());
    await click('Markdown'); await source('---\nname: broken');
    assert.ok(await read('document.querySelector("[role=alert]").textContent.includes("Unclosed")'));
    assert.equal(await read('document.querySelector(".md-source").value'),'---\nname: broken');
    await click('新建页面'); await until('!!document.querySelector(".bush-page-title")');
    assert.equal(await read('document.querySelectorAll(".md-node-editor").length'),0,'a new page is immediately editable without forms');
    assert.equal(await read('document.querySelector(".bush-page-title").placeholder'),'无标题页');
    assert.equal(await read('document.querySelectorAll(".bush-page-toolbar button").length'),6,'document toolbar keeps editing controls while conversation and inspector actions move to the topbar');
    assert.equal(await read('document.querySelectorAll(".md-graph-overview,.md-document-properties,.bush-page-menu").length'),0);
    for (const theme of ['dark','light']) {
      await read(`document.querySelector('.app').className='app theme-${theme}'`); await frame(); await new Promise(resolve => setTimeout(resolve, 350));
      writeFileSync(resolve(`tmp/bush-it-clean-empty-${theme}.png`),(await capture()).toPNG());
    }
    await read("document.querySelector('.app').className='app theme-dark'"); await new Promise(resolve => setTimeout(resolve, 350));
    await pointerClick('[aria-label="页面菜单"]');
    writeFileSync(resolve('tmp/bush-it-clean-menu.png'),(await capture()).toPNG());
    win.setSize(720,430); await frame();
    assert.ok(await read('(()=>{const r=document.querySelector(".bush-page-menu").getBoundingClientRect();return r.left>=12&&r.right<=innerWidth-12&&r.top>=12&&r.bottom<=innerHeight-12;})()'),'secondary page tools stay accessible in a short narrow window');
    await key('Escape'); win.setSize(1120,1000); await frame();
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
    assert.ok(await read('document.querySelector(".bush-page-list .active").textContent.includes("协作设计笔记")'));
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
    await click('文档'); const savedPageId=await read('document.querySelector(".bush-page-list .active").dataset.pageId');
    await click('新建页面'); await until('document.querySelector(".bush-page-title")?.value===""');
    await read(`document.querySelector('[data-page-id="${savedPageId}"] button').click()`); await frame();
    assert.equal(await read('document.querySelector(".bush-page-title").value'),'保留特殊内容','page switching retains independent content');
    await action('插入图片'); await until('!!document.querySelector(".bush-image-slot")');
    for (const theme of ['dark','light']) {await read(`document.querySelector('.app').className='app theme-${theme}'`);await frame();writeFileSync(resolve(`tmp/bush-it-page-${theme}.png`),(await capture()).toPNG());}
    await action('插入内容'); await frame();writeFileSync(resolve('tmp/bush-it-page-menu.png'),(await capture()).toPNG());
    await read('document.querySelector(".bush-page-title").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))'); await frame();
    assert.equal(await read('!!document.querySelector(".bush-insert-menu")'),false,'outside clicks dismiss insertion');
    await read('pages.flushBushItPages()');
    const persisted=await read('JSON.parse(localStorage.getItem("cardbush.bush-it.pages.v1"))');
    assert.equal(persisted.selectedId,savedPageId); assert.ok(persisted.pages.some(page=>page.source.includes('新增内容。')));
    await read(`document.querySelector('[data-page-id="${savedPageId}"] button[aria-label="移至回收站"]').click()`); await frame();
    assert.equal(await read(`!!document.querySelector('.bush-page-list [data-page-id="${savedPageId}"]')`),false);
    await click('回收站'); await read(`document.querySelector('[data-page-id="${savedPageId}"] button[aria-label="恢复页面"]').click()`); await frame();
    await click('返回页面'); await read(`document.querySelector('[data-page-id="${savedPageId}"] button').click()`); await frame();
    await read('pages.flushBushItPages()'); await win.loadFile(join(directory,'index.html')); await until('!!window.setApp'); await read('setApp("md")');
    await until('document.querySelector(".bush-page-title")?.value==="保留特殊内容"');
    assert.ok(await read('document.querySelector(".bush-page-content").textContent.includes("新增内容。")'),'pages survive application reload');
    await click('新建页面'); await frame();
    await read('window.imeEditor=document.querySelector(".bush-page-content");imeEditor.focus();imeEditor.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}));imeEditor.editor.commands.insertContent("输入法组合文字");'); await frame();
    assert.ok(await read('!pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("输入法组合文字")'),'IME intermediate composition is not rewritten by a parent update');
    await read('imeEditor.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"输入法组合文字"}))'); await frame();
    await until('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("输入法组合文字")');
    await read('imeEditor.editor.commands.focus("start");imeEditor.editor.commands.setTextSelection({from:1,to:4})'); await frame();
    await action('粗体');
    assert.ok(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("**输入法**")'),'selection formatting uses the current selection');
    await read('imeEditor.editor.commands.undo()'); await frame();
    assert.ok(await read('!pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("**")'),'formatting can be undone');
    await click('Markdown'); await source('# 让想法成为可以实践的文档\n\n先写清楚为什么，再组织内容与协作。\n\n## 从这里开始\n\n- 在页面里直接写作\n- 用 / 插入标题、列表和表格\n- 需要协作时，再加入 Team 任务\n\n![]()\n\n![]()'); await click('文档'); await frame();
    writeFileSync(resolve('tmp/bush-it-page-final.png'),(await capture()).toPNG());
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
    await key('ArrowDown'); await until('!!document.querySelector(".bush-page-menu")'); await key('End');
    assert.equal(await read('document.activeElement.textContent.trim()'),'保存 .md','page tools support keyboard navigation');
    await key('Escape');
    await click('Markdown'); await source('# 继续写作\n\n需要保留的文字。'); await click('文档');
    await read('window.slashEditor=document.querySelector(".bush-page-content");slashEditor.editor.commands.focus("end")'); await frame();
    await key('Enter'); await win.webContents.insertText('/'); await until('!!document.querySelector(".bush-insert-menu")'); await key('Escape'); await frame();
    assert.equal(await read('!!document.querySelector(".bush-insert-menu")'),false,'Escape does not immediately reopen slash commands');
    await win.webContents.insertText('section'); await until('!!document.querySelector(".bush-insert-menu")'); await key('Enter');
    assert.equal(await read('document.querySelectorAll("[data-document-section]").length'),1);
    assert.ok(await read('!pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("/section")'),'creating a linked section does not restore the deleted slash command from stale parent state');
    assert.ok(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("需要保留的文字。")'));
    win.setSize(900,900); await frame();
    await pointerClick('[aria-label="显示文档目录"]');
    assert.equal(await read('getComputedStyle(document.querySelector(".md-node-list")).display'),'block');
    assert.equal(await read('getComputedStyle(document.querySelector(".md-node-list")).position'),'absolute');
    assert.ok(await read('document.querySelector(".md-article-scroll").clientWidth>=document.querySelector(".md-presentation-body").clientWidth-2'),'compact outlines do not reserve an empty grid column');
    await pointerClick('.bush-page-title');
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
    const sidebarWidth=await read('document.querySelector(".bush-pages-sidebar-content").getBoundingClientRect().width');
    await read('document.querySelector(".bush-it-sidebar").classList.replace("soft-panel-visible","soft-panel-hidden")'); await frame();
    assert.equal(await read('document.querySelector(".bush-pages-sidebar-content").getBoundingClientRect().width'),sidebarWidth,'sidebar content keeps its width while the outer panel collapses');
    await read('document.querySelector(".bush-it-sidebar").classList.replace("soft-panel-hidden","soft-panel-visible")'); await frame();
    await until('document.querySelector(".bush-sidebar-back").getBoundingClientRect().left>=11.9');
    writeFileSync(resolve('tmp/bush-it-bugs-fixed.png'),(await capture()).toPNG());
    // Exercise the project editor with actual DOM input, polling and its send boundary.
    await read(`
      window.projectFiles={
        'D:/writing/first.md':{path:'D:/writing/first.md',text:'# 第一篇\\n\\n原段落\\n\\n[第二篇](notes/second.md)',revision:'r1'},
        'D:/writing/notes/second.md':{path:'D:/writing/notes/second.md',text:'# 第二篇\\n\\n项目资料\\n\\n'+('背景段落\\n\\n'.repeat(30))+'## 目标段落\\n\\n这里是跨文档目标。',revision:'r2'}
      }; window.fileRevision=2;
      cardbushDesktop.pickProjectDirectory=async()=> 'D:/writing';
      cardbushDesktop.readWorkspaceDirectory=async({directoryPath,rootPath})=>({entries: directoryPath.endsWith('/notes')
        ? [{name:'second.md',path:rootPath+'/notes/second.md',kind:'file'}]
        : [{name:'notes',path:rootPath+'/notes',kind:'folder'},...Object.keys(projectFiles).filter(path=>path.slice(rootPath.length+1).indexOf('/')<0).map(path=>({name:path.split('/').pop(),path,kind:'file'}))]});
      cardbushDesktop.markdownFile=async input=>{
        fileCalls.push(input);const path=/^[A-Z]:/i.test(input.path||'')?input.path:input.rootPath+'/'+input.path;
        const old=projectFiles[path];
        if(input.action==='open'||input.action==='reload'){if(!old)throw Error('Missing file');return {...old};}
        if(input.action==='create'&&old)throw Error('Exists');
        if(input.action==='save'&&old?.revision!==input.revision)throw Error('File changed');
        const file={path,text:input.text||'',revision:'r'+(++fileRevision)};projectFiles[path]=file;return {...file};
      };
      void 0;
    `);
    await click('打开文件夹'); await until('!!document.querySelector(".creation-file-tree")');
    await click('first.md'); await until('document.querySelector(".bush-page-title")?.value==="第一篇"');
    await click('Markdown'); await until('!!document.querySelector(".creation-source-input")');
    assert.equal(await read('document.querySelector(".creation-line-numbers").textContent'), '1\n2\n3\n4\n5');
    await source('# 第一篇\n\n本地修改\n\n[第二篇](notes/second.md#目标段落) · [返回标题](#第一篇) · [同页标题](first.md#第一篇)');
    await until('projectFiles["D:/writing/first.md"].text.includes("本地修改")');
    assert.ok(await read('document.querySelector(".creation-source-preview").textContent.includes("本地修改")'));
    await read("document.querySelector('.creation-source-preview a[href^=\"notes/\"]').click()");
    await until('document.querySelector(".bush-page-title")?.value==="第二篇"');
    await until('document.querySelector(".md-article-scroll").scrollTop>200');
    assert.ok(await read('(()=>{const target=document.querySelector(".bush-page-content h2").getBoundingClientRect(),viewport=document.querySelector(".md-article-scroll").getBoundingClientRect();return target.top>=viewport.top && target.bottom<=viewport.bottom})()'),'relative Markdown links retain their target heading after the file loads');
    assert.equal(await read('document.querySelectorAll(".creation-file-tabs, .creation-save-status, .creation-top-actions [aria-label=创作对话]").length'), 0);
    await click('first.md'); await until('document.querySelector(".bush-page-title")?.value==="第一篇"');
    await read('window.sameFileEditor=document.querySelector(".bush-page-content")');
    await pointerClick('.bush-page-content a[href="first.md#第一篇"]');
    assert.equal(await read('sameFileEditor===document.querySelector(".bush-page-content")'),true,'same-file links keep the current editor and undo history');
    await click('Markdown');
    await read('(()=>{const el=document.querySelector(".md-source");el.focus();el.setSelectionRange(el.value.indexOf("本地修改"),el.value.indexOf("本地修改")+4);el.dispatchEvent(new Event("select",{bubbles:true}));})()'); await frame();
    const writingHeight = await read('document.querySelector(".creation-editor").getBoundingClientRect().height');
    const beforeWritingChat = await read('sessionInputs.length');
    await click('输入'); await until('!!window.creationChatProps');
    assert.equal(await read('document.querySelector(".creation-editor").getBoundingClientRect().height'), writingHeight, 'opening AI never shrinks the document');
    assert.ok(await read('!!document.querySelector(".creation-app > .topbar [data-inspector-toggle]")'), 'inspector toggle stays in the application header');
    assert.equal(await read('!!document.querySelector(".bush-page-toolbar [data-inspector-toggle]")'), false);
    await action('展开右侧栏'); assert.equal(await read('window.inspectorOpened'), true);
    assert.equal(await read('sessionInputs.length'), beforeWritingChat, 'opening the writing input creates no session');
    const request = await read('creationChatProps.beforeSend("改写选中段落")');
    assert.equal(request.text,'改写选中段落'); assert.ok(request.context[0].content.includes('D:/writing/first.md')); assert.ok(request.context[0].content.includes('3–3')); assert.ok(!JSON.stringify(request).includes('本地修改'));
    await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    await read('(()=>{const el=document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]");el.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"请改写第三行");el.dispatchEvent(new Event("input",{bubbles:true}));})()'); await frame();
    await key('Enter'); await until('!!window.creationSubmitted');
    assert.equal(await read('creationSessionInput.projectDir'), 'D:/writing');
    assert.equal(await read('creationSessionInput.metadata.creation_workspace'), true);
    assert.ok(await read('creationSubmitted.text==="请改写第三行"&&creationSubmitted.context[0].content.includes("D:/writing/first.md")&&creationSubmitted.context[0].content.includes("3–3")'));
    await until('document.querySelector(".creation-workspace .inspector-quick-input").textContent.includes("已回复")');
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-quick-input").textContent.includes("已更新文档")'), false, 'collapsed conversation does not leak reply text or raw Markdown paths');
    await until('window.creationInspector?.messages.length===2');
    assert.equal(await read('creationInspector.sessionId'), await read('creationSessionInput.sessionId'), 'the shared inspector follows the document conversation');
    assert.equal(await read('creationInspector.root'), 'D:/writing');
    assert.equal(await read('document.querySelector(".creation-workspace .quick-input-conversation").dataset.expanded'), 'false');
    await read('document.querySelector(".creation-workspace .quick-input-status").click()'); await until('!document.querySelector(".creation-workspace .quick-input-transcript").hidden');
    assert.ok(await read('document.querySelector(".creation-workspace .quick-input-transcript").textContent.includes("已更新文档")'));
    assert.ok(await read('document.querySelector(".creation-workspace .quick-input-transcript").textContent.includes("请改写第三行")'));
    assert.equal(await read('/编辑位置|D:\\/writing|promptContext/.test(document.querySelector(".creation-workspace .quick-input-transcript").textContent)'),false,'expanded user bubbles contain only the authored request');
    writeFileSync(resolve('tmp/creation-clean-prompt.png'), (await capture()).toPNG());
    await read('document.querySelector(".creation-workspace .quick-input-status").click()'); await frame();
    // The actual Create editor receives the same ordered preview events as Runtime.
    await read(`window.liveBase=projectFiles['D:/writing/first.md'].text; window.liveSeq=0;
      window.fileEvent=(kind,payload,sessionId=creationSessionInput.sessionId)=>publishFileEditEvent({protocol:'bush.runtime_event.v1',kind,payload,sessionId,turnId:'live-turn',requestId:'live-request',eventId:'live-'+(++liveSeq),sequence:liveSeq,createdAt:new Date().toISOString()});
      window.editChunk=(id,delta,offset=0,state='streaming')=>fileEvent('file_edit_preview',{previewId:id,toolCallId:id,toolName:'edit_file',delta,offset,state});
      window.liveInput=JSON.stringify({path:'D:/writing/first.md',old_text:'本地修改',new_text:'实时写入'});
      window.livePrefix=liveInput.slice(0,liveInput.indexOf('实时写入')+2);
      document.querySelector('.md-source').focus();editChunk('live-1',livePrefix);`);
    await until('document.querySelector(".md-source").value.includes("实时") && !!document.querySelector(".ai-editing-cursor")');
    assert.equal(await read('document.activeElement===document.querySelector(".md-source")'),true,'a focused editor does not block the animation or lose focus');
    await pointerClick('.md-source'); await key('Escape');
    assert.equal(await read('document.querySelector(".bush-page").dataset.aiEditing'),'true','clicking/selecting text and Escape do not cancel a visual preview');
    await action('显示文档目录');
    await read(`(()=>{const input=document.querySelector('[aria-label="查找章节"]');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'章节');input.dispatchEvent(new Event('input',{bubbles:true}));})()`); await frame();
    assert.equal(await read('document.querySelector(".bush-page").dataset.aiEditing'),'true','outline search is independent of the document animation');
    await action('显示文档目录');
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source'), await read('liveBase'), 'streaming preview does not become an autosave draft');
    await new Promise(resolve=>setTimeout(resolve,760));
    assert.equal(await read('projectFiles["D:/writing/first.md"].text'), await read('liveBase'), 'partial text is never written to disk');
    await click('文档'); await until('document.querySelector(".bush-page-content").textContent.includes("实时")');
    await pointerClick('.bush-page-content a[href="#第一篇"]');
    await read(`document.querySelector('.bush-page-content a[href="#第一篇"]').focus()`); await key('Enter');
    assert.equal(await read('document.querySelector(".bush-page").dataset.aiEditing'),'true','pointer and keyboard link navigation leave the visual stream running');
    await action('插入内容'); await until('!!document.querySelector(".bush-insert-menu input")');
    await read(`(()=>{const input=document.querySelector('.bush-insert-menu input');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'表');input.dispatchEvent(new Event('input',{bubbles:true}));window.liveMenuFocus=input;editChunk('live-1',liveInput.slice(livePrefix.length,livePrefix.length+1),livePrefix.length);})()`); await frame();
    assert.equal(await read('document.querySelector(".bush-insert-menu input")?.value'),'表','new streamed chunks keep the open insert menu and its search query');
    assert.equal(await read('document.activeElement===liveMenuFocus'),true,'streamed content does not steal focus from a menu');
    await read('document.querySelector(".md-article-scroll").dispatchEvent(new Event("scroll"))'); await frame();
    assert.equal(await read('document.querySelector(".bush-insert-menu input")?.value'),'表','automatic cursor following also keeps the menu open');
    await key('Escape');
    await read('document.querySelector(".creation-view-switch button").focus()');
    await read('window.unchangedParagraph=document.querySelector(".bush-page-content").lastElementChild; editChunk("live-1",liveInput.slice(livePrefix.length+1),livePrefix.length+1,"ready")');
    await until('document.querySelector(".bush-page-content").textContent.includes("实时写入") && document.querySelector(".ai-editing-cursor")?.dataset.state==="ready"');
    assert.equal(await read('unchangedParagraph===document.querySelector(".bush-page-content").lastElementChild'), true, 'unchanged document blocks retain their DOM while streaming');
    assert.equal(await read('document.activeElement.matches("[contenteditable=true],.bush-page-title")'), false, 'AI typing does not steal keyboard focus');
    assert.ok(await read('(()=>{const text=document.querySelector(".bush-page-content p").getBoundingClientRect(),caret=document.querySelector(".ai-editing-caret").getBoundingClientRect(),pointer=document.querySelector(".ai-editing-cursor svg").getBoundingClientRect();return caret.top>=text.top&&caret.bottom<=text.bottom+2&&Math.abs(pointer.top-caret.bottom)<10;})()'), 'the caret and shared mouse indicator follow the edited text, not the next paragraph or viewport origin');
    writeFileSync(resolve('tmp/creation-live-edit.png'),(await capture()).toPNG());
    await read(`projectFiles['D:/writing/first.md']={...projectFiles['D:/writing/first.md'],text:liveBase.replace('本地修改','实时写入'),revision:'live-saved'};fileEvent('tool_returned',{toolCallId:'live-1',toolName:'edit_file',ordinal:0});`);
    await until('!document.querySelector(".ai-editing-cursor") && pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("实时写入")');
    // Incremental whole-document input also tolerates changing Markdown structure.
    await read(`window.streamedDocument='# 流式标题\\n\\n第一段\\n\\n## 分节\\n\\n- 条目一\\n- 条目二\\n\\n\`\`\`js\\nconst value = 1;\\n\`\`\`\\n\\n| 名称 | 数量 |\\n| --- | --- |\\n| 产品 | 3 |';
      window.structuralInput=JSON.stringify({path:'D:/writing/first.md',content:streamedDocument});window.structureOffset=0;`);
    const structuralLength = await read('structuralInput.length');
    for (let offset=0;offset<structuralLength;offset+=23) {
      await read(`fileEvent('file_edit_preview',{previewId:'structure',toolCallId:'structure',toolName:'write_file',offset:${offset},delta:structuralInput.slice(${offset},${offset+23}),state:'streaming'})`); await frame();
    }
    await until('!!document.querySelector(".bush-page-content table") && document.querySelector(".bush-page-content").textContent.includes("产品")');
    assert.equal(await read('projectFiles["D:/writing/first.md"].text'), await read('liveBase.replace("本地修改","实时写入")'));
    await read(`fileEvent('file_edit_preview',{previewId:'structure',toolCallId:'structure',toolName:'write_file',offset:structuralInput.length,delta:'',state:'discarded'})`);
    await until('document.querySelector(".bush-page-content").textContent.includes("实时写入") && !document.querySelector(".ai-editing-cursor")');
    await read(`window.failedInput=JSON.stringify({path:'D:/writing/first.md',old_text:'实时写入',new_text:'失败的预览'});editChunk('live-fail',failedInput);`);
    await until('document.querySelector(".bush-page-content").textContent.includes("失败的预览")');
    await read(`fileEvent('tool_failed',{toolCallId:'live-fail',toolName:'edit_file',ordinal:1,error:{kind:'tool',code:'stale',message:'stale'}})`);
    await until('!document.querySelector(".ai-editing-cursor") && document.querySelector(".bush-page-content").textContent.includes("实时写入")');
    await read(`fileEvent('file_edit_preview',{previewId:'other-session',toolCallId:'other',toolName:'edit_file',delta:failedInput,offset:0,state:'streaming'},'unrelated-session')`); await frame();
    assert.equal(await read('document.querySelector(".bush-page-content").textContent.includes("失败的预览")'),false,'another conversation cannot animate this document');
    await read(`editChunk('live-stop',failedInput)`); await until('document.querySelector(".bush-page-content").textContent.includes("失败的预览")');
    await read(`publishFileEditEvent({kind:'file_edit_preview_reset',sessionId:creationSessionInput.sessionId,turnId:'live-turn',createdAt:new Date().toISOString()})`);
    await until('!document.querySelector(".ai-editing-cursor") && document.querySelector(".bush-page-content").textContent.includes("实时写入")');
    await click('Markdown');
    await read(`editChunk('live-takeover',failedInput)`); await until('document.querySelector(".md-source").value.includes("失败的预览")');
    await pointerClick('.md-source'); await key('Escape');
    assert.ok(await read('document.querySelector(".md-source").value.includes("失败的预览")'),'focus and Escape leave the animation running');
    await read('(()=>{const input=document.querySelector(".md-source");input.focus();input.setSelectionRange(input.value.indexOf("[第二篇]"),input.value.indexOf("[第二篇]"))})()');
    await win.webContents.insertText(' 人工编辑'); await frame();
    assert.ok(await read('document.querySelector(".md-source").value.includes("实时写入") && document.querySelector(".md-source").value.includes("人工编辑") && !document.querySelector(".md-source").readOnly'),'actual input applies to the committed source');
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("失败的预览")'),false,'manual input never persists a partial AI preview');
    assert.ok(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes(" 人工编辑[第二篇]")'),'restoring the committed text preserves the user insertion location');
    await read(`editChunk('live-takeover',' ',failedInput.length)`); await frame();
    assert.equal(await read('!!document.querySelector(".ai-editing-cursor")'),false,'later fragments cannot overwrite a user takeover');
    await source(await read('liveBase.replace("本地修改","实时写入")'));
    await until('pageState.pages.find(page=>page.id===pageState.selectedId).source===pageState.pages.find(page=>page.id===pageState.selectedId).file.text');
    await read(`document.querySelector('.md-source').focus();document.querySelector('.md-source').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));editChunk('live-ime',failedInput)`); await frame();
    assert.equal(await read('!!document.querySelector(".ai-editing-cursor")'),false,'active keyboard/IME editing takes precedence over a new preview');
    await read(`document.querySelector('.md-source').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));document.activeElement.blur();`);
    await click('文档');
    await read(`editChunk('live-manual-rich',failedInput)`); await until('document.querySelector(".bush-page-content").textContent.includes("失败的预览")');
    await read('document.querySelector(".bush-page-content").editor.commands.focus("start")'); await frame();
    await win.webContents.insertText('人工正文'); await frame();
    assert.ok(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("人工正文") && !pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("失败的预览")'),'real rich-text input also restores committed content before applying the edit');
    await click('Markdown'); await source(await read('liveBase.replace("本地修改","实时写入")'));
    await until('pageState.pages.find(page=>page.id===pageState.selectedId).source===pageState.pages.find(page=>page.id===pageState.selectedId).file.text');
    await click('文档');
    await read(`editChunk('live-toolbar-edit',failedInput)`); await until('document.querySelector(".bush-page-content").textContent.includes("失败的预览")');
    await action('插入图片'); await frame();
    assert.ok(await read('!!document.querySelector(".bush-page-image") && !pageState.pages.find(page=>page.id===pageState.selectedId).source.includes("失败的预览")'),'a toolbar insertion edits committed content without saving the animation');
    await click('Markdown'); await source(await read('liveBase.replace("本地修改","实时写入")'));
    await until('pageState.pages.find(page=>page.id===pageState.selectedId).source===pageState.pages.find(page=>page.id===pageState.selectedId).file.text');
    await read('projectFiles["D:/writing/first.md"]={...projectFiles["D:/writing/first.md"],text:"# 第一篇\\n\\nAgent 已改写",revision:"agent-edit"}');
    await until('document.querySelector(".md-source")?.value.includes("Agent 已改写")');
    assert.ok(await read('document.querySelector(".creation-source-preview").textContent.includes("Agent 已改写")'));
    await source('# 第一篇\n\n待保留的人工草稿');
    await read('projectFiles["D:/writing/first.md"]={...projectFiles["D:/writing/first.md"],text:"# 第一篇\\n\\nAgent 的新版本",revision:"agent-conflict"}');
    await until('!!document.querySelector(".creation-conflict")');
    assert.ok(await read('document.querySelector(".md-source").value.includes("待保留的人工草稿")'));
    assert.ok(await read('projectFiles["D:/writing/first.md"].text.includes("Agent 的新版本")'));
    await click('保留草稿并载入新版本'); await frame();
    assert.ok(await read('pageState.pages.some(page=>!page.file&&page.source.includes("待保留的人工草稿"))'));
    assert.ok(await read('document.querySelector(".md-source").value.includes("Agent 的新版本")'));
    await click('输入'); await until('!!document.querySelector(".creation-workspace .inspector-quick-input")');
    win.setSize(1500,1000); await frame();
    assert.ok(await read('document.querySelector(".creation-editor").getBoundingClientRect().width>500'));
    writeFileSync(resolve('tmp/creation-project.png'),(await capture()).toPNG());
    win.setSize(800,800); await frame();
    assert.notEqual(await read('getComputedStyle(document.querySelector(".creation-editor")).display'), 'none', 'compact conversation does not replace the document on narrow screens');
    assert.ok(await read('(()=>{const editor=document.querySelector(".creation-editor").getBoundingClientRect();const chat=document.querySelector(".creation-workspace .inspector-quick-input").getBoundingClientRect();return editor.height>500&&chat.top>=editor.top&&chat.bottom<=editor.bottom&&chat.right<=editor.right&&chat.left>=editor.left;})()'), 'floating input fits inside a narrow document without consuming its height');
    // Actual pointer dragging flips the input below the handle and keeps it on screen.
    const handle = await read('(()=>{const r=document.querySelector(".creation-workspace .inspector-cover-drag").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    const edge = await read('(()=>{const r=document.querySelector(".creation-workspace").getBoundingClientRect();return {x:Math.round(r.right-2),y:Math.round(r.top+55)}})()');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...handle});
    win.webContents.sendInputEvent({type:'mouseMove',...edge}); await frame();
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...edge}); await frame();
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-cover-controls").dataset.expands'), 'below');
    assert.ok(await read('(()=>{const r=document.querySelector(".creation-workspace").getBoundingClientRect(),p=document.querySelector(".creation-workspace .inspector-quick-input").getBoundingClientRect(),c=document.querySelector(".creation-workspace .inspector-cover-capsule").getBoundingClientRect();return p.left>=r.left&&p.right<=r.right&&p.top>=c.bottom&&p.bottom<=r.bottom;})()'));
    await read('document.querySelector(".creation-workspace .inspector-cover-drag").focus()'); await key('Home');
    await read('(()=>{const el=document.createElement("div");el.setAttribute("role","dialog");el.setAttribute("aria-modal","true");el.textContent="Image preview";document.body.append(el);el.addEventListener("pointerdown",()=>el.remove());el.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));})()'); await frame();
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-cover-input-toggle").getAttribute("aria-expanded")'), 'true', 'closing a modal does not dismiss the input underneath');
    await read('document.querySelector(".creation-editor").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))'); await frame();
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-quick-input")'), false, 'clicking the document dismisses the input');
    await click('输入'); await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    await key('Escape'); await frame();
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-quick-input")'), false);
    await click('输入'); await frame();
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-cover-back")'), false, 'creation has only Input and its drag handle');
    await read('document.querySelector(".creation-workspace .inspector-cover-input-toggle").click()'); await frame();
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-quick-input")'), false, 'Input toggles the panel closed');
    assert.notEqual(await read('getComputedStyle(document.querySelector(".creation-editor")).display'), 'none');
    assert.ok(await read('document.querySelector(".bush-page-toolbar").scrollWidth<=document.querySelector(".bush-page-toolbar").clientWidth+1'));
    await action('新建 Markdown');
    await read('(()=>{const el=document.querySelector("[aria-label=新文件名]");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"third.md");el.dispatchEvent(new Event("input",{bubbles:true}));})()'); await frame();
    await click('创建'); await until('!!projectFiles["D:/writing/third.md"]');
    assert.equal(await read('creationChatProps.sessionId'), await read('creationSessionInput.sessionId'), 'files in one project share the conversation');
    await read('pages.flushBushItPages()');
    assert.equal(await read('JSON.parse(localStorage.getItem("cardbush.bush-it.pages.v1")).projectDir'), 'D:/writing');
    // A temporary document needs neither a filename nor a directory, including from a project.
    const callsBeforeDraft=await read('fileCalls.length');
    await key('n',['control']); await until('pageState.projectDir==="" && pageState.pages.find(page=>page.id===pageState.selectedId)?.temporary');
    assert.equal(await read('fileCalls.length'), callsBeforeDraft, 'new temporary documents do not open a file dialog or create files');
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).file'), undefined);
    await click('Markdown'); await source('# 随手记\n\n先写完再保存。');
    await read(`window.taskRoot='C:/Users/test/AppData/Roaming/cardbush/task-workspaces/temporary-test';cardbushDesktop.ensureTaskWorkspace=async()=>taskRoot;void 0;`);
    const beforeDraftSession = await read('sessionInputs.length');
    await click('输入'); await until('!!window.creationInspector && creationChatProps.preparation?.metadata.creation_workspace');
    assert.equal(await read('sessionInputs.length'), beforeDraftSession);
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).file'), undefined, 'opening draft input creates no backing file');
    await read('creationInspector.send("继续编辑")'); await until('!!pageState.sessions[taskRoot]');
    assert.equal(await read('creationSessionInput.projectDir'), undefined);
    assert.equal(await read('fixtureConversations[creationSessionInput.sessionId].metadata.workspace_mode'), 'task');
    assert.equal(await read('pageState.projectDir'), '', 'starting the Agent preserves the draft workspace');
    assert.equal(await read('pageState.projects.includes(taskRoot)'), false, 'generated workspace IDs never become visible spaces');
    assert.ok(await read('pageState.pages.find(page=>page.id===pageState.selectedId).temporary'));
    assert.equal(await read('document.querySelector(".creation-app > .topbar h1").textContent'), '随手记');
    assert.equal(await read('document.querySelectorAll(".creation-file-tabs, .creation-save-status").length'), 0);
    assert.ok(await read('creationChatProps.beforeSend("继续编辑")').then(prompt=>prompt.text==='继续编辑' && prompt.context[0].content.includes('document-') && !JSON.stringify(prompt).includes('先写完再保存。')));
    // The same composer can move to a covered inspector and return without losing its draft.
    await read(`(()=>{const el=document.createElement('div');el.id='inspector-fixture';el.className='inspector-quick-input';document.querySelector('.app').appendChild(el);setCreationPortal(el);})()`);
    await until('!!document.querySelector("#inspector-fixture [data-composer-input]")');
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-cover-controls")'), false, 'the covered inspector owns the only input entry');
    await read('creationInspector.appendDraft("继续润色这篇文档")'); await frame();
    assert.equal(await read('document.querySelector("#inspector-fixture [data-composer-input]").value'), '继续润色这篇文档');
    await read('setCreationPortal(null)'); await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]").value'), '继续润色这篇文档');
    await key('Escape'); await frame(); await click('输入');
    await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]").value'), '继续润色这篇文档', 'closing and reopening preserves the draft');
    await read('document.querySelector("#inspector-fixture").remove()');
    // Ctrl+S still prompts for Save As when an Agent backing file already exists.
    await read(`window.projectMarkdown=cardbushDesktop.markdownFile;cardbushDesktop.markdownFile=async input=>{if(input.action==='save'&&!input.path){window.saveAsRequest=input;const file={path:'D:/writing/saved-draft.md',text:input.text,revision:'saved-draft'};projectFiles[file.path]=file;return file;}return projectMarkdown(input);};void 0;`);
    await key('s',['control']); await until('!!window.saveAsRequest && !pageState.pages.find(page=>page.id===pageState.selectedId).temporary');
    assert.equal(await read('saveAsRequest.name'), '随手记');
    assert.equal(await read('projectFiles["D:/writing/saved-draft.md"].text'), '# 随手记\n\n先写完再保存。');
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).file.path'), 'D:/writing/saved-draft.md');
    assert.equal(await read('creationChatProps.sessionId'), await read('pageState.sessions[taskRoot]'), 'Save As retains the draft conversation rather than switching to an existing destination-project conversation');
    assert.equal(await read('document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]").value'), '继续润色这篇文档');
    assert.ok(await read('creationChatProps.beforeSend("修改保存后的文件")').then(prompt=>prompt.text==='修改保存后的文件' && prompt.context[0].content.includes('D:/writing/saved-draft.md')));
    win.setSize(1280,900); await frame(); await click('文档');
    await read('if(document.querySelector(".creation-workspace .inspector-cover-input-toggle").getAttribute("aria-expanded")==="true")document.querySelector(".creation-workspace .inspector-cover-input-toggle").click()'); await frame();
    writeFileSync(resolve('tmp/creation-document-collapsed.png'),(await capture()).toPNG());
    await click('输入'); await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    writeFileSync(resolve('tmp/creation-document-input.png'),(await capture()).toPNG());
    // New drafts do not inherit an open, empty input from the previous document.
    await key('n',['control']); await frame();
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-quick-input")'), false);
    await read('window.deferredWorkspace=new Promise(resolve=>window.finishWorkspace=()=>resolve(taskRoot+"-delayed"));cardbushDesktop.ensureTaskWorkspace=()=>deferredWorkspace;void 0');
    await click('输入'); await until('!!document.querySelector(".creation-workspace .inspector-quick-input [data-composer-input]")');
    await read('void creationInspector.send("写一篇新文档")'); await frame();
    await click('输入'); await read('finishWorkspace()'); await until('!!pageState.sessions[taskRoot+"-delayed"]');
    assert.equal(await read('!!document.querySelector(".creation-workspace .inspector-quick-input")'), false, 'late preparation cannot reopen an input dismissed by the user');
    // These are the actual directory destinations from the reported FastAPI document.
    const destinations = [
      ['一、定位与核心设计','一定位与核心设计'], ['二、安装与最小应用','二安装与最小应用'],
      ['三、路由与参数系统','三路由与参数系统'], ['四、Pydantic 模型与数据校验','四pydantic-模型与数据校验'],
      ['五、响应控制','五响应控制'], ['六、依赖注入系统','六依赖注入系统'], ['七、中间件、CORS 与异常处理','七中间件cors-与异常处理'],
      ['八、安全与认证','八安全与认证'], ['九、数据库集成','九数据库集成'], ['十、生命周期与后台任务','十生命周期与后台任务'],
      ['十一、异步编程要点','十一异步编程要点'], ['十二、文件上传、表单与流式响应','十二文件上传表单与流式响应'],
      ['十三、项目结构与分层','十三项目结构与分层'], ['十四、测试','十四测试'], ['十五、部署与性能调优','十五部署与性能调优'],
      ['十六、OpenAPI 文档定制','十六openapi-文档定制'], ['十七、与其他框架对比','十七与其他框架对比'], ['十八、常见坑与排查清单','十八常见坑与排查清单'],
    ];
    const navigationSource='# FastAPI 完全详解\n\n## 目录\n\n'+destinations.map(([label,slug],index)=>`${index+1}. [${label}](#${slug})`).join('\n')
      +'\n\n[重复标题](#重复-标题-1) · [编码标题](#'+encodeURIComponent('七中间件cors-与异常处理')+') · [官网](https://fastapi.tiangolo.com/tutorial/) · [无效目录](#不存在)\n\n'
      +destinations.map(([label])=>`## ${label}\n\n${'正文内容。\n\n'.repeat(6)}`).join('\n')+'\n\n## **重复** `标题`\n\n第一处。\n\n## 重复 标题\n\n第二处。\n\n'+('末尾段落。\n\n'.repeat(40));
    await click('Markdown'); await source(navigationSource); await click('文档');
    await until('document.querySelectorAll(".bush-page-content h2").length===21');
    const navigationUrl=await read('location.href');
    for (const [label,slug] of destinations) {
      await pointerClick(`.bush-page-content a[href="#${slug}"]`);
      assert.ok(await read(`(()=>{const target=[...document.querySelectorAll('.bush-page-content h2')].find(item=>item.textContent===${JSON.stringify(label)}).getBoundingClientRect(),viewport=document.querySelector('.md-article-scroll').getBoundingClientRect();return target.top>=viewport.top && target.bottom<=viewport.bottom})()`),`directory link reaches ${label}`);
    }
    await pointerClick('.bush-page-content a[href="#重复-标题-1"]');
    assert.ok(await read('(()=>{const targets=[...document.querySelectorAll(".bush-page-content h2")].filter(item=>item.textContent==="重复 标题");const viewport=document.querySelector(".md-article-scroll").getBoundingClientRect(),target=targets[1].getBoundingClientRect();return targets[0].getBoundingClientRect().bottom<viewport.top && target.top>=viewport.top && target.bottom<=viewport.bottom})()'),'duplicate heading anchors select the second heading');
    await read(`document.querySelector('.bush-page-content a[href="#${encodeURIComponent('七中间件cors-与异常处理')}"]').focus()`); await key('Enter');
    assert.equal(await read('!!document.querySelector(".md-link-notice")'), false, 'encoded anchors work with keyboard activation');
    await read(`window.openedLink=null;window.addEventListener('cardbush:open-inspector',event=>window.openedLink=event.detail);document.querySelector('.bush-page-content a[href^="https:"]').click()`); await frame();
    assert.equal(await read('openedLink?.target'), 'https://fastapi.tiangolo.com/tutorial/', 'web links use the existing in-app browser');
    await pointerClick('.bush-page-content a[href="#不存在"]');
    assert.ok(await read('document.querySelector(".md-link-notice").textContent.includes("未找到")'));
    assert.equal(await read('location.href'),navigationUrl,'missing headings cannot change the application route');
    assert.equal(await read('pageState.pages.find(page=>page.id===pageState.selectedId).source'),navigationSource,'following links does not modify Markdown or create an edit');
    await click('Markdown');
    await until('!!document.querySelector(".md-source")');
    if (!(await read('!!document.querySelector(".creation-source-preview")'))) await click('实时预览');
    await pointerClick(`.creation-source-preview a[href="${encodeURI('#重复-标题-1')}"]`);
    assert.ok(await read('(()=>{const targets=[...document.querySelectorAll(".creation-source-preview h2")].filter(item=>item.textContent==="重复 标题");const viewport=document.querySelector(".creation-source-preview").getBoundingClientRect();return targets[1].getBoundingClientRect().top>=viewport.top && targets[1].getBoundingClientRect().bottom<=viewport.bottom})()'),'preview and editable document share the same anchor rules');
    await click('文档'); await pointerClick('.bush-page-content a[href="#七中间件cors-与异常处理"]');
    writeFileSync(resolve('tmp/creation-markdown-navigation.png'),(await capture()).toPNG());
    await read(`window.fixtureWorkspace='D:/managed-worktree'; pages.selectCreationProject('D:/managed-project');`); await frame();
    await click('输入'); await until('creationInspector?.conversation.metadata?.ui_draft===true');
    const managedDraft = await read('creationInspector.sessionId');
    await read('creationInspector.send("在这个项目中创作")');
    await until(`pageState.sessions['D:/managed-project'] === ${JSON.stringify(managedDraft)}`);
    assert.equal(await read('creationInspector.sessionId'), managedDraft, 'execution directory changes must not remount the conversation');
    assert.equal(await read('creationInspector.root'), 'D:/managed-worktree');
    assert.equal(await read('creationSessionInput.projectDir'), 'D:/managed-project');
    await read(`window.fixtureWorkspace=null;pages.createBushItPage('# Single file', {path:'D:/managed-project/single.md',text:'# Single file',revision:'file'},'');`); await frame();
    await click('输入'); await until('creationInspector?.conversation.metadata?.ui_draft===true');
    assert.notEqual(await read('creationInspector.sessionId'), managedDraft, 'a file directory alone cannot inherit a project conversation');
    await read('creationInspector.send("编辑单独打开的文件")');
    assert.equal(await read('creationSessionInput.projectDir'), undefined, 'an unassigned document belongs to recents');
    assert.deepEqual(errors,[]);
    console.log('Native Team/Create UI passed: document/Team round trips, IME, live preview, heading/relative/external/reference links, duplicate/Unicode anchors, reference edits/undo, keyboard navigation, floating input, drafts, Save As, file conflicts and responsive layouts.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); if (errors.length) console.error(errors.join('\n')); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
