const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({current, read, click, visible, wait, project, holdAudioSettings}) => {
  const edit = '.floating-capsule [data-action=compose]', bell='.floating-capsule [data-action=replies]';
  assert.ok(current.getSize()[0]<200 && current.getSize()[1]<100, 'the actual native window fits the pill');
  assert.equal(await read("document.querySelectorAll('.floating-capsule button').length"),3);
  assert.ok(await read("!document.querySelector('.assistant-messages')"));
  fs.writeFileSync(path.join(project,'tmp','floating-capsule.png'),(await current.webContents.capturePage()).toPNG());
  await wait(()=>current.isVisible(),'native capsule is visible for pointer input');
  current.focus(); current.webContents.focus();
  const pointer = event => {
    const bounds = current.getContentBounds();
    current.webContents.sendInputEvent({...event, globalX:bounds.x+event.x, globalY:bounds.y+event.y});
  };
  const start=current.getBounds();
  const button=await read("(()=>{const r=document.querySelector('[data-action=compose]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  pointer({type:'mouseMove',...button});
  pointer({type:'mouseDown',button:'left',clickCount:1,...button});
  pointer({type:'mouseMove',modifiers:['leftButtonDown'],x:button.x+16,y:button.y+4});
  await wait(()=>Math.abs(current.getBounds().x-start.x)>=10, 'dragging moves the native capsule');
  pointer({type:'mouseUp',button:'left',clickCount:1,...button});
  assert.equal(await read("!!document.querySelector('.capsule-form')"),false,'dragging does not activate the underlying button');
  await click(edit); await visible('.capsule-form input');
  await wait(()=>read("document.activeElement.matches('.capsule-form input')"),'editor takes keyboard focus');
  assert.ok(current.getSize()[0]>=300 && current.getSize()[1]<100,'compose expands horizontally');
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
    pointer({type:'mouseMove',modifiers:['leftButtonDown'],x:attachPoint.x+18,y:attachPoint.y+4});
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
    assert.ok((await read(`window.cardbushDesktop.productHostCommand({protocol:'cardbush.product_host_ipc.v1',kind:'models.update',config:${JSON.stringify(config)}})`)).ok);
    await read("localStorage.setItem('cardbush_theme_mode','light')");
    await new Promise(resolve=>{current.webContents.once('did-finish-load',resolve);current.webContents.reload();});
    await visible(edit); await click(edit); await visible('.capsule-form input');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-editor-light.png'),(await current.webContents.capturePage()).toPNG());
    fs.writeFileSync(file,'Isolated capsule attachment');
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
    await click('.capsule-attach'); await visible('.capsule-files');
    await type('Capsule attachment test');
    await wait(()=>read("!document.querySelector('.capsule-send').disabled"),'model and input ready');
    await read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
    assert.ok(await read("!!document.querySelector('.capsule-form')"), 'committing an IME candidate does not send');
    await read("document.querySelector('.capsule-form input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await visible(bell);
    assert.ok(current.getSize()[0]<200, 'acceptance collapses before the reply arrives');
    release();
    await wait(()=>read("document.querySelector('.capsule-badge')?.textContent==='1'"),'one real unread reply');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-unread.png'),(await current.webContents.capturePage()).toPNG());
    const journal=await read(`window.cardbushDesktop.runtime.command({protocol:'bush.runtime_ipc.v1',type:'command',operationId:crypto.randomUUID(),command:{kind:'runtime.assistant_conversation',payload:{action:'read',sessionId:'personal-assistant'}}})`);
    assert.ok(journal.ok && journal.result.entries.some(entry => entry.role==='user' &&
      entry.content.includes('Capsule attachment test') && entry.attachments?.some(item=>item.name==='capsule-fixture.txt')), 'the Assistant journal received the text and attachment together');
    current.focus(); await click(bell); await visible('.capsule-replies article');
    await wait(()=>read("document.querySelector('.capsule-replies').textContent.includes('Capsule reply received') && !document.querySelector('.capsule-badge')"),'reading clears the badge');
    await wait(()=>current.getSize()[1]<200,'a short reply uses only the height it needs');
    assert.ok(current.getSize()[1]<350 && !await read("!!document.querySelector('.assistant-view')"),'reply sheet stays lightweight');
    fs.writeFileSync(path.join(__dirname,'../../tmp/floating-capsule-replies.png'),(await current.webContents.capturePage()).toPNG());
    await click(bell);
    const releaseAudio=holdAudioSettings();
    try {
      const voice='.floating-capsule [data-action=voice]';
      await click(voice);
      await wait(()=>read("document.querySelector('[data-action=voice]').getAttribute('aria-pressed')==='true' && !!document.querySelector('.capsule-live')"),'starting Assistant voice switches to the active dot');
      await click(voice);
      await wait(()=>read("document.querySelector('[data-action=voice]').getAttribute('aria-pressed')==='false'"),'clicking the dot ends the call');
    } finally { releaseAudio(); }
  } finally { dialog.showOpenDialog=picker; release(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}
