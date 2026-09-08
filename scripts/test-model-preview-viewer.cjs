// Real sandboxed <webview>, production protocol/assets, real Blender in an isolated profile.
const { app, BrowserWindow, protocol, net, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const { ModelPreviewService, ModelPreviewError, findBlenderExecutable } = require('../dist-electron/modelPreview');
const scratch = path.resolve(process.argv[2]);
assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
assert.ok(path.basename(scratch).startsWith('cardbush-model-view-test-'));
app.setPath('userData', path.join(scratch, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

app.whenReady().then(async () => {
  let host;
  let getService = () => undefined;
  try {
    const executable = await findBlenderExecutable();
    if (executable) await promisify(execFile)(executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.join(root, 'scripts/fixtures/create-blender-preview-fixture.py'), '--', scratch], { windowsHide: true, timeout: 45000 });
    else fs.writeFileSync(path.join(scratch, 'scene.blend'), 'Dependency fallback fixture');
    const source = path.join(scratch, 'scene.blend');
    const sourceHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const main = ts.createSourceFile('main.ts', fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const names = ['registerLocalFileProtocol', 'normalizeShellPath', 'localPathFromProtocolUrl', 'contentTypeForPath',
      'imageMimeTypeForPath', 'audioMimeTypeForPath', 'videoMimeTypeForPath', 'byteRangeFromHeader', 'contentTypeForBytes', 'previewRendererAssetResponse'];
    const functions = names.map(name => {
      const node = main.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(node, name); return node.getText(main);
    }).join('\n');
    const deps = { fs, path, protocol, net, pathToFileURL, ModelPreviewError,
      app: { getAppPath: () => root }, devServerUrl: undefined, localFileProtocol: 'cardbush-file', __dirname: path.join(root, 'dist-electron'),
      ModelPreviewService: class extends ModelPreviewService { constructor(options) { super({ ...options, tempRoot: scratch }); } },
    };
    getService = new Function(...Object.keys(deps), compile('let modelPreviewService;\n' + functions) + '\nregisterLocalFileProtocol(); return () => modelPreviewService;')(...Object.values(deps));
    const errors = [];
    app.on('web-contents-created', (_, contents) => {
      contents.on('console-message', event => {
        if (event.level === 'error' && !/GL_INVALID|CONTEXT_LOST/.test(event.message)) errors.push(event.message);
      });
    });
    host = new BrowserWindow({ show: false, width: 800, height: 760, webPreferences: {
      sandbox: true, nodeIntegration: false, contextIsolation: true, webviewTag: true, backgroundThrottling: false,
    } });
    host.webContents.session.webRequest.onBeforeRequest((details, done) => {
      if (/^https?:/.test(details.url)) errors.push('Unexpected remote resource: ' + details.url);
      done({ cancel: /^https?:/.test(details.url) });
    });
    await host.loadURL('data:text/html,<body style="margin:0"><input id="draft" value="retained draft"><webview style="display:flex;height:720px;width:100%" webpreferences="sandbox=yes,contextIsolation=yes,nodeIntegration=no"></webview></body>');
    const hostRun = code => host.webContents.executeJavaScript(code);
    let guest;
    const until = async (check, label, limit = 1200) => {
      for (let i = 0; i < limit; i++) { if (await check()) return; await pause(25); }
      throw new Error('Timed out: ' + label + '\n' + (guest ? await guest.executeJavaScript('document.body.innerText').catch(() => '') : '') + '\n' + errors.join('\n'));
    };
    const open = async file => {
      await hostRun(`document.querySelector('webview').src = ${JSON.stringify('cardbush-file://model-preview/?path=' + encodeURIComponent(file))}; void 0`);
      await until(async () => { const id = await hostRun("document.querySelector('webview').getWebContentsId()").catch(() => 0); guest = webContents.fromId(id); return !!guest; }, 'preview guest');
      await until(() => guest.executeJavaScript("!!document.getElementById('retry')").catch(() => false), 'preview page');
    };
    const run = code => guest.executeJavaScript(code);
    process.env.CARDBUSH_BLENDER_PATH = path.join(scratch, 'not-installed.exe');
    await open(source);
    await until(() => run("!document.getElementById('error').hidden && document.getElementById('error').textContent.includes('Blender')"), 'missing dependency fallback');
    assert.equal(await run('typeof require'), 'undefined');
    assert.notEqual(guest.getOSProcessId(), host.webContents.getOSProcessId(), '3D viewer is isolated from the main renderer');
    if (executable) {
      process.env.CARDBUSH_BLENDER_PATH = executable;
      await run("document.getElementById('retry').click()");
      await until(() => run("!!document.querySelector('canvas') && document.getElementById('status').hidden && document.getElementById('error').hidden"), 'real Blender model ready');
      assert.equal(await run("document.querySelectorAll('#scenes option').length"), 2);
      assert.ok(await run("document.querySelectorAll('#objects input').length") >= 1);
      assert.equal(await run("document.getElementById('animation-controls').hidden"), false);
      const imageHash = async () => createHash('sha256').update((await guest.capturePage()).toPNG()).digest('hex');
      await pause(250);
      const initial = await imageHash();
      const bitmap = (await guest.capturePage()).toBitmap();
      let texturedPixels = 0;
      for (let i = 0; i < bitmap.length; i += 4) if (bitmap[i + 2] > 1.5 * bitmap[i + 1] && bitmap[i + 2] > 1.5 * bitmap[i]) texturedPixels++;
      assert.ok(texturedPixels > 100, 'packed color texture is visible in the rendered scene');
      await run("document.getElementById('wireframe').click()");
      await pause(150);
      assert.notEqual(await imageHash(), initial, 'wireframe changes the actual rendered scene');
      await run("document.getElementById('wireframe').click(); document.getElementById('play').click()");
      await until(async () => Number(await run("document.getElementById('timeline').value")) > 0.1, 'animation playback');
      await run("document.getElementById('play').click()");
      const stopped = await run("document.getElementById('timeline').value");
      await pause(150);
      assert.equal(await run("document.getElementById('timeline').value"), stopped, 'pause stops animation');
      await run("const slider = document.getElementById('timeline'); slider.value='0.2'; slider.dispatchEvent(new Event('input', {bubbles:true}));");
      assert.equal(await run("document.getElementById('time').textContent"), '0.20 s');
      const box = await run("(()=>{const r=document.querySelector('canvas').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
      const beforeOrbit = await imageHash();
      guest.sendInputEvent({ type: 'mouseMove', x: box.x, y: box.y });
      await pause(50);
      guest.sendInputEvent({ type: 'mouseDown', button: 'left', x: box.x, y: box.y, clickCount: 1 });
      await pause(50);
      guest.sendInputEvent({ type: 'mouseMove', x: box.x + 90, y: box.y + 35, modifiers: ['leftButtonDown'] });
      await pause(50);
      guest.sendInputEvent({ type: 'mouseUp', button: 'left', x: box.x + 90, y: box.y + 35 });
      await pause(180);
      const afterOrbit = await imageHash();
      assert.notEqual(afterOrbit, beforeOrbit, 'native pointer interaction orbits the model');
      const screenshot = path.join(root, 'tmp', 'blender-readonly-preview.png');
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      fs.writeFileSync(screenshot, (await guest.capturePage()).toPNG());
      await run("document.getElementById('scenes').value='Second scene'; document.getElementById('scenes').dispatchEvent(new Event('change'))");
      await until(() => run("document.getElementById('status').hidden && document.getElementById('summary').textContent.startsWith('1 个对象')"), 'scene switching');
      await run("document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context').loseContext(); void 0");
      await until(() => run("!document.getElementById('error').hidden && document.getElementById('error').textContent.includes('上下文')"), 'WebGL failure stays local');
      assert.equal(await hostRun("document.getElementById('draft').value"), 'retained draft', 'viewer failures do not reload the main application');
      await run("document.getElementById('retry').click()");
      await until(() => run("document.getElementById('error').hidden && document.getElementById('status').hidden"), 'local retry');
      assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'), sourceHash);
      assert.equal(fs.existsSync(path.join(scratch, 'embedded-script-ran')), false);
      await until(() => getService().resources.size === 0, 'temporary conversion released after loading');
      await run("document.getElementById('retry').click()");
      await until(() => getService().jobs.size === 1, 'conversion started before closing preview');
      await hostRun("document.querySelector('webview').src = 'about:blank'; void 0");
      await until(() => getService().jobs.size === 0, 'closing preview cancels conversion');
      assert.equal(getService().resources.size, 0, 'an abandoned conversion cannot publish an unused artifact');
    }
    assert.equal(await hostRun("document.getElementById('draft').value"), 'retained draft');
    assert.deepEqual(errors, [], 'no script/CSP errors or remote requests');
    host.destroy(); host = null;
    await getService()?.dispose();
    console.log('Model preview viewer passed: dependency fallback, sandbox, isolated renderer' + (executable ? ', real conversion, textures, animation/seek, orbit, scenes, context loss/retry, read-only source and cleanup.' : ' (Blender integration skipped: dependency not installed).'));
    app.exit(0);
  } catch (error) {
    console.error(error);
    host?.destroy();
    await getService()?.dispose();
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
