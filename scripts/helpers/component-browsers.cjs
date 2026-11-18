const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({library,item,card,win,read,wait,inFrame,project}) => {
  const {session,webContents} = require('electron');
  const site='https://player.example.org', page=site+'/watch', denied='https://other.example.org/watch';
  const isolated=session.fromPartition('cardbush-home-site:'+site), requests=[], embeds=[];
  let failOnce=true;
  const markup='<button onclick="this.textContent=42">41</button><a target="_blank" href="/room">Room</a>';
  win.webContents.session.protocol.handle('https', req => {
    embeds.push(req.url);
    return new Response('<main>Official embed</main>', {headers:{'Content-Type':'text/html'}});
  });
  isolated.protocol.handle('https', req => {
    requests.push({url:req.url,cookie:req.headers.get('cookie')});
    if(req.url.endsWith('/offline') && failOnce) { failOnce=false; return Response.error(); }
    return new Response(markup,{headers:{'Content-Type':'text/html', 'Content-Security-Policy':"frame-ancestors 'none'"}});
  });
  const guest = url => webContents.getAllWebContents().find(w=>w.session===isolated && w.getURL()===url);
  const ready = url => wait(async () => { const view=guest(url); return view && !view.isLoading() && await view.executeJavaScript('!!document.querySelector("button")') && view; },'declared website loaded: '+url);
  const roundTrip = async (section, hidden = async () => {}) => {
    const loads=requests.filter(request=>request.url===page).length, embedLoads=embeds.filter(url=>url===page).length;
    await read(`window.retainedHome={root:document.querySelector('[data-desktop-page=overview]'),frame:document.querySelector('${card} iframe')};
      document.querySelector('[data-nav-section=${section}]').click();void 0`);
    await wait(()=>read(`document.querySelector('.desktop-shell')?.dataset.page==='${section}' && retainedHome.root.dataset.pageVisible==='false'`),'Home hidden behind '+section);
    assert.deepEqual(await read(`({connected:retainedHome.root.isConnected,hidden:getComputedStyle(retainedHome.root).visibility,
      inert:retainedHome.root.inert,aria:retainedHome.root.getAttribute('aria-hidden'),
      stageOffset:parseFloat(getComputedStyle(document.querySelector('.main-stage')).marginTop)>0})`),
      {connected:true,hidden:'hidden',inert:true,aria:'true',stageOffset:true},'retained Home cannot cover or change the conversation layout');
    await hidden();
    await read("document.querySelector('[data-nav-section=home]').click();void 0");
    await wait(()=>read("document.querySelector('[data-desktop-page=overview]')?.dataset.pageVisible==='true'"),'return to Home');
    assert.deepEqual(await read(`({root:retainedHome.root===document.querySelector('[data-desktop-page=overview]'),
      frame:retainedHome.frame===document.querySelector('${card} iframe'),inert:retainedHome.root.inert,
      hidden:getComputedStyle(retainedHome.root).visibility})`),{root:true,frame:true,inert:false,hidden:'visible'},'Home and its authored document survive navigation');
    assert.equal(requests.filter(request=>request.url===page).length,loads,'navigation does not reload the native website');
    assert.equal(embeds.filter(url=>url===page).length,embedLoads,'navigation does not reload an embedded website');
  };
  await read("window.componentBrowserTrace=[];addEventListener('message',event=>{if(event.data?.topic==='home.browserLayout')window.componentBrowserTrace.push(event.data.items)});void 0");
  try {
    await win.webContents.session.cookies.set({url:site,name:'owner',value:'desktop'});
    const html=`<style>body{margin:12px}nav{display:flex;gap:8px;height:42px}.viewport{height:210px;overflow:auto}
      cardbush-browser{height:280px;width:100%}.spacer{height:24px}</style>
      <nav><button id="room">Room</button><button id="refresh">Refresh</button><button id="toggle">Hide</button><output id="status"></output></nav>
      <div class="viewport"><div class="spacer"></div><cardbush-browser id="site" src="${page}"></cardbush-browser></div>
      <script>const browser=document.querySelector('cardbush-browser');
      browser.addEventListener('load',()=>document.querySelector('#status').textContent='loaded');
      browser.addEventListener('error',()=>document.querySelector('#status').textContent='failed');
      room.onclick=()=>browser.src='${site}/room';refresh.onclick=()=>browser.reload();
      toggle.onclick=()=>browser.hidden=!browser.hidden;</script>`;
    library.publish({...item,html,embedDomains:[]},true);
    await wait(()=>inFrame('!!document.querySelector("cardbush-browser")'),'component owns browser layout');
    assert.equal(await read(`!!document.querySelector('${card} webview')`),false,'undeclared origins never mount a browser');
    library.publish({...item,html,embedDomains:[site]},true);
    const first=await ready(page);
    assert.equal(await read(`!!document.querySelector('${card} .component-embed-bar')`),false,'the host inserts no separate button row');
    assert.equal(await read(`!!document.querySelector('${card} .component-website-menu')`),false,'component browsers have no host navigation controls');
    assert.equal(await inFrame('!!document.querySelector("nav")'),true,'a single site never replaces the authored component');
    await wait(()=>inFrame('document.querySelector("#status").textContent==="loaded"'),'browser load reaches component listener');
    assert.deepEqual(await first.executeJavaScript('[window.top===self,typeof cardbushDesktop,typeof require,document.cookie]'),[true,'undefined','undefined','']);
    assert.equal(await first.executeJavaScript('document.querySelector("button").click();document.querySelector("button").textContent'),'42');
    const video=fs.readFileSync(path.join(project,'scripts/fixtures/inspector-media.webm')).toString('base64');
    assert.equal(first.getBackgroundThrottling(),false,'Home media is not suspended by background throttling');
    await first.executeJavaScript(`(async()=>{window.livePlayer=document.createElement('video');livePlayer.loop=true;
      livePlayer.src='data:video/webm;base64,${video}';document.body.append(livePlayer);await livePlayer.play();})()`,true);
    const geometry=async () => {
      const outer=await read(`(()=>{const f=document.querySelector('${card} iframe').getBoundingClientRect(),b=document.querySelector('${card} [data-component-browser]').getBoundingClientRect();return {x:b.x-f.x,y:b.y-f.y,width:b.width,height:b.height}})()`);
      const inner=await inFrame('(()=>{const b=document.querySelector("cardbush-browser").getBoundingClientRect(),v=document.querySelector(".viewport").getBoundingClientRect();return {x:b.x,y:Math.max(b.y,v.y),width:b.width,height:Math.min(b.bottom,v.bottom)-Math.max(b.y,v.y)}})()');
      return Object.keys(inner).every(key=>Math.abs(outer[key]-inner[key])<2);
    };
    await wait(geometry,'native browser respects the component slot and clipping');
    assert.equal(await first.executeJavaScript('livePlayer.paused'),false,'fixture is playing before navigation');
    await inFrame('window.liveDraft="unsaved component state";void 0');
    for (const section of ['assistant','chat']) {
      await roundTrip(section,async () => {
        assert.equal(first.isDestroyed(),false,'live native browser keeps running while Home is hidden');
        assert.equal(await first.executeJavaScript('document.querySelector("button").textContent'),'42');
        assert.equal(await first.executeJavaScript('livePlayer.paused'),false,'navigation does not stop media playback');
        assert.equal(await inFrame('cardbush.state.write({hidden:true}).then(()=>"bad",error=>error.message)'),'INACTIVE_SURFACE');
        assert.equal(await inFrame('cardbush.invoke("conversation.send",{text:"hidden"}).then(()=>"bad",error=>error.message)'),'INACTIVE_SURFACE');
        await inFrame('document.querySelector("cardbush-browser").style.width="80%";void 0');
      });
      assert.equal((await ready(page)).id,first.id,'return reuses the same native webContents');
      assert.equal(await first.executeJavaScript('document.querySelector("button").textContent'),'42','in-page state survives both destinations');
      const position=await first.executeJavaScript('livePlayer.currentTime');
      await wait(()=>first.executeJavaScript(`!livePlayer.paused && livePlayer.currentTime!==${position}`),'retained video continues playing after return');
      assert.equal(await inFrame('window.liveDraft'),'unsaved component state','component script state survives navigation');
      await wait(geometry,'return refreshes browser geometry without reloading');
    }
    await inFrame('document.querySelector(".viewport").scrollTop=70');
    await wait(geometry,'scrolling keeps the native browser aligned');
    await inFrame('document.querySelector("cardbush-browser").style.width="70%"');
    await wait(geometry,'resizing keeps the native browser aligned');
    await inFrame('document.querySelector("#room").click()');
    await ready(site+'/room');
    await wait(()=>first.isDestroyed(),'changing src releases the previous browser');
    const count=requests.length;
    await inFrame('document.querySelector("#refresh").click()');
    await wait(()=>requests.length>count,'component reload refreshes the browser');
    await ready(site+'/room');
    await inFrame('document.querySelector("#toggle").click()');
    await wait(()=>read(`!document.querySelector('${card} webview')`),'hidden component slot releases the browser');
    await inFrame('document.querySelector("#toggle").click()');
    await ready(site+'/room');
    await inFrame('document.querySelector("cardbush-browser").src='+JSON.stringify(denied));
    await wait(()=>read(`!document.querySelector('${card} webview')`),'navigation to undeclared sites is rejected');
    await inFrame('document.querySelector("cardbush-browser").src='+JSON.stringify(page));
    await ready(page);
    await inFrame('document.querySelector("cardbush-browser").src='+JSON.stringify(site+'/offline'));
    await wait(()=>inFrame('document.querySelector("#status").textContent==="failed"'),'browser failure reaches the component');
    await wait(()=>guest(site+'/offline') && !guest(site+'/offline').isLoading(),'Chromium finishes its error page');
    assert.equal(await inFrame('document.querySelector("#status").textContent'),'failed','the browser error page cannot replace failure with a successful load');
    const failedGuest=guest(site+'/offline');
    await inFrame('document.querySelector("#refresh").click()');
    await wait(()=>failedGuest.isDestroyed(),'component retry releases the failed guest');
    await ready(site+'/offline');
    await inFrame(`const second=document.createElement('cardbush-browser');second.src='${site}/second';second.style.height='130px';document.querySelector('.viewport').prepend(second)`);
    await ready(site+'/second');
    await inFrame('document.querySelector(".viewport").scrollTop=0');
    await wait(()=>read(`document.querySelectorAll('${card} webview').length===2`),'multiple website slots retain the component layout');
    fs.mkdirSync(path.join(project,'tmp'),{recursive:true});
    fs.writeFileSync(path.join(project,'tmp/component-browser-ui.png'),(await win.webContents.capturePage()).toPNG());
    const before=webContents.getAllWebContents().filter(w=>w.session===isolated);
    await read("document.querySelector('[data-nav-section=assistant]').click();void 0");
    await wait(()=>read("document.querySelector('[data-desktop-page=overview]')?.dataset.pageVisible==='false'"),'Home hidden before revoking access');
    library.publish({...item,html,embedDomains:[]},true);
    await wait(()=>read(`!document.querySelector('${card} webview')`),'removing the declaration immediately removes browser access');
    await wait(()=>before.every(w=>w.isDestroyed()),'declaration changes release all guests even while Home is hidden');
    await read("document.querySelector('[data-nav-section=home]').click();void 0");
    await wait(()=>read("document.querySelector('[data-desktop-page=overview]')?.dataset.pageVisible==='true'"),'Home visible after revocation');
    library.publish({...item,html:'<iframe src="'+page+'"></iframe>',embedDomains:[site]},true);
    await wait(()=>win.webContents.mainFrame.framesInSubtree.some(f=>f.url===page),'ordinary official iframes also load from a declaration');
    const embedded=win.webContents.mainFrame.framesInSubtree.find(f=>f.url===page);
    await embedded.executeJavaScript('window.liveDraft="embedded playback state";void 0');
    await roundTrip('assistant');
    assert.equal(await embedded.executeJavaScript('window.liveDraft'),'embedded playback state','ordinary iframe retains its document');
    const state=library.snapshot();
    library.save(state.items.map(entry=>entry.id===item.id ? {...entry,homeWebsiteUrl:page} : entry),state.revision);
    const direct=await ready(page);
    await direct.executeJavaScript('document.querySelector("button").click();void 0');
    for (const section of ['assistant','chat']) {
      await roundTrip(section,async () => assert.equal(direct.isDestroyed(),false,'direct website stays mounted while hidden'));
      assert.equal((await ready(page)).id,direct.id,'direct website keeps the same native guest');
      assert.equal(await direct.executeJavaScript('document.querySelector("button").textContent'),'42');
    }
    assert.equal(await read(`!!document.querySelector('${card} .component-website-menu[open]')`),false,'legacy webpage controls start in a collapsed menu');
    await read(`document.querySelector('${card} .component-website-menu summary').click()`);
    await read(`document.querySelector('${card} [data-embed-back]').click()`);
    await wait(()=>win.webContents.mainFrame.framesInSubtree.some(f=>f.url===page),'legacy menu returns to the original widget');
    assert.ok(requests.every(request=>!request.cookie),'app session cookies never reach component websites');
    assert.equal(await inFrame('!!cardbush.net'),false,'website declarations do not grant JSON reads');
    console.log('Component browsers passed: Assistant/chat navigation retains native and iframe state without reloads; hidden actions blocked; declarations, controls, geometry, retry and revocation intact.');
  } catch(error) {
    console.error('Component browser diagnostics',JSON.stringify({requests,
      host:await read(`({layouts:window.componentBrowserTrace.slice(-3),html:document.querySelector('${card}')?.outerHTML.slice(-6000)})`),
      frame:await inFrame('({ready:document.readyState,browsers:[...document.querySelectorAll("cardbush-browser")].map(node=>({src:node.src,box:node.getBoundingClientRect().toJSON(),display:getComputedStyle(node).display})),height:innerHeight})'),
      guests:webContents.getAllWebContents().filter(w=>w.getType()==='webview').map(w=>({url:w.getURL(),isolated:w.session===isolated}))}));
    throw error;
  } finally {
    win.webContents.session.protocol.unhandle('https'); isolated.protocol.unhandle('https');
    await win.webContents.session.cookies.remove(site,'owner');
  }
};
