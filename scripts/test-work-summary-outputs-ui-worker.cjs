const { app, BrowserWindow, protocol, net } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  protocol.handle('cardbush-file', request => {
    const file = decodeURIComponent(new URL(request.url).pathname).replace(/^\/(?=[a-z]:\/)/i, '');
    return net.fetch(pathToFileURL(file).href);
  });
  const window = new BrowserWindow({ show: false, width: 1000, height: 720,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const run = code => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code, label) => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(50); }
    throw Error('Timed out: ' + label + '\n' + errors.join('\n'));
  };
  let server;
  try {
    await window.loadFile(path.join(directory, 'index.html'));
    await waitFor('Boolean(window.mountFixture)', 'fixture mount');
    const image = await run(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#26364f'; ctx.fillRect(0,0,320,180);
      ctx.fillStyle = '#f4c583'; ctx.font = '24px sans-serif'; ctx.fillText('CardBush',90,95);
      return canvas.toDataURL('image/png');
    })()`);
    const audio = Buffer.alloc(44 + 16000);
    audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(16000, 40);
    const makeArtifact = (name, data, type) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, data);
      return { id: name, name, path: file, type };
    };
    const video = fs.readFileSync(path.resolve('scripts/fixtures/inspector-media.webm'));
    const artifacts = [makeArtifact('成片 #1.webm', video, 'video'), makeArtifact('配音.wav', audio, 'audio'),
      makeArtifact('封面.png', Buffer.from(image.split(',')[1], 'base64'), 'image')];
    await run(`window.fixtureArtifacts = ${JSON.stringify(artifacts)}; mountFixture({artifacts:fixtureArtifacts})`);
    await waitFor('document.querySelectorAll(".work-summary-file-list button").length === 5', 'five recent outputs');
    assert.match(await run('document.querySelector(".work-summary-metrics").textContent'), /7 产物/);
    const clickFile = async name => {
      await run(`Array.from(document.querySelectorAll('.work-summary-file-list button')).find(button => button.querySelector('.work-summary-file-name').textContent === ${JSON.stringify(name)}).click()`);
    };
    for (const [name, selector] of [['成片 #1.webm', 'video'], ['配音.wav', 'audio'], ['封面.png', 'img']]) {
      await clickFile(name);
      await waitFor(`Boolean(document.querySelector('.inspector-media-preview ${selector}')) && !window.navigation?.loading`, name + ' decoded');
      assert.equal(await run('Boolean(document.querySelector(".inspector-media-error, webview"))'), false,
        JSON.stringify(await run(`({name:${JSON.stringify(name)}, error:document.querySelector('.inspector-media-error')?.textContent,
          media:document.querySelector('video,audio')?.error?.message, src:document.querySelector('video,audio,img')?.getAttribute('src')})`)));
      if (selector !== 'img') {
        assert.equal(await run(`document.querySelector('${selector}').controls`), true);
        assert.equal(await run(`document.querySelector('${selector}').paused`), true, 'no autoplay');
        await run(`window.previousMedia = document.querySelector('${selector}'); previousMedia.muted = true; previousMedia.play()`);
        assert.equal(await run('previousMedia.paused'), false, 'media can actually play');
        await clickFile('封面.png');
        await waitFor('previousMedia.paused', 'playback stops when preview changes');
      }
    }
    await run('document.querySelector(".work-summary-output-actions button[aria-expanded]").click()');
    await waitFor('document.querySelectorAll(".work-summary-file-list button").length === 7', 'expand earlier outputs');
    assert.equal(await run('document.querySelector(".work-summary-file-list .python").textContent'), 'PY');
    assert.equal(await run('getComputedStyle(document.querySelector(".work-summary-file-list .python")).fontSize'), '6px', 'file labels must not override icon badge styling');
    await clickFile('prep_refs.py');
    assert.equal(await run('reviewRequests.at(-1)'), 'prep_refs.py');
    await run('Array.from(document.querySelectorAll(".work-summary-output-actions button")).find(button=>button.textContent.includes("全部更改")).click()');
    assert.equal(await run('reviewRequests.at(-1)'), '*');
    for (const theme of ['bright', 'dark']) {
      await run(`mountFixture({artifacts:fixtureArtifacts, theme:${JSON.stringify(theme)}})`);
      await pause(100);
      const layout = await run(`Array.from(document.querySelectorAll('.work-summary-file-list button')).map(button => {
        const icon = button.querySelector('.local-file-type-icon').getBoundingClientRect(), text = button.querySelector('.work-summary-file-name').getBoundingClientRect();
        return {width:icon.width, gap:text.left-icon.right, fits:button.scrollWidth<=button.clientWidth+1};
      })`);
      assert.ok(layout.every(row => row.width === 14 && row.gap >= 8 && row.fits), JSON.stringify(layout));
      fs.writeFileSync(path.resolve('tmp', `work-summary-outputs-${theme}.png`), (await window.webContents.capturePage()).toPNG());
    }
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': video.length }); response.end(video);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const remote = `http://127.0.0.1:${server.address().port}/download?signature=ABC`;
    const inline = 'data:audio/wav;base64,' + audio.toString('base64');
    await run(`mountFixture({artifacts:${JSON.stringify([
      { id: 'remote', name: '远程成片.webm', type: 'video', path: remote },
      { id: 'inline', name: '内嵌配音.wav', type: 'audio', path: inline },
    ])}})`);
    await waitFor('document.querySelector(".work-summary-file-list").textContent.includes("内嵌配音")', 'remote and inline outputs');
    for (const [name, selector] of [['远程成片.webm', 'video'], ['内嵌配音.wav', 'audio']]) {
      await clickFile(name);
      await waitFor(`document.querySelector('.inspector-media-preview ${selector}')?.readyState >= 1 && !window.navigation?.loading`, name);
      assert.equal(await run('Boolean(document.querySelector("webview"))'), false, 'explicit media uses its player, not a browser guest');
      assert.equal(await run('window.navigation.title'), name);
    }
    await run('mountFixture({artifacts:[],sessionId:"empty",language:"en"})');
    await waitFor('document.querySelector(".work-summary-empty")?.textContent === "No outputs yet"', 'session switch');
    assert.equal(await run('document.querySelectorAll(".work-summary-file-list button").length'), 0);
    await run('unmountFixture()');
    assert.deepEqual(errors, []);
    console.log('Work summary output icons, light/dark layout, review navigation, local/remote/inline media playback and session reset passed.');
  } finally {
    window.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
