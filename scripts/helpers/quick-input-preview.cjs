const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const size = window.getSize();
  const theme = await run('document.querySelector(".app").className');
  await run(`coverUpdate({sending:true,activeTurnId:'cover-turn',messages:[
    {id:'preview-user',role:'user',content:'查看执行情况',turnId:'cover-turn'},
    {id:'preview-running',role:'assistant',content:'正在检查预览执行。',turnId:'cover-turn',toolExecutions:Array.from({length:6},(_,index)=>({
      id:'preview-tool-'+index,name:'terminal_exec',state:'completed',success:true,output:'Preview tool result',summary:'检查预览执行',
      durationMs:10,metadata:{},turnId:'cover-turn',createdAt:new Date().toISOString(),contentOffset:11,contentOffsetExplicit:true,
    }))}
  ]});`);
  await until('!!document.querySelector(".quick-input-transcript .tool-execution-summary")', 'preview renders the shared live execution group');
  await run('document.querySelector(".quick-input-transcript .tool-execution-summary").click()');
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("检查预览执行") && !!document.querySelector(".quick-input-transcript .tool-execution-row")', 'execution details can expand inside the preview');
  await run('coverUpdate({sending:false,activeTurnId:""});void 0');
  await run(`
    window.previewAnswer={id:'answer',role:'assistant',content:'检查完成，这是本次回复。',status:'completed',turnId:'cover-turn',createdAt:new Date().toISOString()};
    window.previewLong=Array.from({length:45},(_,index)=>'第 '+(index+1)+' 项：这是可滚动查看的执行结果。').join('\\n\\n');
    window.previewUpdate=(suffix='')=>coverUpdate({messages:[{...previewAnswer,content:previewLong+suffix}]});
    previewUpdate();
  `);
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("第 45 项")', 'long reply streams into preview');
  const pinned = '(()=>{const p=document.querySelector(".quick-input-transcript");return p.scrollHeight-p.scrollTop-p.clientHeight<4})()';
  await until(pinned, 'preview follows reply growth at the bottom');
  await run('document.querySelector(".quick-input-transcript").scrollTop=0;void 0'); await pause(80);
  await run('previewUpdate("\\n\\n新增回复，不应抢走正在阅读的位置。");void 0');
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("新增回复")', 'reply updates while reading history');
  assert.ok(await run('document.querySelector(".quick-input-transcript").scrollTop<4'), 'new output does not pull the user away from older content');
  await run('(()=>{const p=document.querySelector(".quick-input-transcript");p.scrollTop=p.scrollHeight;})();'); await pause(80);
  await run('previewUpdate("\\n\\n回到底部后继续跟随。");void 0');
  await until(pinned, 'scrolling back to the bottom resumes following');
  await run('coverUpdate({draft:"第一行\\n第二行\\n第三行\\n第四行"});void 0');
  await until('document.querySelector(".inspector-quick-input textarea").getBoundingClientRect().height>60', 'multiline input grows naturally');
  await run('coverUpdate({draft:""});void 0');
  await until('document.querySelector(".inspector-quick-input textarea").getBoundingClientRect().height<40', 'clearing multiline text restores compact height');
  for (const [width, height, zoom, mode] of [[1200,800,1,'bright'],[640,680,1.25,'dark']]) {
    window.setSize(width,height); window.webContents.setZoomFactor(zoom);
    await run(`document.querySelector('.app').className='app theme-${mode}'`); await pause(200);
    const geometry = await run(`(()=>{const card=document.querySelector('.inspector-quick-input'),p=card.getBoundingClientRect(),t=card.querySelector('.quick-input-transcript'),button=card.querySelector('.send-button'),b=button.getBoundingClientRect();
      return {left:p.left,right:p.right,top:p.top,bottom:p.bottom,width:innerWidth,height:innerHeight,scrollable:t.scrollHeight>t.clientHeight,hit:button.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))};})()`);
    assert.ok(geometry.top>46 && geometry.bottom<geometry.height && geometry.left>=0 && geometry.right<=geometry.width, 'expanded preview stays inside the viewport');
    assert.ok(geometry.scrollable && geometry.hit, 'long content scrolls while the composer remains reachable');
    fs.writeFileSync(path.join(root,'tmp',`quick-input-preview-${mode}.png`),(await window.webContents.capturePage()).toPNG());
  }
  window.webContents.setZoomFactor(1); window.setSize(...size);
  await run(`document.querySelector('.app').className=${JSON.stringify(theme)};coverUpdate({messages:[previewAnswer]});`);
  await until('document.querySelector(".quick-input-transcript")?.textContent.includes("检查完成，这是本次回复。")', 'restore compact response');
  console.log('Quick input preview passed: local expansion, live execution/replies, scroll follow/reading, multiline input, narrow and zoomed themes.');
};
