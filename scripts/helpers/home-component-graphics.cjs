const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({run,until,window,root}) => {
  const {session,nativeImage} = require('electron');
  const origin = 'https://graphics.example.org';
  const directory = path.join(root,'scripts/fixtures/home-graphics');
  const html = fs.readFileSync(path.join(directory,'index.html'),'utf8');
  const requests=[];
  const messages=[];
  const diagnostic=event=>messages.push(event.message);
  window.webContents.on('console-message',diagnostic);
  const handle = async request => {
    const url = new URL(request.url);
    if (url.origin!==origin) return new Response('Unexpected fixture request',{status:400});
    requests.push(url.pathname);
    const files = {'/scene.css':[directory,'scene.css','text/css'], '/scene.js':[directory,'scene.js','text/javascript'],
      ...Object.fromEntries(['three.module.js','three.core.js','three.webgpu.js','three.tsl.js'].map(name=>['/'+name,[path.join(root,'node_modules/three/build'),name,'text/javascript']]))};
    const headers = {'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'};
    if(url.pathname==='/payload.json') return new Response('{"loaded":true}',{headers:{...headers,'Content-Type':'application/json'}});
    if(url.pathname==='/worker-module.js') return new Response('export const answer=42',{headers:{...headers,'Content-Type':'text/javascript'}});
    const file=files[url.pathname];
    return file ? new Response(fs.readFileSync(path.join(file[0],file[1])),{headers:{...headers,'Content-Type':file[2]}}) : new Response('',{status:404});
  };
  const previewSession=session.fromPartition('cardbush-home-preview');
  // Replace the icon-only fixture at the end of this isolated test case.
  window.webContents.session.protocol.unhandle('https');
  window.webContents.session.webRequest.onBeforeRequest((request,done)=>done({cancel:/^https?:/.test(request.url) && new URL(request.url).origin!==origin}));
  await window.webContents.session.protocol.handle('https',handle);
  await previewSession.protocol.handle('https',handle);
  try {
    const component={id:'graphics',title:'Graphics',html,resourceDomains:[origin],home:true,allowActions:false,width:12,height:400,order:0};
    await run(`(async()=>{const state=await views.getComponents();await views.saveComponents({...state,items:[${JSON.stringify(component)}]},state.revision);showHome(false);})()`);
    await until("!!document.querySelector('[data-home-block=\"html:graphics\"]')",'published graphics component');
    await run('document.querySelector("[data-kind=html]").scrollIntoView()');
    await until('!!document.querySelector(".html-component-frame")','graphics frame');
    const frame=()=>window.webContents.mainFrame.framesInSubtree.find(f=>f.url==='about:srcdoc');
    const end=Date.now()+25000;
    let result;
    while(Date.now()<end){
      result=await frame()?.executeJavaScript('window.graphics');
      if(result && result.status!=='loading')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(result?.status,'ready',JSON.stringify({result,requests,messages:messages.slice(-10)}));
    assert.equal(result.origin,'null');assert.equal(result.secure,true);assert.equal(result.wasm,true);
    assert.equal(result.blobModule,7);assert.equal(result.dataModule,9);assert.deepEqual(result.asset,{loaded:true});
    assert.equal(result.blocked,true);assert.deepEqual(result.worker,{pixel:[0,255,0,255]});assert.equal(result.moduleWorker,42);
    assert.ok(result.webgl[0]>240 && result.webgl[1]<10,'Three.js renders red pixels through WebGL2');
    const gpuOnHost=await run('(async()=>!!await navigator.gpu?.requestAdapter())()');
    assert.equal(result.adapter,gpuOnHost,'the component retains the browser GPU capability');
    if(gpuOnHost){assert.equal(result.backend,true);assert.ok(result.webgpu[1]>240 && result.webgpu[0]<10,'Three.js renders green pixels through WebGPU');}
    const layout=await run(`(()=>{const block=document.querySelector('[data-kind=html]'),body=block.querySelector('.home-block-body'),frame=block.querySelector('iframe'),style=getComputedStyle(body);return {chrome:!!block.querySelector('header,footer,.home-block-tools'),height:frame.getBoundingClientRect().height,bodyHeight:body.getBoundingClientRect().height,border:style.borderWidth,radius:style.borderRadius,background:style.backgroundColor,label:block.getAttribute('aria-label')}})()`);
    assert.equal(layout.chrome,false);assert.equal(layout.height,layout.bodyHeight);assert.equal(layout.border,'0px');assert.equal(layout.radius,'0px');assert.equal(layout.background,'rgba(0, 0, 0, 0)');assert.equal(layout.label,'Graphics');
    assert.equal(await frame().executeJavaScript('getComputedStyle(document.body).margin'),'0px');
    assert.equal(await frame().executeJavaScript('getComputedStyle(document.documentElement).backgroundColor'),'rgb(32, 92, 197)');
    assert.deepEqual(await frame().executeJavaScript('[typeof require,typeof window.cardbushDesktop,(()=>{try{return parent.localStorage.length}catch{return "blocked"}})()]'),['undefined','undefined','blocked']);
    fs.writeFileSync(path.join(root,'tmp/home-component-graphics.png'),(await window.webContents.capturePage()).toPNG());
    // The real native preview also needs the declared CSS/module resources;
    // it must not acquire live app context, state or actions to render them.
    const {previewHomeComponent}=require(path.join(root,'dist-electron/homeComponentPreview.js'));
    const preview=await previewHomeComponent({...component,html:'<link rel="stylesheet" href="'+origin+'/scene.css">'},new AbortController().signal);
    const pixel=nativeImage.createFromBuffer(Buffer.from(preview,'base64')).toBitmap().subarray(0,3);
    assert.ok(pixel[0]>pixel[2] && pixel[0]>120,'isolated preview loads declared styles');
    assert.ok(requests.includes('/three.core.js') && requests.includes('/worker-module.js'));
    await run(`(async()=>{const state=await views.getComponents();await views.saveComponents({...state,items:[${JSON.stringify({...component,resourceDomains:[]})}]},state.revision);})()`);
    await until(`!document.querySelector('.html-component-frame')?.srcdoc.includes("data: ${origin}")`,'resource revocation applied');
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(await frame().executeJavaScript('typeof window.graphics'),'undefined','revoking declared resources remounts without running the old module');
    await run('showHome(true)');
    await until('!!document.querySelector(".home-block-title")','title retained in layout editor');
    assert.equal(await run('!!document.querySelector("[data-home-action=configure]")'),true);
    console.log('Home graphics passed:',JSON.stringify(result));
  } finally {
    await run('renderView(null)');
    window.webContents.session.protocol.unhandle('https');previewSession.protocol.unhandle('https');
    window.webContents.session.webRequest.onBeforeRequest(null);
    window.webContents.removeListener('console-message',diagnostic);
  }
};
