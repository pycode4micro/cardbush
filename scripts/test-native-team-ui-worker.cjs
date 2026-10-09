const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Native Team UI timed out'); app.exit(1); }, 55000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const read = script => win.webContents.executeJavaScript(script);
  const frame = () => read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const until = async script => {
    const end = Date.now() + 4000;
    while (!(await read(script))) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '; ' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const click = async text => { await read(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`); await frame(); };
  const fill = async (name, value, scope = '.native-team-editor') => {
    await read(`(()=>{ const label=[...document.querySelectorAll(${JSON.stringify(scope + ' label')})].find(label=>label.firstChild.textContent.trim()===${JSON.stringify(name)});
      const input=label.querySelector('input,textarea,select'); const prototype=input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`); await frame();
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until('!!document.querySelector(".team-graph-workspace") && !teamState.loading');
    await click('员工');
    await click('注册员工'); await fill('名称', '库存员'); await fill('ID', 'warehouse');
    await fill('岗位指令', '核对库存记录，返回数量和依据。');
    await click('保存员工'); await until('records.agents.length===1 && teamState.agents.length===1');
    assert.equal(await read('records.agents[0].definition.memory'), 'user');
    await fill('职责说明', '正在保存的内容'); await read('window.deferSave=true'); await click('保存员工');
    await until('typeof window.finishSave==="function"'); await fill('职责说明', '保存期间继续编辑的内容');
    await read('window.deferSave=false; window.finishSave()'); await until('records.agents[0].revision===2');
    assert.equal(await read('records.agents[0].definition.description'), '正在保存的内容');
    assert.equal(await read('document.querySelectorAll(".native-team-editor textarea")[0].value'), '保存期间继续编辑的内容');
    await read('records.agents[0].revision=8');
    await fill('名称', '未保存修改'); await click('保存员工');
    await until('document.querySelector("[role=alert]")?.textContent.includes("配置已在别处修改")');
    assert.equal(await read('records.agents[0].definition.name'), '库存员');
    await click('团队流程'); await click('新建流程'); await fill('名称', '订单核验', '.md-node-editor'); await fill('ID', 'order-review', '.md-node-editor');
    for (const [index, task] of ['核对库存数量', '根据库存结果核对订单'].entries()) {
      await click('添加节点'); const scope = '.md-node-editor';
      await fill('节点名称', index===0?'库存核验':'订单汇总', scope);
      await fill('员工', 'warehouse', scope); await fill('任务内容', task, scope);
    }
    await read('document.querySelector(".md-node-editor input[type=checkbox]").click()'); await frame();
    assert.equal(await read('document.querySelectorAll("[data-edge]").length'),1);
    await read('document.querySelector(".md-node-editor input[type=checkbox]").click()'); await frame();
    await read('document.querySelector(".md-node-out").click()');await frame();
    await read('document.querySelectorAll(".md-node-face")[1].click()');await frame();
    assert.equal(await read('document.querySelectorAll("[data-edge]").length'),1,'ports create a dependency using the shared graph');
    await click('保存流程'); await until('records.teams.length===1 && teamState.teams.length===1');
    assert.equal(await read('records.teams[0].definition.nodes[1].depends_on[0]'), await read('records.teams[0].definition.nodes[0].id'));
    await click('选为对话团队'); assert.equal(await read('teamState.selectedId'), 'order-review');
    await read('document.querySelector(".md-node-face").click()'); await frame();
    await read('document.querySelector(".md-node-editor input[type=checkbox]").click()'); await frame(); await click('保存流程');
    await until('document.querySelector("[role=alert]")?.textContent.includes("节点依赖存在循环")');
    assert.equal(await read('records.teams[0].revision'), 1, 'invalid cycles never reach persistence');
    await read('document.querySelector(".md-node-editor input[type=checkbox]").click()'); await frame();
    const firstId=await read('records.teams[0].definition.nodes[0].id');
    await read(`document.querySelector('[data-node-id="${firstId}"] .md-node-face').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}))`); await frame();
    await click('保存流程'); await until('records.teams[0].revision===2');
    assert.ok(await read('Number.isFinite(records.teams[0].definition.nodes[0].position.x)'), 'graph movement persists with workflow');
    await click('Markdown');
    assert.ok(await read('document.querySelector(".md-source").value.includes("[[#")'), 'graph dependencies are readable Markdown');
    await read(`(()=>{const el=document.querySelector('.md-source');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,el.value.replace('name: 订单核验','name: 人工编辑流程'));el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await frame();
    await click('保存流程'); await until('records.teams[0].revision===3');assert.equal(await read('records.teams[0].definition.name'),'人工编辑流程');
    await click('图谱');await click('保存 .md');await until('fileCalls.some(call=>call.action==="save")');
    assert.ok(await read('fileCalls.find(call=>call.action==="save").text.includes("md-node")'));
    await click('重新载入文件'); await frame(); assert.equal(await read('document.querySelectorAll(".md-graph-node").length'),2,'cancelling a file picker leaves graph intact');
    // Preserve text typed after a save was submitted and enforce revision conflicts.
    await fill('任务内容','保存中的任务','.md-node-editor');await read('window.deferSave=true');await click('保存流程');await until('typeof window.finishSave==="function"');
    await fill('任务内容','保存期间继续修改','.md-node-editor');await read('window.deferSave=false;window.finishSave()');await until('records.teams[0].revision===4');
    assert.equal(await read('document.querySelector(".md-node-editor textarea").value'),'保存期间继续修改');
    await click('保存流程');await until('records.teams[0].revision===5');
    // A real pointer drag changes the graph position, without losing the node selection.
    const beforeDrag = await read('records.teams[0].definition.nodes[0].position');
    const point = await read(`(()=>{const r=document.querySelector('.md-node-face').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseMove',x:point.x+36,y:point.y+28});await frame();
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+36,y:point.y+28});await frame();
    await click('保存流程');await until('records.teams[0].revision===6');
    assert.notDeepEqual(await read('records.teams[0].definition.nodes[0].position'),beforeDrag,'pointer dragging changes persisted position');
    for (const theme of ['dark', 'light']) {
      await read(`document.querySelector('.app').className='app theme-${theme}'`); await frame();
      assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true);
      writeFileSync(resolve(`tmp/native-team-workspace-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    }
    win.setSize(720, 1000); await frame();
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'), true, 'narrow editor fits the panel');
    await read("window.setApp('md')");await frame();await until('!!document.querySelector(".md-app")');
    assert.equal(await read('document.querySelectorAll(".md-graph-node").length'),3,'standalone md app reuses the graph renderer');
    await click('Markdown'); await read("(()=>{const el=document.querySelector('.md-source');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'---\\nname: broken');el.dispatchEvent(new Event('input',{bubbles:true}));})()");await frame();
    assert.ok(await read('document.querySelector("[role=alert]").textContent.includes("Unclosed")'));
    assert.equal(await read('document.querySelector(".md-source").value'),'---\nname: broken','invalid input remains editable without replacing it with stale graph data');
    console.log('Native Team/md UI passed: registration, graph links, dragging, Markdown editing, save races, cycles, files, standalone app, light/dark and narrow layouts.');
    clearTimeout(deadline); win.destroy(); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); win.destroy(); app.exit(1); }
});
