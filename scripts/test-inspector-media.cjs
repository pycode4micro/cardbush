const { readSourceFile } = require('./helpers/read-source-file.cjs');
// Real React + Chromium media decoding with the production local resource handler.
// Isolated window/profile; optional argv[3] is a read-only real-world video fixture.
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const scratch = process.argv[2];
app.setPath('userData', path.join(scratch, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
} }]);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const load = (file, dependencies = {}) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compile(readSourceFile(path.join(root, file), 'utf8')))(name => dependencies[name] ?? require(name), module, module.exports);
  return module.exports;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
app.whenReady().then(async () => {
  // Extract actual functions without booting the user's runtime or main window.
  const main = readSourceFile(path.join(root, 'electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const names = ['registerLocalFileProtocol', 'normalizeShellPath', 'localPathFromProtocolUrl',
    'contentTypeForPath', 'imageMimeTypeForPath', 'audioMimeTypeForPath', 'videoMimeTypeForPath',
    'byteRangeFromHeader', 'contentTypeForBytes'];
  const funcs = names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    return node.getText(ast);
  }).join('\n');
  const deps = { fs, path, protocol, localPath: require('@cardbush/platform').localPath, localFileProtocol: 'cardbush-file',
    ...load('electron/localFileProtocol.ts'), ...load('electron/fileRead.ts'), ...load('electron/localFileStream.ts'),
    ...load('electron/localResourcePath.ts', { './localFileProtocol': load('electron/localFileProtocol.ts') }) };
  new Function(...Object.keys(deps), compile(funcs) + '\nregisterLocalFileProtocol();')(...Object.values(deps));
  const window = new BrowserWindow({ show: false, width: 600, height: 720,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, offscreen: true, webviewTag: true } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message);
  });
  const run = code => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code, label) => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(50); }
    throw new Error('Timed out: ' + label);
  };
  try {
    await window.loadFile(path.join(scratch, 'app/index.html'));
    await waitFor('Boolean(window.openMedia)', 'mount');
    assert.equal(await run('targets.inspectorMediaTarget("https://example.com/video.mp4")'), null, 'web URLs retain browser navigation');
    for (const target of ['C:/fixture/test.mov', 'file:///C:/fixture/test.mov', 'cardbush-file:///C:/fixture/test.mov', 'cardbush-file://c/fixture/test.mov']) {
      assert.equal(await run(`targets.inspectorMediaTarget(${JSON.stringify(target)})?.kind`), 'video');
    }
    for (const extension of ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'ts', 'json']) {
      const expected = /^(docx?|xlsx?|pptx?)$/.test(extension) ? 'office-preview' : 'text-preview';
      const rawPath = `C:/中文/report #1.${extension}`;
      const result = await run(`targets.inspectorSource(${JSON.stringify('cardbush-file:///C:/中文/report%20%231.' + extension)})`);
      assert.equal(new URL(result).hostname, expected, extension + ' chooses its renderer for protocol links');
      assert.equal(new URL(result).searchParams.get('path').replaceAll('\\', '/'), rawPath);
    }
    for (const extension of ['zip', 'unknownfuture']) {
      assert.equal(await run(`targets.inspectorSource('cardbush-file:///C:/中文/report%20%231.${extension}')`), 'about:blank', 'unknown formats have no guest navigation source');
    }
    assert.equal(await run('targets.isMarkdownInspectorTarget("C:/文档/notes #1.md")'), true);
    assert.equal(await run('targets.inspectorMediaTarget("C:/文档/image.png#notes.md")'), null, 'local fragment-like name retains its actual extension');
    for (const extension of ['avif', 'apng']) {
      assert.equal(await run(`targets.inspectorMediaTarget('C:/fixture/image.${extension}')?.kind`), 'image');
    }
    assert.equal(await run('targets.inspectorMediaTarget("cardbush-file://server/share/test.mp4").path'), '\\\\server\\share\\test.mp4');
    const open = async (file, selector) => {
      await run(`openMedia(${JSON.stringify(file)})`);
      await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && nav?.url === ${JSON.stringify(file)} && nav.loading === false && !document.querySelector('.right-inspector-preview-loading')`, file);
      assert.equal(await run('Boolean(document.querySelector("webview"))'), false, 'local media bypasses webview');
      assert.equal(await run('Boolean(document.querySelector(".right-inspector-preview-loading"))'), false);
    };
    await run(`window.invalidPreviewReads=[];window.cardbushDesktop={...window.cardbushDesktop,readTextPreview:async path=>{invalidPreviewReads.push(path);throw Error('Unexpected read');}};void 0;`);
    for (const target of ['cardbush-source:13-74679519b39c20e4','unknown:photo.png','unknown:voice.mp3','unknown:clip.mp4','unknown:report.md','unknown:report.pdf','unknown:document.docx','unknown:page.html']) {
      assert.equal(await run(`targets.inspectorSource(${JSON.stringify(target)})`), 'about:blank');
      await open(target, '.inspector-file-fallback');
      assert.equal(await run('document.querySelectorAll("img,video,audio,webview,.inspector-open-external").length'), 0);
      assert.match(await run('document.querySelector(".inspector-file-fallback").textContent'), /资源地址不可用/);
    }
    assert.deepEqual(await run('window.invalidPreviewReads'), [], 'unsupported resources cannot reach a text/file reader');
    const imageFile = path.join(scratch, '中文 空格 # 图.png');
    fs.writeFileSync(imageFile, png);
    await open(imageFile, 'img');
    assert.equal(await run('document.querySelector("img").naturalWidth'), 1);
    assert.equal(await run('document.querySelector("img").src.startsWith("cardbush-file:")'), true);
    await run('handle.current.reload()');
    await waitFor('nav.loading === false && document.querySelector("img").naturalWidth === 1', 'reload cached image');
    for (const extension of ['avif', 'apng']) {
      const fixture = path.join(root, `scripts/fixtures/inspector-media.${extension}`);
      await open(fixture, 'img');
      assert.equal(await run('document.querySelector("img").naturalWidth'), 16, extension + ' decoded by Chromium');
    }
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
    const audioFile = path.join(scratch, '音频.wav'); fs.writeFileSync(audioFile, wav);
    await open(audioFile, 'audio');
    assert.equal(await run('document.querySelector("audio").duration'), 1);
    assert.equal(await run('document.querySelector("audio").paused'), true, 'no autoplay');
    // One second of alternating solid colors, VP8, 160x90 at 10 fps.
    const videoFile = path.join(scratch, '视频.webm');
    fs.copyFileSync(path.join(root, 'scripts/fixtures/inspector-media.webm'), videoFile);
    await open(videoFile, 'video');
    assert.equal(await run('document.querySelector("video").videoWidth'), 160,
      JSON.stringify(await run('({state:document.querySelector("video").readyState,error:document.querySelector("video").error?.message,alert:document.querySelector("[role=alert]")?.textContent})')));
    await run('window.oldVideo=document.querySelector("video");oldVideo.muted=true;oldVideo.play()');
    await waitFor('oldVideo.currentTime > 0', 'video plays');
    await open(imageFile, 'img');
    assert.equal(await run('oldVideo.paused'), true, 'switch stops old playback');
    // Nonexistent file leaves loading and can recover after the file appears.
    const missing = path.join(scratch, '稍后生成.png');
    await open(missing, '[role="alert"]');
    fs.writeFileSync(missing, png);
    await run('document.querySelector(".inspector-media-error button").click()');
    await waitFor('nav.loading === false && !document.querySelector("[role=alert]") && document.querySelector("img").naturalWidth === 1', 'retry recovers');
    const broken = path.join(scratch, '损坏.mp4'); fs.writeFileSync(broken, 'not a video');
    await open(broken, '[role="alert"]');
    // Exercise timeout deterministically without waiting 15 seconds or hanging a network request.
    await run(`window.realTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms===15000?50:ms,...args);
      window.blockReady=e=>e.stopImmediatePropagation();document.addEventListener('loadedmetadata',blockReady,true);`);
    await run(`openMedia(${JSON.stringify(videoFile)})`);
    await waitFor('document.querySelector("[role=alert]")?.textContent.includes("超时") && nav.loading === false', 'bounded loading');
    await run(`document.removeEventListener('loadedmetadata',blockReady,true);window.setTimeout=realTimeout;void 0;`);
    if (process.argv[3]) {
      await open(path.resolve(process.argv[3]), 'video');
      assert.ok(await run('document.querySelector("video").videoWidth > 0 && !document.querySelector("[role=alert]")'));
      await run('window.clip=document.querySelector("video");clip.muted=true;clip.play()');
      await waitFor('clip.currentTime > 0.1', 'real MP4 playback');
      await run('clip.pause();clip.currentTime=8');
      await waitFor('!clip.seeking && Math.abs(clip.currentTime-8)<0.2', 'real MP4 seek');
      assert.equal(await run('(()=>{const r=clip.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;})()'), true, 'media fits narrow inspector');
      console.log('Real MP4 decoded, played and sought successfully.');
    }
    fs.writeFileSync(path.join(root, 'tmp/inspector-media-preview.png'), (await window.webContents.capturePage()).toPNG());
    const htmlFile = path.join(scratch, '网页 #1.html');
    fs.writeFileSync(htmlFile, '<!doctype html><h1>Local HTML ready</h1>');
    await run(`openMedia(${JSON.stringify(htmlFile)})`);
    await waitFor('nav.url?.startsWith("file:") && !nav.loading && !!document.querySelector("webview")', 'local HTML guest ready');
    assert.equal(await run('document.querySelector("webview").executeJavaScript("document.querySelector(\'h1\').textContent")'), 'Local HTML ready');
    const missingHtml = path.join(scratch, 'missing.html');
    await run(`openMedia(${JSON.stringify(missingHtml)})`);
    await waitFor('!!document.querySelector(".inspector-preview-error") && nav.loading === false', 'missing HTML fails visibly');
    fs.writeFileSync(missingHtml, '<!doctype html><h1>Retry ready</h1>');
    await run('document.querySelector(".inspector-preview-error button").click()');
    await waitFor('!document.querySelector(".inspector-preview-error") && !nav.loading && document.querySelector("webview")?.getURL()?.includes("missing.html")', 'retry remounts failed guest');
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 200]).drawText('Inspector PDF fixture', { x: 20, y: 150, size: 16 });
    pdf.addPage([300, 400]);
    const pdfFile = path.join(scratch, 'PDF #1.pdf');
    fs.writeFileSync(pdfFile, await pdf.save());
    const pdfPage = '[data-region-page="1"]:not([data-region-loading])';
    await open(pdfFile, pdfPage + ' canvas');
    assert.ok(await run(`document.querySelector('${pdfPage} canvas').width > 0`));
    assert.match(await run(`document.querySelector('${pdfPage} .pdf-region-text').textContent`), /Inspector PDF fixture/);
    const pdfLayout = () => run(`(() => {
      const preview = document.querySelector('.inspector-pdf-preview');
      const page = preview.querySelector('[data-region-page="1"]').getBoundingClientRect();
      const left = page.left - preview.getBoundingClientRect().left - preview.clientLeft;
      return { left, right: preview.clientWidth - left - page.width, overflow: preview.scrollWidth - preview.clientWidth,
        background: getComputedStyle(preview).backgroundColor,
        surface: getComputedStyle(preview.closest('.right-inspector-preview')).backgroundColor };
    })()`);
    for (const theme of ['theme-bright', 'theme-dark']) {
      await run(`document.querySelector('.app').className = 'app ${theme}'`);
      const layout = await pdfLayout();
      assert.equal(layout.background, layout.surface, `${theme} PDF margins use the inspector surface`);
      assert.ok(Math.abs(layout.left) < 1 && Math.abs(layout.right) < 1 && layout.overflow === 0,
        `fit-width PDF reaches both edges: ${JSON.stringify(layout)}`);
    }
    window.setContentSize(410, 460);
    await waitFor(`(() => {
      const scroller = document.querySelector('.inspector-pdf-preview');
      const page = scroller.querySelector('${pdfPage}');
      return scroller.clientWidth < 410 && page && Math.abs(page.getBoundingClientRect().width - scroller.clientWidth) < 1;
    })()`, 'fit-width PDF resizes to a narrow inspector with a scrollbar');
    await run("document.querySelector('.inspector-pdf-toolbar button:last-of-type').click()");
    await waitFor("document.querySelector('.inspector-pdf-preview').scrollWidth > document.querySelector('.inspector-pdf-preview').clientWidth", 'zoomed pages can scroll horizontally');
    await run("document.querySelector('.inspector-pdf-toolbar button:nth-of-type(2)').click()");
    await waitFor("document.querySelector('.inspector-pdf-preview').scrollWidth === document.querySelector('.inspector-pdf-preview').clientWidth", 'fit width removes horizontal overflow');
    fs.writeFileSync(path.join(root, 'tmp/inspector-pdf-preview.png'), (await window.webContents.capturePage()).toPNG());
    // A server that never sends headers reproduces a missing load-completion event.
    let servePage = false;
    const server = require('node:http').createServer((_request, response) => {
      if (servePage) { response.setHeader('content-type', 'text/html'); response.end('<h1>Recovered</h1>'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(`window.savedTimeout=window.setTimeout;window.setTimeout=(fn,ms,...args)=>savedTimeout(fn,ms===30000?300:ms,...args);void 0;`);
      await run(`openMedia('http://127.0.0.1:${server.address().port}/hang')`);
      await waitFor('!!document.querySelector(".inspector-preview-error") && nav.loading === false', 'webview timeout ends skeleton');
      servePage = true;
      await run('window.setTimeout=savedTimeout;document.querySelector(".inspector-preview-error button").click()');
      await waitFor('!document.querySelector(".inspector-preview-error") && nav.loading === false && nav.url?.includes("/hang")', 'webview timeout retry');
      assert.equal(await run('document.querySelector("webview").executeJavaScript("document.querySelector(\'h1\').textContent")'), 'Recovered');
    } finally { server.closeAllConnections(); server.close(); }
    console.log('File routing matrix, HTML load/failure/retry and PDF.js canvas/text preview passed.');
    console.log('Inspector media: image/audio/video, Chinese paths, reload, play, switch, missing/corrupt file, retry and timeout passed.');
  } finally { window.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
