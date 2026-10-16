const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, click, edit, choose, window: win, root }) => {
  await run(`
    window.mcpConfigs = [{id:'fixture',name:'Fixture server',transport:'stdio',command:'node',args:['fixture.mjs'],enabled:true,raw:{}}];
    window.mcpSaveCalls=[]; window.mcpSaveFails=false; window.mcpSaveSlow=false;
    const host = {...views.localSettingsHost,
      fetchMcpServers:async()=>({servers:structuredClone(mcpConfigs)}),
      saveMcpServerConfig:async input=>{
        mcpSaveCalls.push(structuredClone(input));
        if(mcpSaveSlow)await new Promise(resolve=>window.finishMcpSave=resolve);
        if(mcpSaveFails)throw Error('fixture save unavailable');
        const saved={...structuredClone(input),raw:{}};mcpConfigs=[...mcpConfigs.filter(server=>server.id!==input.id),saved];return saved;
      },
    };
    reactRoot.render(h('div',{className:'app theme-dark',style:{width:'100vw',height:'100vh',minWidth:0}},
      h('section',{className:'settings-content',style:{padding:24}},h(views.SettingsHostContext.Provider,{value:host},
        h(views.McpServersPanel,{language:'zh',capabilities:{mcpServers:true},onNotify:()=>{}})))));
  `);
  await until("document.querySelectorAll('.mcp-simple-row').length === 1");
  assert.equal(await run("!!document.querySelector('dialog')"), false, 'editor is not shown by default');
  await run("window.listTop=document.querySelector('.mcp-simple-list').getBoundingClientRect().top;document.querySelector('.mcp-add-button').focus();document.querySelector('.mcp-add-button').click()");
  await until("document.querySelector('.mcp-server-dialog')?.matches(':modal')");
  assert.equal(await run("document.querySelector('.mcp-simple-list').getBoundingClientRect().top"), await run('listTop'), 'opening the dialog does not move the list');
  assert.equal(await run("document.querySelector('.mcp-advanced').open"), false);
  await edit('dialog input[aria-label="名称"]', 'New fixture');
  await edit('dialog input[aria-label="启动命令"]', 'node fixture.mjs');
  await click('校验');
  await until("document.querySelector('dialog .subagent-validation')?.textContent.includes('校验通过')");
  await choose('dialog [aria-label="连接方式"]', 'streamable_http');
  assert.equal(await run("!!document.querySelector('dialog .subagent-validation')"), false, 'changing configuration clears stale validation');
  await edit('dialog input[aria-label="URL"]', 'https://fixture.invalid/mcp');
  await choose('dialog [aria-label="连接方式"]', 'stdio');
  assert.equal(await run("document.querySelector('dialog input[aria-label=启动命令]').value"), 'node fixture.mjs');
  await run("document.querySelector('.mcp-advanced').open=true");
  for (const [width,height,theme] of [[1200,850,'dark'],[500,600,'bright']]) {
    win.setSize(width,height);
    await until(`window.innerWidth === ${width}`);
    await run(`document.querySelector('.app').className='app theme-${theme}';document.querySelector('.settings-dialog-body').scrollTop=9999`);
    const area = await run(`(()=>{const dialog=document.querySelector('dialog'),body=dialog.querySelector('.settings-dialog-body').getBoundingClientRect(),footer=dialog.querySelector('footer').getBoundingClientRect(),r=dialog.getBoundingClientRect();return{fits:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,scrolls:dialog.scrollWidth<=dialog.clientWidth,footer:body.bottom<=footer.top+1&&footer.bottom<=r.bottom,hit:document.elementFromPoint(footer.right-60,footer.top+30)?.closest('footer')!==null}})()`);
    assert.deepEqual(area, {fits:true,scrolls:true,footer:true,hit:true});
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(root,`tmp/mcp-server-dialog-${theme}.png`),(await win.webContents.capturePage()).toPNG());
  }
  await run("mcpSaveFails=true;mcpSaveSlow=true;document.querySelector('dialog form').requestSubmit();document.querySelector('dialog form').requestSubmit()");
  await until("document.querySelector('dialog').getAttribute('aria-busy')==='true' && mcpSaveCalls.length===1");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await run('new Promise(resolve=>setTimeout(resolve,60))');
  assert.equal(await run("document.querySelector('dialog').matches(':modal')"),true,'saving cannot be dismissed');
  await run('finishMcpSave()');
  await until("document.querySelector('dialog [role=alert]')?.textContent.includes('fixture save unavailable')");
  assert.equal(await run("document.querySelector('dialog input[aria-label=名称]').value"),'New fixture','failure retains draft');
  await run('mcpSaveFails=false;mcpSaveSlow=false');
  await click('保存');
  await until("!document.querySelector('dialog') && document.querySelectorAll('.mcp-simple-row').length===2");
  assert.equal(await run('mcpSaveCalls.length'),2,'one request per submission');
  assert.equal(await run("document.activeElement===document.querySelector('.mcp-add-button')"),true,'save returns focus to opener');
  await run("document.querySelector('.mcp-simple-row button[title=配置]').focus();document.querySelector('.mcp-simple-row button[title=配置]').click()");
  await until("document.querySelector('dialog input[aria-label=名称]')?.value==='Fixture server'");
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
  await until("!document.querySelector('dialog')");
  assert.equal(await run("document.activeElement===document.querySelector('.mcp-simple-row button[title=配置]')"),true);
  console.log('MCP dialog passed: stable list, edit/create, progressive fields, validation, responsive footer, save failure/retry, duplicate-submit guard and focus restoration.');
};
