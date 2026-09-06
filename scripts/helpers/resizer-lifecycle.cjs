const assert = require('node:assert/strict');
module.exports = async ({run,until,pause}) => {
  await run(`
    window.resizeCalls=[];
    window.showResizer=kind=>renderView(h('div',null,
      h('aside',{className:'sidebar',style:{width:272}}),
      kind==='sidebar'?h(views.SidebarResizer,{language:'en',onWidthChange:w=>resizeCalls.push(w)}):
        h('aside',{className:'right-inspector',style:{width:420}},h(views.RightInspectorResizer,{width:420,windowMaximized:false,label:'Resize',onWidthChange:w=>resizeCalls.push(w)}))));
    window.beginDrag=(kind,button=0)=>{
      const element=document.querySelector(kind==='sidebar'?'.sidebar-resizer':'.right-inspector-resizer');
      element.setPointerCapture=()=>{}; // inject pointer identity; cleanup is exercised on the actual component
      element.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:17,clientX:300,button}));
    };
    void 0;
  `);
  for(const kind of ['sidebar','right-inspector']) {
    const selector=kind==='sidebar'?'.sidebar-resizer':'.right-inspector-resizer';
    const flag=kind+'-resizing';
    await run(`showResizer(${JSON.stringify(kind)})`);await until(`!!document.querySelector('${selector}')`,'resizer mounted');
    await run(`beginDrag('${kind}',2)`);
    assert.equal(await run(`document.body.classList.contains('${flag}')`),false,'right click does not start resizing');
    for(const end of ['blur','cancel','lost','unmount']) {
      if(end==='unmount') await run(`showResizer('${kind}')`);
      await pause();await run(`beginDrag('${kind}')`);
      assert.equal(await run(`document.body.classList.contains('${flag}')`),true);
      await run(`window.dispatchEvent(new PointerEvent('pointermove',{pointerId:17,clientX:340}));
        window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:99}));`);
      assert.equal(await run(`document.body.classList.contains('${flag}')`),true,'another pointer cannot cancel active drag');
      if(end==='blur') await run(`window.dispatchEvent(new Event('blur'))`);
      if(end==='cancel') await run(`window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:17}))`);
      if(end==='lost') await run(`document.querySelector('${selector}').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:17,bubbles:true}))`);
      if(end==='unmount') await run('renderView(null)');
      await pause();
      assert.equal(await run(`document.body.classList.contains('${flag}')`),false,'cleanup: '+kind+' '+end);
      await run(`window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17,clientX:350}))`);
      assert.equal(await run('resizeCalls.length'),0,'cancelled/unmounted handler cannot commit stale width');
    }
    await run(`showResizer('${kind}')`);await until(`!!document.querySelector('${selector}')`,'remount');
    await run(`beginDrag('${kind}');window.dispatchEvent(new PointerEvent('pointermove',{pointerId:17,clientX:350}));window.dispatchEvent(new PointerEvent('pointerup',{pointerId:17,clientX:350}))`);
    assert.equal(await run('resizeCalls.length'),1,'normal drag commits exactly once');
    await run('resizeCalls=[];renderView(null)');await pause();
  }
  console.log('Resizer lifecycle passed: right-click, pointer identity, blur, cancel, capture loss, unmount and normal commit.');
};
