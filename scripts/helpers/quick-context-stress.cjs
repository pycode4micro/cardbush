const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testContextStress({run,until,pause,window,root}) {
  await run(`
    window.stressHost=document.createElement('div');stressHost.className='app theme-dark';
    stressHost.style.cssText='position:fixed;inset:0;z-index:100;display:block;width:100vw;height:100vh';
    stressHost.innerHTML='<div class="chat-body" style="position:absolute;inset:20px 100px"><div class="message-list" style="position:absolute;inset:0;overflow:auto"><div class="message-list-content"></div></div><div id="stress-rail-root"></div></div>';
    document.body.append(stressHost);window.stressReads=0;window.stressRenderTimes=[];
    const longRequest='Review the project and keep scrolling responsive. '.repeat(200);
    window.stressMessages=Array.from({length:2000},(_,index)=>['user','assistant'].map(role=>({
      id:'stress-'+role+'-'+index,role,turnId:'stress-turn-'+index,createdAt:'2026-10-31T00:00:00Z',
      metadata:role==='assistant'?{transcript_kind:'assistant_final'}:{},
      get content(){stressReads++;return role==='user'?'Request '+index+' '+longRequest:'Final answer '+index;}
    }))).flat();
    const fragment=document.createDocumentFragment();
    for(let index=0;index<2000;index++){
      const row=document.createElement('div');row.className='message-list-item';row.dataset.messageRole='user';row.dataset.messageId='stress-user-'+index;
      row.style.cssText='height:64px;contain-intrinsic-block-size:64px;padding:12px 60px;box-sizing:border-box';row.textContent='Turn '+(index+1);fragment.append(row);
    }
    stressHost.querySelector('.message-list-content').append(fragment);
    window.stressRoot=require(${JSON.stringify(require.resolve('react-dom/client'))}).createRoot(stressHost.querySelector('#stress-rail-root'));
    window.stressSession='stress';window.stressHasEarlier=true;window.stressPageLoading=false;window.stressPageCalls=0;
    window.stressLoadEarlier=async()=>{stressPageCalls++;stressPageLoading=true;renderStress();
      await new Promise(resolve=>window.finishStressPage=resolve);
      stressMessages=[...Array.from({length:20},(_,i)=>({id:'older-'+i,role:'user',turnId:'older-turn-'+i,content:'Earlier request '+i})),...stressMessages];
      stressHasEarlier=false;stressPageLoading=false;renderStress();
    };
    window.renderStress=()=>stressRoot.render(h(require(${JSON.stringify(require.resolve('react'))}).Profiler,{id:'rail',onRender:(_id,_phase,duration)=>stressRenderTimes.push(duration)},
      h(views.QuickContextRail,{language:'en',sessionId:stressSession,messages:stressMessages,turnHistoryAvailable:false,
        hasEarlier:stressHasEarlier,loadingEarlier:stressPageLoading,onLoadEarlier:stressLoadEarlier})));
    window.stressFrame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    window.stressVisible=()=>{const r=stressHost.querySelector('.quick-context-ticks').getBoundingClientRect();return [...stressHost.querySelectorAll('.quick-context-tick')].filter(n=>{const b=n.getBoundingClientRect();return b.top>=r.top&&b.bottom<=r.bottom;});};
    renderStress();void 0;
  `);
  await until('stressHost.querySelectorAll(".quick-context-tick").length>3','large reel');
  await run('stressFrame()');
  await until('stressVisible()[0]?.dataset.turnMessageId==="stress-user-0"','initial reel position');
  const count=await run('stressHost.querySelectorAll(".quick-context-tick").length');
  assert.ok(count<=99,'only a viewport plus bounded overscan is mounted');
  assert.ok(await run(`stressReads<${count}*3+20`),'startup only reads labels in bounded windows');
  const checkContiguous=async()=>{
    const indices=await run('[...stressHost.querySelectorAll(".quick-context-tick")].map(n=>Number(n.dataset.turnIndex))');
    assert.ok(indices.length<=99);for(let i=1;i<indices.length;i++)assert.equal(indices[i],indices[i-1]+1,'no sampled or skipped turns');
  };
  await checkContiguous();await run('stressReads=0;stressRenderTimes=[];void 0');
  for(let step=0;step<20;step++)await run(`stressMessages=[...stressMessages.slice(0,-1),{...stressMessages.at(-1),content:'Streaming update ${step}'}];renderStress();stressFrame()`);
  const metrics=await run('({turns:2000,updates:20,marks:stressHost.querySelectorAll(".quick-context-tick").length,contentReads:stressReads,maxRenderMs:Math.max(...stressRenderTimes),meanRenderMs:stressRenderTimes.reduce((sum,n)=>sum+n,0)/stressRenderTimes.length})');
  assert.ok(metrics.contentReads<200,'streaming does not re-read historical prompts');
  await run('window.stressTrack=stressHost.querySelector(".quick-context-ticks");window.stressScroller=stressHost.querySelector(".message-list");void 0');
  const wheel=async deltaY=>{
    const point=await run('(()=>{const r=stressTrack.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    window.webContents.sendInputEvent({type:'mouseMove',...point});window.webContents.sendInputEvent({type:'mouseWheel',...point,deltaY,deltaX:0});
  };
  const bodyTop=await run('stressScroller.scrollTop');
  await wheel(-240);await until('stressTrack.scrollTop>100','native wheel rolls the tick window down');await pause(200);
  assert.equal(await run('stressScroller.scrollTop'),bodyTop,'browsing ticks does not move the transcript');
  assert.ok(await run('Number(stressVisible()[0].dataset.turnIndex)>0'));await checkContiguous();
  const rolled=await run('stressTrack.scrollTop');await wheel(90);await until(`stressTrack.scrollTop<${rolled}-30`,'wheel rolls back upward');
  assert.equal(await run('stressScroller.scrollTop'),bodyTop);
  const oldHeight=await run('stressTrack.clientHeight');window.setSize(1200,500);await pause(250);
  assert.ok(await run(`stressTrack.clientHeight<${oldHeight}`),'capacity adapts to shorter windows');await checkContiguous();
  window.setSize(1200,800);await pause(250);

  // Hold idle work in this isolated renderer to observe genuine loading and cancellation.
  await run(`window.savedStressIdle=requestIdleCallback;window.savedStressCancel=cancelIdleCallback;window.stressJobs=[];
    window.requestIdleCallback=callback=>{const id=stressJobs.length+1;stressJobs.push({id,callback,cancelled:false});return id;};
    window.cancelIdleCallback=id=>{const job=stressJobs.find(job=>job.id===id);if(job)job.cancelled=true;};void 0;`);
  const hover=async slot=>{
    window.webContents.sendInputEvent({type:'mouseMove',x:10,y:10});await pause(150);
    const point=await run(`(()=>{const b=stressVisible()[${slot}],r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),id:b.dataset.turnMessageId};})()`);
    window.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
    await until('!!stressHost.querySelector(".turn-hover-preview")','lazy preview opens');return point.id;
  };
  const first=await hover(3);await until('stressJobs.length>0 && !!stressHost.querySelector(".turn-hover-skeleton")','pending preview skeleton');
  assert.equal(await run('[...stressHost.querySelectorAll(".turn-hover-skeleton span")].filter(n=>n.getBoundingClientRect().height>0 && !["transparent","rgba(0, 0, 0, 0)"].includes(getComputedStyle(n).backgroundColor)).length'),4,'loading bars are visibly painted');
  await run('stressFrame()');await pause(120);
  fs.writeFileSync(path.join(root,'tmp/context-reel-loading.png'),(await window.webContents.capturePage()).toPNG());
  const second=await hover(8);await until('stressJobs.length>1 && !!stressHost.querySelector(".turn-hover-skeleton")','next preview loads independently');
  assert.notEqual(first,second);assert.equal(await run('stressJobs[0].cancelled'),true,'leaving cancels old idle work');
  await run('stressJobs[0].callback();void 0');assert.equal(await run('!!stressHost.querySelector(".turn-hover-skeleton")'),true,'late callback cannot replace newer content');
  await run('stressJobs.at(-1).callback();void 0');const reply='Final answer '+second.split('-').at(-1);
  await until(`stressHost.querySelector('.turn-hover-preview-reply')?.textContent===${JSON.stringify(reply)}`,'correct lazy content');
  const jobs=await run('stressJobs.length');await hover(8);
  await until(`stressHost.querySelector('.turn-hover-preview-reply')?.textContent===${JSON.stringify(reply)}`,'cached hover');
  assert.equal(await run('stressJobs.length'),jobs,'cache avoids duplicate reads');
  for(let step=0;step<20;step++)await run(`stressMessages=stressMessages.map(message=>message.id===${JSON.stringify(second.replace('-user-','-assistant-'))}?{...message,content:'Live hover update ${step}'}:message);renderStress();stressFrame()`);
  assert.equal(await run('stressJobs.length'),jobs+1,'streaming coalesces into one pending idle read');
  assert.equal(await run('stressHost.querySelector(".turn-hover-preview-reply")?.textContent'),reply,'an updating preview keeps its previous content');
  await run('stressJobs.at(-1).callback();void 0');
  await until('stressHost.querySelector(".turn-hover-preview-reply")?.textContent==="Live hover update 19"','pending work reads the newest streamed content');
  await run('window.requestIdleCallback=savedStressIdle;window.cancelIdleCallback=savedStressCancel;void 0');
  window.webContents.sendInputEvent({type:'mouseMove',x:10,y:10});await pause(150);

  await run(`stressTrack.querySelector('.quick-context-tick').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));void 0`);
  await until('document.activeElement?.dataset.turnMessageId==="stress-user-0"','Home reveals the first turn');
  await run(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));void 0`);
  await until('document.activeElement?.dataset.turnMessageId==="stress-user-1"','adjacent turn navigation');
  await run('document.activeElement.click();void 0');await until('stressHost.querySelector(".quick-context-panel")?.textContent.includes("Final answer 1")','exact turn detail');
  await run(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));stressTrack.scrollTop=0;void 0`);await run('stressFrame()');
  await run('window.stressAnchorTop=stressTrack.querySelector("[data-turn-message-id=stress-user-0]").getBoundingClientRect().top;void 0');
  await wheel(160);await until('stressPageCalls===1 && stressTrack.getAttribute("aria-busy")==="true"','upper edge loads one older page');
  await wheel(160);await pause(80);assert.equal(await run('stressPageCalls'),1,'in-flight pages are deduplicated');
  await run('finishStressPage();void 0');await until('stressTrack.getAttribute("aria-busy")==="false" && stressMessages.length===4020','older page installed');
  assert.ok(await run('Math.abs(stressTrack.querySelector("[data-turn-message-id=stress-user-0]").getBoundingClientRect().top-stressAnchorTop)<1'),'prepend preserves the visible tick position');
  await wheel(160);await until('stressVisible()[0]?.dataset.turnMessageId.startsWith("older-")','older ticks roll into view');await pause(250);await checkContiguous();
  await run(`stressTrack.querySelector('.quick-context-tick').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));void 0`);
  await until('document.activeElement?.dataset.turnMessageId==="stress-user-1999"','End reveals the latest turn');
  await run('stressTrack.querySelector("[data-turn-message-id=stress-user-1999]").click();void 0');await until('stressHost.querySelector(".quick-context-panel")?.textContent.includes("Streaming update 19")','latest reply stays fresh');
  await run('stressRoot.unmount();stressHost.remove();void 0');
  fs.writeFileSync(path.join(root,'tmp/context-reel-performance.json'),JSON.stringify(metrics,null,2));
  console.log('Virtual context reel passed:',JSON.stringify(metrics));
};
