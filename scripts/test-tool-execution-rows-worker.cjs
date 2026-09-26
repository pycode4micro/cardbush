const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration(); app.setPath('userData', join(directory, 'profile'));
const pause = () => new Promise(resolve => setTimeout(resolve, 90));
app.whenReady().then(async () => {
  const window = new BrowserWindow({show:false,width:780,height:640,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  window.webContents.on('console-message', event => { if(event.level==='error')console.error('Renderer:',event.message); });
  const run = code => window.webContents.executeJavaScript(code);
  const until = async code => { const end=Date.now()+5000; while(!await run(code)){if(Date.now()>end)throw Error('Timed out: '+code+'; '+await run('JSON.stringify({body:document.body.innerText,requests:requests.length,executions})')); await pause();} };
  try {
    await window.loadFile(join(directory,'index.html'));
    const url = window.webContents.getURL(); let navigations=0;
    window.webContents.on('will-navigate',()=>navigations++);
    await until('Boolean(document.querySelector(".tool-execution-summary"))');
    for (const theme of ['theme-dark','theme-cyberpunk']) {
      await run(`theme=${JSON.stringify(theme)};renderFixture();`); await pause();
      if(await run('document.querySelector(".tool-execution-summary").getAttribute("aria-expanded")==="false"'))
        await run('document.querySelector(".tool-execution-summary").click()');
      await until('document.querySelectorAll(".tool-execution-row").length===3');
      assert.equal(await run('document.querySelectorAll(".tool-execution-output,.tool-output-actions").length'),0);
      assert.equal(await run('requests.length'),0,'opening a package cannot fetch hidden native results');
      assert.ok(await run('[...document.querySelectorAll(".tool-execution-row")].every(row=>row.offsetHeight<=32)'));
      assert.ok(await run('document.documentElement.scrollWidth<=innerWidth'));
      await pause(); writeFileSync(resolve('tmp/tool-rows-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());
      await run('document.querySelector("[data-execution-id=shell] .tool-execution-row").click()');
      await until('Boolean(document.querySelector(".tool-execution-output"))');
      assert.equal(await run('document.querySelector(".tool-execution-input")'),null,'identical tool-name summaries are not repeated');
      await pause(); writeFileSync(resolve('tmp/tool-rows-detail-'+theme+'.png'),(await window.webContents.capturePage()).toPNG());
      await run('document.querySelector("[data-execution-id=search] .tool-execution-row").click()'); await pause();
      assert.equal(await run('document.querySelectorAll(".tool-execution-row-content").length'),1);
      assert.ok(await run('document.querySelector(".tool-execution-output").textContent===executions[1].output'),'complete output, including Unicode and line endings, survives disclosure');
      await run('document.querySelector("[aria-label=复制输出]").click()'); await pause();
      assert.ok(await run('copied.at(-1)===executions[1].output'));
      await run('document.querySelector("[aria-label=换行]").click()'); await pause();
      assert.ok(await run('document.querySelector(".tool-execution-output").classList.contains("wrapped")'));
      await run('active=false; executions=executions.map(e=>e.id==="running"?{...e,state:"cancelled"}:e);renderFixture();'); await pause();
      assert.equal(await run('document.querySelectorAll(".tool-execution-row-content").length'),1,'completion cannot collapse the detail the user opened');
      await run('document.querySelector("[data-execution-id=search] .tool-execution-row").click()'); await pause();
    }
    await run('messageId="deferred";executions=[{...executions[0],id:"deferred",output:"",metadata:{nativeResultDeferred:true}}];renderFixture();'); await pause();
    await run('document.querySelector(".tool-execution-summary").click()'); await pause();
    assert.equal(await run('requests.length'),0);
    await run('document.querySelector(".tool-execution-row").click()');
    await until('requests.length===1');
    await run('requests[0].reject(Error("Fixture load failure"))');
    await until('document.body.textContent.includes("暂时无法读取执行详情")');
    assert.equal(await run('document.querySelector(".tool-execution-row-status").textContent'),'已执行','a detail-fetch error is not an execution failure');
    await run('document.querySelector(".tool-execution-detail-status button").click()');
    await until('requests.length===2');
    await run('document.querySelector(".tool-execution-row").click(); requests[1].resolve([{...executions[0],output:"Recovered output",metadata:{}}]);'); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-row-content")'),null,'a late result cannot reopen a closed row');
    await run('document.querySelector(".tool-execution-row").click()');
    await until('document.querySelector(".tool-execution-output")?.textContent==="Recovered output"');
    assert.equal(await run('requests.length'),2,'loaded facts are reused');
    await run('messageId="failure";executions=[{...executions[0],id:"failure",state:"failed",summary:"Permission denied",metadata:{error:{message:"Permission denied"}}}];renderFixture();'); await pause();
    await run('document.querySelector(".tool-execution-summary").click()'); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-row-status").textContent'),'失败');
    await run('document.querySelector(".tool-execution-row").click()'); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-error").textContent'),'Permission denied');
    assert.equal(await run('document.querySelector(".tool-execution-input")'),null,'the error message is not repeated as a command');
    await run('active=true;executions=[{...executions[0],state:"awaiting_permission",summary:"访问项目文件",metadata:{}}];renderFixture();'); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-row-status").textContent'),'等待授权');
    assert.ok(await run('document.querySelector(".tool-execution-row").classList.contains("waiting")'));
    for (const theme of ['theme-dark', 'theme-cyberpunk']) {
      for (const [id, name, result, label, failed, diagnostic] of [
        ['nonzero', 'terminal_exec', {state:'exited',exitCode:7,stdout:'partial result',stderr:'error'}, '退出码 7', true, false],
        ['diagnostic', 'terminal_exec', {state:'exited',exitCode:0,stdout:'recovered',stderr:'non-terminating error\r\n中文😀'}, '有诊断输出', false, true],
        ['warning', 'terminal_poll', {state:'running',exitCode:null,stdout:'',stderr:'download progress'}, '有诊断输出', false, true],
        ['normal', 'terminal_exec', {state:'exited',exitCode:0,stdout:'done',stderr:''}, '已执行', false, false],
        ['spawn-failure', 'terminal_exec', {state:'failed',exitCode:null,stdout:'',stderr:'',error:'Unable to start'}, '命令失败', true, false],
        ['unrelated', 'search_file_content', {exitCode:1,output:'No matches'}, '已执行', false, false],
      ]) {
        for (const nativeMetadata of [true, false]) {
          await run(`theme=${JSON.stringify(theme)};active=false;messageId=${JSON.stringify(id+theme+nativeMetadata)};
            executions=[{...executions[0],id:messageId,name:${JSON.stringify(name)},state:'completed',summary:'fixture command',
              output:${JSON.stringify(JSON.stringify(result))},metadata:${JSON.stringify(nativeMetadata ? {nativeResult:result} : {})}}];renderFixture();`);
          await pause();
          if(await run('document.querySelector(".tool-execution-summary").getAttribute("aria-expanded")==="false"'))
            await run('document.querySelector(".tool-execution-summary").click()');
          await until('Boolean(document.querySelector(".tool-execution-row"))');
          assert.equal(await run('document.querySelector(".tool-execution-row-status").textContent'),label);
          assert.equal(await run('document.querySelector(".tool-execution-row").classList.contains("failed")'),failed);
          assert.equal(await run('document.querySelector(".tool-execution-row").classList.contains("diagnostic")'),diagnostic);
          assert.equal(await run('document.querySelector(".tool-execution-summary").textContent.includes("执行失败")'),failed);
          assert.equal(await run('/\\d+\\s*(项操作|项失败|actions|tools)/i.test(document.querySelector(".tool-execution-summary").textContent)'),false);
          await run('document.querySelector(".tool-execution-row").click()'); await pause();
          assert.equal(await run('document.querySelector(".tool-execution-output").textContent'),JSON.stringify(result));
          if(diagnostic) assert.match(await run('document.querySelector(".tool-execution-diagnostic").textContent'),/即使退出码为 0/);
        }
      }
    }
    // Replay title-bearing lifecycle updates without replacing the disclosure DOM.
    await run(`active=true;messageId='stable-title';executions=[{...executions[0],id:'stable',name:'mcp_call',state:'queued',
      summary:'mcp_call',output:'',metadata:{displayTitle:'核对产品资料',nativeResultDeferred:true}}];renderFixture();`);
    await pause();
    await run(`window.titleNode=document.querySelector('.tool-execution-label');window.summaryNode=document.querySelector('.tool-execution-summary');
      window.labels=[];window.titleHeight=summaryNode.getBoundingClientRect().height;
      window.labelObserver=new MutationObserver(()=>labels.push(titleNode.textContent));
      labelObserver.observe(document.querySelector('.tool-execution-block'),{subtree:true,childList:true,characterData:true});`);
    for (const state of ['running','awaiting_permission','running','completed']) {
      await run(`executions=executions.map(e=>({...e,state:${JSON.stringify(state)},summary:'mcp_call'}));renderFixture();`); await pause();
      assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'核对产品资料');
      assert.ok(await run('titleNode===document.querySelector(".tool-execution-label") && summaryNode===document.querySelector(".tool-execution-summary")'));
      assert.equal(await run('summaryNode.getBoundingClientRect().height'),await run('titleHeight'));
    }
    if(await run('summaryNode.getAttribute("aria-expanded")==="false"')) await run('summaryNode.click()');
    await pause();
    await run('document.querySelector(".tool-execution-row").click()');
    await until('requests.length===3');
    // An old detail response has a stale title and state; it may enrich output only.
    await run(`requests[2].resolve([{...executions[0],state:'running',summary:'stale command',output:'Exact native result',metadata:{displayTitle:'旧的标题'}}]);`);
    await until('document.querySelector(".tool-execution-output")?.textContent==="Exact native result"');
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'核对产品资料');
    assert.equal(await run('document.querySelector(".tool-execution-status").textContent'),'已返回');
    assert.equal(await run('document.querySelector(".tool-execution-row-status").textContent'),'已执行');
    assert.ok(await run('labels.every(label=>label==="核对产品资料")'),'no fallback frame while lifecycle or details change');
    await run('labelObserver.disconnect()');
    await run(`fixtureSession='other-session';executions=executions.map(e=>({...e,metadata:{nativeResultDeferred:true}}));renderFixture();`); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'调用插件','same call ID in another session cannot inherit a hydrated title');
    assert.equal(await run('document.body.textContent.includes("Exact native result")'),false,'session switching cannot expose stale details');
    // Keep a parallel title while another call starts/finishes, then advance once.
    await run(`messageId='parallel-title';executions=[{...executions[0],id:'first',state:'running',metadata:{displayTitle:'读取产品资料'}},
      {...executions[0],id:'second',state:'queued',metadata:{displayTitle:'核对部门制度'}}];renderFixture();`); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'读取产品资料');
    await run(`executions=executions.map(e=>e.id==='second'?{...e,state:'running'}:e);renderFixture();`); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'读取产品资料');
    await run(`executions=executions.map(e=>e.id==='first'?{...e,state:'completed'}:e);renderFixture();`); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'核对部门制度');
    await run(`executions=executions.map(e=>({...e,state:'completed'}));renderFixture();`); await pause();
    assert.equal(await run('document.querySelector(".tool-execution-label").textContent'),'核对部门制度');
    // Narrow layouts retain a single line and fixed-size icons even for long titles.
    await run(`executions=executions.map(e=>({...e,metadata:{displayTitle:'核对'.repeat(80)}}));document.querySelector('.message-list').style.width='220px';renderFixture();`); await pause();
    assert.ok(await run('document.querySelector(".tool-execution-summary").getBoundingClientRect().width<=220'));
    assert.equal(await run('document.querySelector(".tool-execution-summary").getBoundingClientRect().height'),await run('titleHeight'));
    assert.ok(await run('[...document.querySelectorAll(".tool-execution-summary svg")].every(svg=>svg.getBoundingClientRect().width>=15)'));
    assert.equal(window.webContents.getURL(),url); assert.equal(navigations,0);
    console.log('Tool rows UI passed: both themes, compact rows, one detail, exact output/copy, wrap, completion, lazy hydration, retry, late results, zero navigation.');
  } finally { window.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
