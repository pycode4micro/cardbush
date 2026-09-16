const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync, readFileSync, existsSync } = require('node:fs');
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
if (process.env.CI === 'true' && process.platform === 'linux') app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1600, height: 1050,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/.test(details.url);
    if (external) errors.push('Unexpected network request: ' + details.url);
    done({ cancel: external });
  });
  const read = script => window.webContents.executeJavaScript(script);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async script => {
    const end = Date.now() + 8000;
    while (!await read(script)) {
      if (Date.now() > end) throw Error(`Timed out: ${script}`);
      await pause(20);
    }
  };
  const lane = mode => `[data-lane="${mode}"]`;
  const results = [];
  try {
    await window.loadFile(join(process.argv[2], 'index.html'), { query: { synthetic: '1' } });
    await until('Boolean(window.streamingLab)');
    await until('document.querySelectorAll(".message-list").length === 2');
    await read('window.streamingLab.step(); void 0');
    await until(`document.querySelector('${lane('frame')} .message-list').textContent.includes('流式探针')`);
    assert.equal(await read(`document.querySelector('${lane('baseline')} .message-list').textContent.includes('流式探针')`), false,
      'the lab uses real ChatPanel: experimental text paints while baseline still waits for segment completion');
    assert.equal(await read(`document.querySelectorAll('${lane('frame')} .assistant-changed-files-summary').length`), 0);
    await pause(400);
    assert.equal(await read(`(() => {
      const list=document.querySelector('${lane('frame')} .message-list');
      const paragraph=list.querySelector('.markdown-content p');
      const rect=paragraph.getBoundingClientRect(), viewport=list.getBoundingClientRect();
      return rect.bottom>viewport.top && rect.top<viewport.bottom && rect.height>0;
    })()`), true, 'first text is in the visible viewport, not just present in the DOM');
    writeFileSync(resolve('tmp/streaming-lab-first-delta.png'), (await window.webContents.capturePage()).toPNG());

    for (const scenario of ['complete', 'guidance', 'stop', 'failed', 'long']) {
      await read(`window.streamingLab.reset('${scenario}'); void 0`);
      await until(`window.streamingLab.state().index === 0 && document.querySelector('select[aria-label="测试场景"]').value === '${scenario}'`);
      if (scenario === 'guidance') {
        await read(`while(window.streamingLab.state().nextEvent !== 'terminal') window.streamingLab.step(); void 0`);
        await until(`document.querySelectorAll('${lane('frame')} .loop-subagent-preview').length === 1`);
        assert.equal(await read(`document.querySelectorAll('${lane('frame')} .loop-image-preview').length`), 1);
        assert.equal(await read(`document.querySelectorAll('${lane('frame')} .assistant-changed-files-summary').length`), 0,
          'guidance plus active text must not expose a changed-files summary');
        await pause(300);
        writeFileSync(resolve('tmp/streaming-lab-previews.png'), (await window.webContents.capturePage()).toPNG());
      }
      if (scenario === 'long') {
        await read(`for(let i=0;i<20;i++) window.streamingLab.step(); void 0`);
        await until(`document.querySelector('${lane('frame')} .message-list').scrollHeight > 3000`);
        await pause(300);
        await read(`window.labList=document.querySelector('${lane('frame')} .message-list');
          labList.dispatchEvent(new WheelEvent('wheel',{deltaY:-300,bubbles:true,cancelable:true})); labList.scrollTop=900;`);
        await pause(100);
        const top = await read('labList.scrollTop');
        await read(`for(let i=0;i<20;i++) window.streamingLab.step(); void 0`);
        await pause(600);
        assert.ok(Math.abs(await read('labList.scrollTop') - top) < 5, 'streamed Markdown does not pull a reader away from history');
        await read(`document.querySelector('${lane('frame')} .scroll-bottom').click()`);
        await until(`labList.scrollTop > ${top + 100}`);
      }
      await read('window.streamingLab.finish(); void 0');
      await until('!window.streamingLab.state().baseline.active && !window.streamingLab.state().frame.active');
      await until('window.streamingLab.state().equal');
      await until(`document.querySelector('[data-testid="streaming-lab-result"]').textContent.includes('最终消息与工具状态一致')`);
      await pause(150);
      const state = await read('window.streamingLab.state()');
      assert.equal(state.index, state.total);
      const result = { scenario, equal: state.equal, baselineCommits: state.baseline.commits, frameCommits: state.frame.commits, renders: state.renders };
      results.push(result);
      assert.doesNotMatch(await read('document.body.innerText'), /<subagent_result/);
      if (scenario === 'guidance') {
        assert.equal(await read(`document.querySelectorAll('${lane('frame')} .message-list-item[data-message-id="lab-guidance"]').length`), 1);
        writeFileSync(resolve('tmp/streaming-lab-completed.png'), (await window.webContents.capturePage()).toPNG());
      }
      if (scenario === 'complete' || scenario === 'stop') {
        await until(`document.querySelectorAll('${lane('frame')} .assistant-changed-files-summary').length > 0`);
      }
      if (scenario === 'long') {
        await until(`document.querySelector('${lane('frame')} .message-list').scrollHeight > 3000`);
        await read(`const list = document.querySelector('${lane('frame')} .message-list');
          list.dispatchEvent(new WheelEvent('wheel', {deltaY:-300,bubbles:true,cancelable:true})); list.scrollTop=900;`);
        await pause(150);
        const before = await read(`document.querySelector('${lane('frame')} .message-list').scrollTop`);
        await read(`document.querySelector('.streaming-lab-actions button:last-child').click()`);
        await pause(150);
        const after = await read(`document.querySelector('${lane('frame')} .message-list').scrollTop`);
        assert.ok(Math.abs(before - after) < 5, 'theme changes preserve the history reading position');
      }
    }
    const historyFile = join(process.argv[2], 'history.json');
    if (existsSync(historyFile)) {
      const history = JSON.parse(readFileSync(historyFile, 'utf8'));
      await read(`window.streamingLab.loadHistory(${JSON.stringify(history.cases)}); void 0`);
      await until(`document.querySelectorAll('optgroup[label="本机真实历史"] option').length === ${history.cases.length}`);
      const burstResults = [];
      for (const fixture of history.cases) {
        if (fixture.source.guidance) {
          await read(`window.streamingLab.reset(${JSON.stringify(fixture.id)}); void 0`);
          await until(`window.streamingLab.state().scenario === ${JSON.stringify(fixture.id)} && window.streamingLab.state().index === 0`);
          await read(`while(window.streamingLab.state().nextEvent && window.streamingLab.state().nextEvent !== 'terminal') window.streamingLab.step(); void 0`);
          await pause(200);
          await read('window.streamingLab.finish().then(() => undefined)');
          const paths = await read('window.streamingLab.differences()');
          assert.deepEqual(paths, [], 'instant injection must settle archived statuses as well as text and tools');
          burstResults.push({ id: fixture.id, equal: paths.length === 0, fields: [...new Set(paths.map(path => path.split('/').at(-1)))], count: paths.length });
        }
        await read(`window.streamingLab.reset(${JSON.stringify(fixture.id)}); void 0`);
        await until(`window.streamingLab.state().scenario === ${JSON.stringify(fixture.id)} && window.streamingLab.state().index === 0`);
        await read('window.streamingLab.finish(true).then(() => undefined)');
        await pause(200);
        assert.equal(await read(`document.querySelectorAll('${lane('frame')} .assistant-changed-files-summary').length`), 0,
          'real history must not render a terminal change summary before the terminal event');
        if (fixture.source.subagents) {
          await until(`document.querySelectorAll('${lane('frame')} .loop-subagent-preview').length > 0`);
        }
        if (fixture.source.guidance) {
          const guidance = fixture.events.find(item => item.event.kind === 'guidance').event.message;
          assert.equal(await read(`document.querySelectorAll('${lane('frame')} [data-message-id="${guidance.id}"]').length`), 1);
        }
        await read('window.streamingLab.finish(); void 0');
        await until('!window.streamingLab.state().baseline.active && !window.streamingLab.state().frame.active && window.streamingLab.state().equal');
        await pause(200);
        assert.doesNotMatch(await read('document.body.innerText'), /<subagent_result/);
        const state = await read('window.streamingLab.state()');
        const expected = fixture.events.find(item => item.event.kind === 'snapshot')?.event.messages.filter(message => message.role === 'assistant').at(-1);
        if (expected) {
          // Check final prose in actual rendered DOM in addition to state parity.
          const excerpt = expected.content.replace(/^#+\s*/gm, '').split('\n').find(line => line.length > 10).slice(0, 16).replaceAll('*', '');
          assert.ok((await read(`document.querySelector('${lane('frame')} .message-list').innerText`)).includes(excerpt));
        }
        results.push({ scenario: fixture.id, realHistory: true, equal: state.equal,
          subagents: fixture.source.subagents, guidance: fixture.source.guidance, renders: state.renders });
      }
      writeFileSync(resolve('tmp/streaming-lab-burst-results.json'), JSON.stringify(burstResults, null, 2));
    }
    assert.deepEqual(errors, []);
    writeFileSync(resolve('tmp/streaming-lab-ui-results.json'), JSON.stringify(results, null, 2));
    console.log(`Streaming lab UI passed: real ChatPanel, early visible text, ${results.length} final-state comparisons, real-history previews, history scroll and themes.`);
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(error); console.error(errors);
    writeFileSync(resolve('tmp/streaming-lab-failed-state.json'), JSON.stringify(await read('window.streamingLab?.state()')));
    writeFileSync(resolve('tmp/streaming-lab-failed.png'), (await window.webContents.capturePage()).toPNG());
    window.destroy(); app.exit(1);
  }
});
