const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, win, root, liveDesktop = false }) => {
  if (liveDesktop) await run(`
    window.desktopToken=null;window.desktopCalls=[];
    var desktopConnect=cardbushDesktop.agents.connect;
    cardbushDesktop.agents.connect=async id=>{var info=await desktopConnect(id);if(id==='a'){var real=await remoteDesktopTest.info();info.capabilities={...info.capabilities,...real.capabilities};}return info;};
    var desktopCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(!operation.startsWith('desktop.'))return desktopCall(id,operation,input);
      desktopCalls.push({id,operation,input});
      var result=await remoteDesktopTest.call(operation,input);
      if(operation==='desktop.take')desktopToken=result.token;
      if(operation==='desktop.release')desktopToken=null;
      return result;
    };
    [...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click();undefined;
  `);
  else {
  await run(`
    // A deterministic remote screen; no real desktop or browser state is read.
    var canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;
    var ctx=canvas.getContext('2d');ctx.fillStyle='#213044';ctx.fillRect(0,0,1600,900);
    ctx.fillStyle='#e8edf4';ctx.fillRect(160,100,1280,680);ctx.fillStyle='#182434';ctx.font='32px sans-serif';ctx.fillText('Linux Personal Agent · fixture',220,175);
    ctx.fillStyle='#668cc4';ctx.fillRect(220,250,500,70);ctx.fillStyle='white';ctx.fillText('Browser and desktop share one session',220,440);
    window.desktopImage=canvas.toDataURL('image/jpeg').split(',')[1];
    window.desktopToken=null;window.desktopFrame=0;window.desktopCalls=[];
    var desktopConnect=cardbushDesktop.agents.connect;
    cardbushDesktop.agents.connect=async id=>{var info=await desktopConnect(id);info.capabilities.desktop=id==='a';return info};
    var desktopCall=cardbushDesktop.agents.call;
    cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(!operation.startsWith('desktop.'))return desktopCall(id,operation,input);
      desktopCalls.push({id,operation,input});
      var status={available:true,control:desktopToken?'user':'agent',leaseExpiresAt:desktopToken?Date.now()+20000:null};
      if(operation==='desktop.frame')return {...status,frameId:'frame-'+(++desktopFrame),width:1600,height:900,capturedAt:Date.now(),mimeType:'image/jpeg',data:desktopImage};
      if(operation==='desktop.take'){desktopToken='owned-fixture';return {...status,control:'user',token:desktopToken};}
      if(operation==='desktop.release'){assertLease(input.token);desktopToken=null;return {...status,control:'agent'};}
      if(operation==='desktop.input'){assertLease(input.token);return status;}
      throw Error('Unexpected desktop operation');
    };
    function assertLease(token){if(token!==desktopToken)throw Error('wrong lease');}
    [...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click();undefined;
  `);
  }
  await until("!!document.querySelector('.agent-header-actions')", 'headless Agent loaded');
  assert.equal(await run("!!document.querySelector('[aria-label=\"查看电脑\"]')"), false);
  await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click();undefined;");
  await until("!!document.querySelector('[aria-label=\"查看电脑\"]')", 'optional capability exposes view computer');
  assert.equal(await run('desktopCalls.length'), 0, 'no frames before opening preview');
  await run("document.querySelector('[aria-label=\"查看电脑\"]').click();undefined;");
  await until("document.querySelector('.agent-desktop-screen img')?.naturalWidth===1600", 'remote screen renders through shared inspector', 8000);
  await run("document.querySelector('.agent-desktop-view footer button').click();undefined;");
  await until("document.querySelector('.agent-desktop-view footer')?.textContent.includes('交还 Agent')", 'server lease acknowledged', 8000);
  await pause(liveDesktop ? 1000 : 0);
  const rect = await run("(()=>{let r=document.querySelector('.agent-desktop-screen img').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
  await until("desktopCalls.some(c=>c.operation==='desktop.input')", 'native pointer mapped to remote pixels');
  const click = await run("desktopCalls.find(c=>c.operation==='desktop.input')");
  assert.equal(click.id, 'a');
  assert.ok(Math.abs(click.input.event.x - 800) < 5 && Math.abs(click.input.event.y - 450) < 5);
  if (liveDesktop) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
    await until("desktopCalls.some(c=>c.input?.event?.key==='ctrl+a')", 'native keyboard reaches remote desktop');
  }
  await run("var field=document.querySelector('.agent-desktop-text input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'跨屏输入测试');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
  await pause(30);
  await run("document.querySelector('.agent-desktop-text button').click();undefined;");
  await until("desktopCalls.some(c=>c.input?.event?.text==='跨屏输入测试')", 'Unicode text routed to remote desktop');
  await pause(100);
  await until("!document.querySelector('.agent-desktop-text input')?.value", 'input acknowledged', 8000);
  assert.equal(await run("document.querySelector('.agent-desktop-view [role=alert]')?.textContent||''"), '');
  if (liveDesktop) await pause(1200); // Include the next real frame after the acknowledged input.
  fs.writeFileSync(path.join(root, liveDesktop ? 'tmp/agent-desktop-ui-live.png' : 'tmp/agent-desktop-ui.png'), (await win.webContents.capturePage()).toPNG());
  await run("document.querySelector('[aria-label=\"关闭审查\"]').click();undefined;");
  await until("desktopToken===null&&!document.querySelector('.agent-desktop-view')", 'closing preview releases control', 8000);
  const frames = await run('desktopCalls.length');
  await pause(1100);
  assert.equal(await run('desktopCalls.length'), frames, 'hidden preview stops all desktop requests');
  assert.equal(await run("calls.some(c=>c.operation==='chat.stop'||c.operation==='local-runtime')"), false, 'preview does not touch tasks or the local Runtime');
  console.log(`Agent desktop UI passed (${liveDesktop ? 'real Linux over authenticated SSH tunnel' : 'mock'}): opt-in entry, shared inspector, pixel mapping, control lease, Unicode input and preview cleanup.`);
};
