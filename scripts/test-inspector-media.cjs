// Real React + Chromium media decoding with the production local resource handler.
// Isolated window/profile; optional argv[2] is a read-only real-world video fixture.
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, 'tmp', 'inspector-media-'));
app.setPath('userData', path.join(scratch, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const load = (file) => {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compile(fs.readFileSync(path.join(root, file), 'utf8')))(require, module, module.exports);
  return module.exports;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');
app.whenReady().then(async () => {
  // Extract actual functions without booting the user's runtime or main window.
  const main = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
  const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const names = ['registerLocalFileProtocol', 'normalizeShellPath', 'localPathFromProtocolUrl',
    'contentTypeForPath', 'imageMimeTypeForPath', 'audioMimeTypeForPath', 'videoMimeTypeForPath',
    'byteRangeFromHeader', 'contentTypeForBytes'];
  const funcs = names.map(name => {
    const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(node, name);
    return node.getText(ast);
  }).join('\n');
  const deps = { fs, path, protocol, localFileProtocol: 'cardbush-file',
    ...load('electron/localFileProtocol.ts'), ...load('electron/fileRead.ts') };
  new Function(...Object.keys(deps), compile(funcs) + '\nregisterLocalFileProtocol();')(...Object.values(deps));
  const window = new BrowserWindow({ show: false, width: 600, height: 720,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true, webviewTag: true } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message);
  });
  const run = code => window.webContents.executeJavaScript(code, true);
  const waitFor = async (code, label) => {
    for (let i = 0; i < 100; i++) { if (await run(code)) return; await pause(50); }
    throw new Error('Timed out: ' + label);
  };
  try {
    await window.loadURL('data:text/html,<html><body style="margin:0"><div class="app theme-dark" id="root" style="height:100vh;--surface:%23111517;--text:%23eeeeee;--muted:%23999999;--border:%23444444"></div></body></html>');
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8'));
    const modules = Object.fromEntries([
      'src/shared/localPaths.ts', 'src/shared/textPreview.ts',
      'src/shared/showUiError.ts',
      'src/shared/fileContextMenu.ts',
      'src/features/inspector/inspectorTargets.ts', 'src/features/inspector/InspectorWebview.tsx',
      'src/features/inspector/MediaInspectorPreview.tsx',
      'src/features/inspector/InspectorErrorBoundary.tsx', 'src/features/inspector/FilePreviewFallback.tsx',
      'src/features/inspector/TextInspectorPreview.tsx', 'src/features/inspector/filePreviewRegistry.ts',
      'src/features/inspector/inspectorFilePreviewRenderers.tsx',
    ].map(file => [path.join(root, file), compile(fs.readFileSync(path.join(root, file), 'utf8'))]));
    await run(`
      const React = require(${JSON.stringify(require.resolve('react'))});
      const {createRoot} = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const path = require('node:path');
      const nativeRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const sources = ${JSON.stringify(modules)};
      const cache = {};
      function load(file) {
        if(cache[file]) return cache[file].exports;
        const module = cache[file] = {exports:{}};
        function resolve(name) {
          if(name === '../chatMessages') return {}; // unrelated Markdown renderer
          if(!name.startsWith('.')) return nativeRequire(name);
          const base = path.resolve(path.dirname(file), name);
          const key = [base, base+'.ts', base+'.tsx'].find(key => sources[key]);
          if(!key) throw new Error('Unresolved '+name);
          return load(key);
        }
        new Function('require','module','exports',sources[file])(resolve,module,module.exports);
        return module.exports;
      }
      window.cardbushDesktop = {};
      window.nav = {loading: true};
      const {InspectorWebview} = load(${JSON.stringify(path.join(root, 'src/features/inspector/InspectorWebview.tsx'))});
      const targets = load(${JSON.stringify(path.join(root, 'src/features/inspector/inspectorTargets.ts'))});
      window.targets = targets;
      const h = React.createElement;
      const handle = React.createRef();
      const onNavigation = (_, state) => { window.nav = state; };
      const onOpen = () => {};
      function Harness() {
        const [target, setTarget] = React.useState('');
        window.openMedia = setTarget;
        return target ? h(InspectorWebview, {ref: handle, identity: 'fixture', target,
          source: targets.inspectorSource(target), language: 'zh',
          onNavigationStateChange: onNavigation, onOpenTarget: onOpen}) : null;
      }
      createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(Harness)));
    `);
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
    if (process.argv[2]) {
      await open(path.resolve(process.argv[2]), 'video');
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
    // Minimal valid one-page PDF; exercise Electron's native PDF document.
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += 'xref\n0 5\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
    pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pdfFile = path.join(scratch, 'PDF #1.pdf'); fs.writeFileSync(pdfFile, pdf);
    await run(`openMedia(${JSON.stringify(pdfFile)})`);
    await waitFor('!nav.loading && nav.url?.includes(".pdf") && !document.querySelector(".inspector-preview-error")', 'PDF readiness');
    await pause(1500);
    fs.writeFileSync(path.join(root, 'tmp/inspector-pdf-preview.png'), (await window.webContents.capturePage()).toPNG());
    const guest = require('electron').webContents.fromId(await run('document.querySelector("webview").getWebContentsId()'));
    const pdfFrame = guest.mainFrame.framesInSubtree.find(frame => frame.url.startsWith('chrome-extension:'));
    assert.ok(pdfFrame, 'PDF viewer frame exists');
    assert.equal(await pdfFrame.executeJavaScript('Boolean(document.querySelector("pdf-viewer"))'), true);
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
    console.log('File routing matrix, HTML load/failure/retry and native PDF passed.');
    console.log('Inspector media: image/audio/video, Chinese paths, reload, play, switch, missing/corrupt file, retry and timeout passed.');
  } finally { window.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
