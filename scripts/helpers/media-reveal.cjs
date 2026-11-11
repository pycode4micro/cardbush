const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
      window.mediaVideoSource=${JSON.stringify(videoSource)};
      window.mediaAudioSource=${JSON.stringify('data:audio/wav;base64,' + wav.toString('base64'))};
      window.mediaRender=()=>renderView(h('div',{className:'media-fixture',style:{width:620,padding:20}},
        h('h2',null,'音视频预览'),h(views.InlineVideo,{'aria-label':'竖屏视频',src:mediaVideoSource,preload:'none'}),h(views.InlineAudio,{'aria-label':'音频',src:mediaAudioSource,preload:'none'})));
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
      for(const media of mediaElements){media.preload='metadata';media.load();}
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

    await window.webContents.insertCSS(await fs.readFile(path.join(root, 'src/styles/appearance.css'), 'utf8'));
    for (const theme of ['theme-bright', 'theme-dark']) {
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
    const readySource = file => `document.querySelector('.inline-html-viewport.is-ready webview')?.getAttribute('src') === ${JSON.stringify(pathToFileURL(file).href)}`;
    await until(readySource(fallback), 'the replacement document is ready with its own fallback');
    assert.equal(await run("document.querySelector('.inline-html-preview').classList.contains('is-visualization')"), false);

    // Exercise the transcript that owns passive following while a real embed changes height.
    await run(`updateChat({activeConversationId:'media', loading:false, sending:true, activeTurnId:'active',
      messages:[
        {id:'history-user',role:'user',turnId:'media',content:'Show the chart'},
        {...mediaMessage,content:'History paragraph.\\n\\n'.repeat(40) + mediaMessage.content},
        {id:'active-user',role:'user',turnId:'active',content:'Continue'},
        {id:'active-output',role:'assistant',turnId:'active',content:'Checking the chart.'}
      ]})`);
    await until(readySource(chart), 'chart mounted in the conversation');
    await run(`window.list=document.querySelector('.message-list');
      window.bottomGap=()=>list.scrollHeight-list.clientHeight-list.scrollTop;
      window.viewport=document.querySelector('.inline-html-viewport');
      window.chartGuest=viewport.querySelector('webview');void 0;`);
    await until('list.scrollTop > 0 && Math.abs(bottomGap()) < 2', 'transcript following the latest output');
    const resizeChart = async height => {
      await run(`chartGuest.executeJavaScript("document.querySelector('section').style.height='${height}px'")`);
      await until(`viewport.clientHeight === ${height}`, 'embed resize reached the host');
    };
    await run(`window.followSamples=[];window.sampleFollow=()=>{
      followSamples.push(list.dataset.scrollAnimating || '');
      window.followFrame=requestAnimationFrame(sampleFollow)
    };sampleFollow()`);
    for (const height of [440, 300]) {
      await resizeChart(height);
      await until('Math.abs(bottomGap()) < 2', 'resized transcript remains at the bottom');
    }
    assert.ok((await run('cancelAnimationFrame(followFrame);followSamples')).every(motion => !motion),
      'growing and shrinking embeds never start a reverse scroll animation');
    await run(`list.dispatchEvent(new WheelEvent('wheel',{deltaY:-220,bubbles:true}));
      list.scrollTop-=220;window.readingTop=list.scrollTop`);
    await until('bottomGap() >= 210', 'upward navigation leaves the bottom');
    await resizeChart(390);
    await resizeChart(310);
    assert.ok(Math.abs(await run('list.scrollTop - readingTop')) < 2, 'resizing preserves the manual reading position');
    await run("document.querySelector('.scroll-bottom').click()");
    await until('Math.abs(bottomGap()) < 2', 'explicit navigation returns to the latest output');

    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await run(`renderView(h(views.InlineVideo,{src:${JSON.stringify(videoSource)}}))`);
    await until("document.querySelector('.inline-media-frame.is-ready')!==null", 'reduced-motion media ready');
    assert.equal(await run("getComputedStyle(document.querySelector('video')).animationName"), 'none');
    window.webContents.debugger.detach();
    console.log('Media reveal passed: real portrait video/audio, stable geometry, Markdown embeds, HTML readiness and fallback, light/dark themes, transcript follow and manual reading, reduced motion.');
  } finally {
    await run('window.previewObserver?.disconnect();cancelAnimationFrame(window.mediaSampleFrame);cancelAnimationFrame(window.followFrame);renderView(null);if(window.mediaSavedDesktop)window.cardbushDesktop=window.mediaSavedDesktop;void 0');
    await pause(120);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(parent));
    assert.ok(path.basename(directory).startsWith('media-reveal-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};
