const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const parent = path.join(root, 'tmp');
  const directory = await fs.mkdtemp(path.join(parent, 'media-reveal-'));
  try {
    const chart = path.join(directory, 'chart.html').replaceAll('\\', '/');
    await fs.writeFile(chart, `<!doctype html><meta charset="utf-8"><meta name="cardbush:preview" content="visualization">
      <style>body{margin:0;font:16px system-ui}section{height:260px;box-sizing:border-box;padding:24px}button{font:inherit}</style>
      <section data-chart-section><h2>稳定的图表区域</h2><button onclick="this.textContent='已选择'">选择</button><svg width="100%" height="150"><path d="M0 120L90 50L200 80L300 10" fill="none" stroke="var(--viz-series-1)" stroke-width="3"/></svg></section>
      <script>document.querySelector('section').style.height='320px';queueMicrotask(()=>document.querySelector('section').style.height='340px')</script>`);
    // Generated 180x320 VP8 fixture; no runtime encoder, network or user files.
    const videoPath = path.join(directory, 'portrait.webm').replaceAll('\\', '/');
    await fs.copyFile(path.join(root, 'scripts/fixtures/media-preview-portrait.webm'), videoPath);
    const videoSource = 'data:video/webm;base64,' + (await fs.readFile(videoPath)).toString('base64');
    const wav = Buffer.alloc(44 + 8000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    const audioPath = path.join(directory, 'audio.wav').replaceAll('\\', '/');
    await fs.writeFile(audioPath, wav);
    await run(`
      window.mediaRender=()=>renderView(h('div',{className:'media-fixture',style:{width:620,padding:20}},
        h('h2',null,'音视频预览'),h(views.InlineVideo,{'aria-label':'竖屏视频'}),h(views.InlineAudio,{'aria-label':'音频'})));
      mediaRender();
    `);
    await until("document.querySelectorAll('.inline-media-frame').length===2", 'reserved media frames');
    const sizes = () => run("[...document.querySelectorAll('.inline-media-frame')].map(node=>({width:node.clientWidth,height:node.clientHeight}))");
    const before = await sizes();
    await run(`
      window.mediaElements=[document.querySelector('video'),document.querySelector('audio')];
      window.mediaSizes=[];window.revealCount=0;
      document.addEventListener('animationstart',event=>{if(event.animationName==='preview-reveal')revealCount++});
      window.mediaSample=()=>{mediaSizes.push([...document.querySelectorAll('.inline-media-frame')].map(node=>node.clientHeight));window.mediaSampleFrame=requestAnimationFrame(mediaSample)};mediaSample();
      mediaElements[0].src=${JSON.stringify(videoSource)};
      mediaElements[1].src=${JSON.stringify('data:audio/wav;base64,' + wav.toString('base64'))};
    `);
    await until("document.querySelectorAll('.inline-media-frame.is-ready').length===2", 'metadata starts reveals');
    assert.equal(await run('mediaElements[0].videoHeight>mediaElements[0].videoWidth'), true,
      'real portrait dimensions loaded: ' + await run('JSON.stringify({width:mediaElements[0].videoWidth,height:mediaElements[0].videoHeight,error:mediaElements[0].error?.message})'));
    assert.equal(await run('mediaElements[1].duration'), 1, 'the real WAV metadata loaded');
    assert.equal(await run("mediaElements[0].getAnimations().some(animation=>animation.animationName==='preview-reveal')"), true);
    assert.deepEqual(await sizes(), before, 'metadata cannot change reserved media geometry');
    await pause(360);
    const allSizes = await run('cancelAnimationFrame(mediaSampleFrame); mediaSizes');
    assert.ok(allSizes.every(sample => sample[0] === before[0].height && sample[1] === before[1].height), 'the entire reveal leaves layout unchanged');
    const starts = await run('revealCount');
    await run('mediaRender()'); await pause(80);
    assert.equal(await run('document.querySelector("video")===mediaElements[0] && document.querySelector("audio")===mediaElements[1]'), true);
    assert.equal(await run('revealCount'), starts, 'unrelated rerenders do not restart the reveal or player');
    await fs.writeFile(path.join(parent, 'media-reveal-players.png'), (await window.webContents.capturePage()).toPNG());

    // Exercise the actual Markdown path, then HTML's first ready frame.
    await run(`window.mediaSavedDesktop=window.cardbushDesktop;delete window.cardbushDesktop;
      window.mediaMessage={id:'media',conversationId:'media',turnId:'media',role:'assistant',status:'completed',metadata:{transcript_kind:'assistant_final'},createdAt:'2026-09-18T00:00:00Z',
      content:'![竖屏视频](<${videoPath}>)\\n\\n![音频](<${audioPath}>)'};
      renderView(h(views.MessageBubble,{message:mediaMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}));`);
    await until("document.querySelectorAll('.inline-media-frame.is-ready').length===2", 'Markdown uses the same media frames');
    assert.equal(await run("document.querySelector('video').videoHeight"), 320, 'Markdown local video also decodes');
    await run(`
      window.htmlReadySizes=[];window.htmlGeometry=[];
      window.previewObserver=new MutationObserver(()=>{const host=document.querySelector('.inline-html-preview'),viewport=host?.querySelector('.inline-html-viewport');if(viewport?.classList.contains('is-ready'))htmlReadySizes.push({viz:host.classList.contains('is-visualization'),height:viewport.clientHeight});});
      previewObserver.observe(document.getElementById('root'),{subtree:true,attributes:true,childList:true});
      mediaMessage={...mediaMessage,content:'![交互图表](<${chart}>)'};renderView(h(views.MessageBubble,{message:mediaMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}));
    `);
    await until("document.querySelector('.inline-html-viewport.is-ready')!==null", 'HTML ready after first measured layout');
    const readySizes = await run('htmlReadySizes');
    assert.ok(readySizes.length > 0);
    assert.equal(readySizes[0].viz, true, 'do not reveal the legacy file layout first');
    assert.equal(readySizes[0].height, 340, 'theme/mode/initial chart height appear atomically');
    await pause(360);
    assert.ok((await run('htmlReadySizes')).every(size => size.height === 340), 'initial measurements do not visibly bounce');
    await run('previewObserver.disconnect()');

    await window.webContents.insertCSS(await fs.readFile(path.join(root, 'src/styles/themes/cyberpunk.css'), 'utf8'));
    for (const theme of ['theme-bright', 'theme-dark', 'theme-dark theme-cyberpunk']) {
      await run(`viewTheme=${JSON.stringify(theme)};renderView(h(views.MessageBubble,{message:mediaMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}));`);
      await pause(160);
      assert.equal(await run("document.querySelector('.inline-html-viewport').clientHeight"), 340);
      await fs.writeFile(path.join(parent, `media-reveal-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }

    // A loaded page with an unavailable bridge must still become usable.
    const fallback = path.join(directory, 'fallback.html').replaceAll('\\', '/');
    await fs.writeFile(fallback, `<meta name="cardbush:preview" content="visualization"><p>Loaded document</p>
      <script>Object.defineProperty(window,'__cardbushInlinePresentation',{get:()=>({read:()=>null,dispose:()=>{}}),set:()=>{}})</script>`);
    await run(`renderView(h(views.MessageBubble,{key:'fallback',message:{...mediaMessage,content:'![页面](<${fallback}>)'},language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}));`);
    await until("document.querySelector('.inline-html-viewport.is-ready')!==null", 'unavailable presentation bridge falls back');
    assert.equal(await run("document.querySelector('.inline-html-preview').classList.contains('is-visualization')"), false);

    // A passive follow target that shrinks must not reverse an active scroll.
    await run(`renderView(h('div',{id:'motion-fixture',style:{height:220,width:600,overflowY:'auto'}},h('div',{style:{height:2400}},'test')));`);
    await until("document.querySelector('#motion-fixture')!==null", 'follow fixture');
    await run(`window.motion=views.createChatScrollMotion();window.motionList=document.querySelector('#motion-fixture');motionList.scrollTop=300;
      window.followTarget=900;window.followSamples=[];window.followSample=()=>{followSamples.push(motionList.scrollTop);window.followFrame=requestAnimationFrame(followSample)};followSample();motion.move(motionList,()=>followTarget,'follow');`);
    await pause(65);
    await run("followTarget=200;motion.move(motionList,()=>followTarget,'follow')");
    await pause(220);
    const samples = await run('cancelAnimationFrame(followFrame);followSamples');
    assert.ok(samples.slice(1).every((value, i) => value >= samples[i] - 1), 'metadata correction cannot animate backward');
    await run("motion.move(motionList,100,'jump')"); await pause(400);
    assert.ok(Math.abs(await run('motionList.scrollTop') - 100) < 1, 'explicit upward navigation still works');

    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await run(`renderView(h(views.InlineVideo,{src:${JSON.stringify(videoSource)}}))`);
    await until("document.querySelector('.inline-media-frame.is-ready')!==null", 'reduced-motion media ready');
    assert.equal(await run("getComputedStyle(document.querySelector('video')).animationName"), 'none');
    window.webContents.debugger.detach();
    console.log('Media reveal passed: real portrait video/audio, stable loading geometry, paint-only reveal, no remount on rerender, Markdown embeds, atomic HTML readiness, unavailable bridge fallback, 3 themes, no reversed passive follow, reduced motion.');
  } finally {
    await run('window.motion?.cancel();window.previewObserver?.disconnect();cancelAnimationFrame(window.mediaSampleFrame);cancelAnimationFrame(window.followFrame);renderView(null);if(window.mediaSavedDesktop)window.cardbushDesktop=window.mediaSavedDesktop;void 0');
    await pause(120);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.ok(path.basename(directory).startsWith('media-reveal-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
