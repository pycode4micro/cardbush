const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixedBacking = process.platform === 'win32';
module.exports = async ({current, read, click, visible, wait, project, holdAudioSettings}) => {
  const edit = '.floating-capsule [data-action=compose]', bell='.floating-capsule [data-action=replies]';
  assert.ok(await read("document.querySelector('.floating-capsule').offsetWidth < 200 && document.querySelector('.floating-capsule').offsetHeight < 100"), 'the visible toolbar fits the pill');
  assert.deepEqual(await read("Array.from(document.querySelectorAll('.floating-capsule button'), b => b.dataset.action)"), ['compose','voice','replies']);
  const image = await current.webContents.capturePage();
  const {width,height} = image.getSize(1);
  const pixels = image.toBitmap({scaleFactor:1});
  assert.equal(pixels[3], 0, 'the native renderer keeps the area outside the capsule transparent');
  if (process.platform === 'win32') {
    // capturePage contains Chromium's alpha BEFORE the native window clips the desktop.
    // Every visibly painted span, including antialiasing/shadow, must fit the native region.
    const edges = [];
    for (let y=0; y<height; y++) {
      let first=width, last=-1;
      for (let x=0; x<width; x++) if (pixels[(width*y+x)*4+3]>=8) { first=Math.min(first,x); last=x; }
      if (last>=0) edges.push(first,y,last,y);
    }
    assert.ok(edges.length>0);
    const handle = current.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE();
    const probe = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CapsuleWindowRegion {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32")] public static extern int GetWindowRgn(IntPtr window, IntPtr region);
  [DllImport("user32")] public static extern bool GetClientRect(IntPtr window, out Rect bounds);
  [DllImport("user32")] public static extern bool SetProcessDPIAware();
  [DllImport("gdi32")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32")] public static extern int GetRgnBox(IntPtr region, out Rect bounds);
  [DllImport("gdi32")] public static extern bool PtInRegion(IntPtr region, int x, int y);
  [DllImport("gdi32")] public static extern bool DeleteObject(IntPtr region);
}
'@
[void][CapsuleWindowRegion]::SetProcessDPIAware()
$region = [CapsuleWindowRegion]::CreateRectRgn(0,0,1,1)
try {
  if ([CapsuleWindowRegion]::GetWindowRgn([IntPtr]::new([long]${hwnd}),$region) -le 1) { exit 1 }
  $box = New-Object CapsuleWindowRegion+Rect
  [void][CapsuleWindowRegion]::GetRgnBox($region,[ref]$box)
  if ([CapsuleWindowRegion]::PtInRegion($region,$box.Left,$box.Top)) { exit 2 }
  if (![CapsuleWindowRegion]::PtInRegion($region,($box.Left+$box.Right)/2,($box.Top+$box.Bottom)/2)) { exit 3 }
  $client = New-Object CapsuleWindowRegion+Rect
  [void][CapsuleWindowRegion]::GetClientRect([IntPtr]::new([long]${hwnd}),[ref]$client)
  if ($box.Left -lt $client.Right/2 -or $box.Top -lt $client.Bottom/2) { exit 5 }
  $edges = @(${edges.join(',')})
  for ($i=0;$i -lt $edges.Length;$i+=2) {
    $x = [Math]::Floor(($edges[$i]+0.5)*$client.Right/${width})
    $y = [Math]::Floor(($edges[$i+1]+0.5)*$client.Bottom/${height})
    if (![CapsuleWindowRegion]::PtInRegion($region,$x,$y)) { exit 4 }
  }
} finally { [void][CapsuleWindowRegion]::DeleteObject($region) }`;
    const result = require('node:child_process').spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',probe], {windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,'native capsule keeps click-through corners without clipping blended edge pixels: '+result.stderr);
  }
  assert.ok(await read("!document.querySelector('.assistant-messages')"));
  fs.writeFileSync(path.join(project,'tmp','floating-capsule.png'),(await current.webContents.capturePage()).toPNG());
  await wait(()=>current.isVisible(),'native capsule is visible for pointer input');
  current.focus(); current.webContents.focus();
  const pointer = event => {
    const bounds = current.getContentBounds();
    current.webContents.sendInputEvent({...event, globalX:bounds.x+event.x, globalY:bounds.y+event.y});
  };
  const start=current.getBounds();
  const area = require('electron').screen.getPrimaryDisplay().workArea;
  const right = bounds => bounds.x + bounds.width;
  const bottom = bounds => bounds.y + bounds.height;
  assert.ok(right(area) - right(start) >= 0 && right(area) - right(start) <= 24 &&
    bottom(area) - bottom(start) >= 0 && bottom(area) - bottom(start) <= 24, 'opens in the bottom right of the usable desktop');
  const button=await read("(()=>{const r=document.querySelector('[data-action=compose]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  pointer({type:'mouseMove',...button});
  pointer({type:'mouseDown',button:'left',clickCount:1,...button});
  pointer({type:'mouseMove',modifiers:['leftButtonDown'],x:button.x-16,y:button.y-4});
  await wait(()=>Math.abs(current.getBounds().x-start.x)>=10, 'dragging moves the native capsule');
  pointer({type:'mouseUp',button:'left',clickCount:1,...button});
  assert.equal(await read("!!document.querySelector('.capsule-form')"),false,'dragging does not activate the underlying button');
  const dragged = current.getBounds();
  await read("window.capsuleAnimations=[];document.addEventListener('animationstart',e=>capsuleAnimations.push(e.animationName));void 0");
  await click(edit); await visible('.capsule-form input');
  if (await read("matchMedia('(prefers-reduced-motion: no-preference)').matches"))
    await wait(()=>read("capsuleAnimations.includes('capsule-open') && capsuleAnimations.includes('capsule-reveal')"),'opening the editor animates');
  current.webContents.debugger.attach('1.3');
  try {
    await current.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    assert.ok(await read("['.floating-capsule','.capsule-form'].every(s=>getComputedStyle(document.querySelector(s)).animationName==='none')"), 'reduced motion opens the same editor without animating');
  } finally { current.webContents.debugger.detach(); }
  await wait(()=>read("document.activeElement.matches('.capsule-form input')"),'editor takes keyboard focus');
  assert.ok(await read("document.querySelector('.floating-capsule').offsetWidth >= 300 && document.querySelector('.floating-capsule').offsetHeight < 100"),'compose expands horizontally');
  assert.equal(right(current.getBounds()),right(dragged),'the editor expands left from the dragged anchor');
  assert.equal(bottom(current.getBounds()),bottom(dragged));
  assert.equal(await read("!!document.querySelector('[data-action=workspace]')"),false,'the expanded editor only has editing controls');
  fs.writeFileSync(path.join(project,'tmp','floating-capsule-editor.png'),(await current.webContents.capturePage()).toPNG());
  const type = value=>read(`(() => {const n=document.querySelector('.capsule-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await type('Unsent capsule draft');
  const origin=current.getBounds();
  const attachPoint=await read("(()=>{const r=document.querySelector('.capsule-attach').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  const {dialog}=require('electron'); const picker=dialog.showOpenDialog;
  let picks=0;
  try {
    dialog.showOpenDialog=async()=>{picks++;return {canceled:true,filePaths:[]};};
    pointer({type:'mouseDown',button:'left',clickCount:1,...attachPoint});
    pointer({type:'mouseMove',modifiers:['leftButtonDown'],x:attachPoint.x-18,y:attachPoint.y-4});
    await wait(()=>Math.abs(current.getBounds().x-origin.x)>=10,'the expanded editor can be dragged');
    pointer({type:'mouseUp',button:'left',clickCount:1,...attachPoint});
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(picks,0,'dragging the attachment button does not open the picker');
  } finally {dialog.showOpenDialog=picker;}

  const escape=()=>read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await escape(); await visible(bell); await click(edit); await visible('.capsule-form input');
  assert.equal(await read("document.querySelector('.capsule-form input').value"),'Unsent capsule draft');
  await type(''); await escape(); await visible(bell);
  await checkDelivery({ current, read, click, visible, wait, type, edit, bell, holdAudioSettings });

};

async function checkDelivery({ current, read, click, visible, wait, type, edit, bell, holdAudioSettings }) {
  const http = require('node:http');
  const {dialog, app} = require('electron');
  let release;
  const gate = new Promise(resolve=>{release=resolve;});
  const reply = 'Capsule reply received';
  const server = http.createServer(async (req,res)=>{
    for await (const _chunk of req) { /* consume the complete real provider request */ }
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200,{'content-type':'application/json'}).end('{"input_tokens":80}'); return; }
    await gate;
    res.writeHead(200,{'content-type':'text/event-stream'});
    const emit = value => res.write('data: '+JSON.stringify(value)+'\n\n');
    const response={id:'capsule-response',object:'response',status:'in_progress',model:'fixture',output:[]};
    const item={id:'capsule-reply',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:reply,annotations:[]}]};
    emit({type:'response.created',response});
    emit({type:'response.output_item.added',output_index:0,item:{...item,content:[]}});
    emit({type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:reply});
    emit({type:'response.output_item.done',output_index:0,item});
    emit({type:'response.completed',response:{...response,status:'completed',output:[item],usage:{input_tokens:80,output_tokens:4,total_tokens:84}}});
    res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const picker=dialog.showOpenDialog, file=path.join(app.getPath('userData'),'capsule-fixture.txt');
  try {
    const config={defaultModelId:'fixture',models:[{id:'fixture',provider:'openai',model:'fixture',apiKey:'fixture',baseURL:'http://127.0.0.1:'+server.address().port+'/v1'}]};
    const workspace = require('electron').BrowserWindow.getAllWindows().find(win => win !== current && !win.webContents.getURL().includes('window=assistant'));
    assert.ok((await workspace.webContents.executeJavaScript(`window.cardbushDesktop.productHostCommand({protocol:'cardbush.product_host_ipc.v1',kind:'models.update',config:${JSON.stringify(config)}})`)).ok);
    await read("localStorage.setItem('cardbush_theme_mode','light')");
    // Simulate a throttled resident renderer so that opening the bell must do its own journal read.
    current.webContents.debugger.attach('1.3');
    try {
      await current.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {source: `
        const interval = window.setInterval.bind(window);
        window.setInterval = (fn, delay, ...args) => delay === 1000 && typeof fn === 'function'
          ? interval(() => { if (!window.holdJournalPoll) fn(...args); }, delay) : interval(fn, delay, ...args);
      `});
      await new Promise(resolve=>{current.webContents.once('did-finish-load',resolve);current.webContents.reload();});
    } finally { current.webContents.debugger.detach(); }
    await visible(edit); await click(edit); await visible('.capsule-form input');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-editor-light.png'),(await current.webContents.capturePage()).toPNG());
    fs.writeFileSync(file,'Isolated capsule attachment');
    dialog.showOpenDialog=async owner=>{
      assert.equal(owner,current);
      owner.emit('blur');
      return {canceled:false,filePaths:[file]};
    };
    await click('.capsule-attach'); await visible('.capsule-files');
    await type('Capsule attachment test');
    current.focus(); await wait(()=>current.isFocused(),'editor has native focus');
    workspace.focus(); await visible(bell);
    assert.equal(await read("!!document.querySelector('.capsule-form')"),false,'outside focus collapses the editor');
    current.focus(); await click(edit); await visible('.capsule-files');
    assert.equal(await read("document.querySelector('.capsule-form input').value"),'Capsule attachment test');
    await wait(()=>read("!document.querySelector('.capsule-send').disabled"),'model and input ready');
    await read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
    assert.ok(await read("!!document.querySelector('.capsule-form')"), 'committing an IME candidate does not send');
    await read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await visible(bell);
    assert.ok(await read("document.querySelector('.floating-capsule').offsetWidth < 200"), 'acceptance collapses before the reply arrives');
    release();
    await wait(()=>read("document.querySelector('.capsule-badge')?.textContent==='1'"),'one real unread reply');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-unread.png'),(await current.webContents.capturePage()).toPNG());
    const journal=await read(`window.cardbushDesktop.runtime.command({protocol:'bush.runtime_ipc.v1',type:'command',operationId:crypto.randomUUID(),command:{kind:'runtime.assistant_conversation',payload:{action:'read',sessionId:'personal-assistant'}}})`);
    assert.ok(journal.ok && journal.result.entries.some(entry => entry.role==='user' &&
      entry.content.includes('Capsule attachment test') && entry.attachments?.some(item=>item.name==='capsule-fixture.txt')), 'the Assistant journal received the text and attachment together');
    const anchor = current.getBounds();
    const resized = [];
    const onResize = () => {
      const bounds = current.getBounds();
      if (resized.at(-1)?.height !== bounds.height || resized.at(-1)?.width !== bounds.width) resized.push(bounds);
    };
    current.on('resize', onResize);
    current.focus(); await click(bell); await visible('.capsule-replies article');
    await wait(()=>read("document.querySelector('.capsule-replies').textContent.includes('Capsule reply received') && !document.querySelector('.capsule-badge')"),'reading clears the badge');
    await wait(()=>read("document.querySelector('.capsule-replies[data-visible=true]')?.offsetHeight < 150"),'a short reply uses only the height it needs');
    const expanded = current.getBounds();
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    current.removeListener('resize', onResize);
    assert.deepEqual(resized, fixedBacking ? [] : [expanded], 'opening the bell preserves the Windows backing surface and sizes other windows directly to the content');
    assert.equal(expanded.y + expanded.height, anchor.y + anchor.height, 'resizing the reply list keeps the toolbar anchored');
    assert.ok(await read("document.querySelector('.capsule-replies').getBoundingClientRect().bottom < document.querySelector('.floating-capsule').getBoundingClientRect().top"));
    assert.equal(await read("!!document.querySelector('[data-action=workspace]')"),false);
    assert.ok(current.getSize()[1]<350 && !await read("!!document.querySelector('.assistant-view')"),'reply sheet stays lightweight');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-replies.png'),(await current.webContents.capturePage()).toPNG());
    await click('.capsule-replies header button');
    await wait(() => !current.isDestroyed() && current.isVisible() && read("!document.querySelector('.capsule-replies') && !!document.querySelector('.floating-capsule [data-action=replies]')"), 'the close control only collapses replies');
    await read('window.holdJournalPoll=true; void 0');
    const append = content => {
      const entry = {id:crypto.randomUUID(), role:'assistant', source:'text', visibility:'conversation', createdAt:new Date().toISOString(), content};
      const command = {kind:'runtime.assistant_conversation', payload:{action:'append', sessionId:'personal-assistant', entry}};
      const request = {protocol:'bush.runtime_ipc.v1', type:'command', operationId:crypto.randomUUID(), command};
      return workspace.webContents.executeJavaScript(`window.cardbushDesktop.runtime.command(${JSON.stringify(request)})`);
    };
    assert.ok((await append('Previous reply\n'.repeat(35))).ok);
    assert.ok((await append('Latest reply from Assistant')).ok);
    await click(bell);
    await wait(() => read("document.querySelector('.capsule-replies article:first-of-type p')?.textContent==='Latest reply from Assistant' && document.querySelector('.capsule-reply-scroll').scrollTop===0"), 'opening reads the latest Assistant reply before polling resumes');
    await click('.capsule-replies article:first-of-type p');
    assert.ok(await read("!!document.querySelector('.capsule-replies')"), 'reading a reply keeps the list open');
    await wait(()=>read("document.querySelector('.capsule-replies').getBoundingClientRect().top >= 0 && document.querySelector('.capsule-reply-scroll').scrollHeight > document.querySelector('.capsule-reply-scroll').clientHeight"),'long replies scroll inside the sheet');
    const openBounds = current.getBounds();
    await click(bell);
    await wait(async()=>!await read("!!document.querySelector('.capsule-replies')") && current.getBounds().height===anchor.height,'bell closes the full reply sheet');
    resized.length = 0;
    current.on('resize', onResize);
    const bellBounds = await read("document.querySelector('[data-action=replies]').getBoundingClientRect().toJSON()");
    const point = {x:Math.round(bellBounds.x+bellBounds.width/2),y:Math.round(bellBounds.y+bellBounds.height/2)};
    for (const type of ['mouseDown','mouseUp']) current.webContents.sendInputEvent({type,button:'left',clickCount:1,...point});
    await wait(()=>read("document.querySelector('[data-action=replies]').getAttribute('aria-expanded')==='true'"), 'a pointer click reopens the bell');
    await wait(()=>read("document.querySelector('.capsule-replies[data-visible=true]')?.offsetHeight >= 200"),'a long reply returns to its measured height');
    await click('.capsule-reply-scroll article p');
    await read("document.querySelector('.capsule-reply-scroll').scrollTop=50;void 0");
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    current.removeListener('resize',onResize);
    assert.deepEqual(resized,fixedBacking ? [] : [openBounds],'opening, reading and scrolling a long reply keep one stable window size and anchor');
    const gap = await read(`(() => {
      const rect=document.querySelector('.floating-capsule').getBoundingClientRect();
      const x=Math.round(rect.left+3), y=Math.round(rect.top+rect.height/2);
      if (document.elementFromPoint(x,y)?.closest('button')) throw Error('Expected toolbar padding');
      return {x,y};
    })()`);
    for (const type of ['mouseDown','mouseUp']) current.webContents.sendInputEvent({type,button:'left',clickCount:1,...gap});
    await wait(() => read("!document.querySelector('.capsule-replies')"), 'clicking toolbar space collapses replies');
    await click(bell); await visible('.capsule-replies');
    await click(edit); await visible('.capsule-form input');
    assert.ok(!await read("!!document.querySelector('.capsule-replies')"), 'one click goes directly from replies to writing');
    await read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await click(bell); await visible('.capsule-replies');
    await click(bell); await visible(bell+'[aria-expanded=false]');
    await click(bell);
    await wait(()=>read("document.querySelector('.capsule-replies[data-visible=true]')?.ariaHidden==='false'"), 'reopening during exit preserves the active sheet');
    await read('window.holdJournalPoll=false; void 0');
    workspace.focus(); await wait(()=>read("!document.querySelector('.capsule-replies')"),'outside focus closes replies');
    assert.ok(current.isVisible() && !current.isDestroyed(), 'outside focus leaves the capsule on the desktop');
    current.focus();
    const releaseAudio=holdAudioSettings();
    try {
      const voice='.floating-capsule [data-action=voice]';
      await click(voice);
      const controls = '.floating-capsule[data-surface=voice] .voice-composer-call';
      await visible(controls);
      const workPhase = () => workspace.webContents.executeJavaScript("document.querySelector('.sidebar-footer .assistant-stage')?.dataset.state");
      await wait(async()=>await workPhase()==='connecting', 'the workspace character sees the capsule connecting');
      assert.ok(await read(`(() => { const row=document.querySelector('.floating-capsule').getBoundingClientRect();return !document.querySelector('.voice-call-undocked,[data-action=workspace]') && [...document.querySelectorAll('.voice-composer-call button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=row.left && r.right<=row.right && r.top>=row.top && r.bottom<=row.bottom && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}); })()`),'the capsule hosts one unclipped row of call controls');
      const mic = controls + ' .voice-audio-toggle';
      await click(mic);
      await wait(()=>read("document.querySelector('.voice-audio-toggle').getAttribute('aria-pressed')==='true'"),'mute is reachable inside the voice row');
      await click(mic);
      await read("Promise.all(document.querySelector('.voice-call-signal').getAnimations().map(animation=>animation.finished))");
      fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-voice.png'),(await current.webContents.capturePage()).toPNG());
      workspace.focus();
      await wait(()=>read("!!document.querySelector('[data-action=voice][aria-pressed=true] .capsule-live') && !document.querySelector('.voice-call-undocked')"),'outside focus leaves the call active in the compact toolbar');
      current.focus();
      await click(voice);
      await visible(controls);
      await click('.voice-composer-end');
      await wait(()=>read("!!document.querySelector('[data-action=voice][aria-pressed=false]')"),'hanging up restores the normal capsule');
      await wait(async()=>await workPhase()==='idle', 'hanging up clears the voice animation in the workspace');
    } finally { releaseAudio(); }
  } finally { dialog.showOpenDialog=picker; release(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}
