const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, Menu, protocol, net } = require('electron');
const ts = require('typescript');
const { buildFileContextMenu } = require('../dist-electron/fileContextMenu.js');
const { localFileSystemPathFromProtocolUrl } = require('../dist-electron/localFileProtocol.js');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
const deadline = setTimeout(() => app.exit(1), 25000);
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
app.whenReady().then(async () => {
  protocol.handle('cardbush-file', request => net.fetch(pathToFileURL(localFileSystemPathFromProtocolUrl(request.url)).href));
  const win = new BrowserWindow({ show: false, width: 1050, height: 1000, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  const menus = [], actions = [], errors = []; let failCopy = false;
  // Exercise the real IPC handler and Windows clipboard helper while keeping the user's clipboard intact.
  const main = fs.readFileSync('electron/main.ts', 'utf8'), ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const functions = ['normalizeShellPath', 'copyLocalFileToClipboard', 'copyWindowsFileToClipboard'].map(name => ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast));
  const ipcHandler = ast.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'ipcMain.handle' && node.expression.arguments[0]?.text === 'shell:file-context-menu');
  const source = ts.transpileModule([...functions, ipcHandler.getText(ast)].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const dependencies = { fs, path, process, BrowserWindow, ipcMain, mainWindow: win, shadowWindows: new Map(), buildFileContextMenu,
    localPathFromProtocolUrl: localFileSystemPathFromProtocolUrl,
    Menu: { buildFromTemplate: items => { const menu = Menu.buildFromTemplate(items); menus.push(menu); return { popup() {} }; } },
    clipboard: { writeText: value => actions.push(['path', value]) },
    spawn: (command, args, options) => { actions.push(['file', command, args, options.env.CARDBUSH_CLIPBOARD_TARGET]); const child = new EventEmitter(); child.stderr = new PassThrough(); child.kill = () => {}; process.nextTick(() => child.emit('close', failCopy ? 1 : 0)); return child; },
    openUiPreview: value => actions.push(['open', value]), openFileWithChooser: value => actions.push(['with', value]),
    shell: { showItemInFolder: value => actions.push(['reveal', value]) }, showWindowError: (_, title, message) => errors.push({ title, message }),
  };
  new Function(...Object.keys(dependencies), source)(...Object.values(dependencies));
  win.webContents.copyImageAt = (x, y) => actions.push(['image', x, y]);
  ipcMain.handle('test:error', (_, error) => errors.push(error));
  const read = code => win.webContents.executeJavaScript(code), until = async predicate => { const end = Date.now() + 5000; while (!await predicate()) { if (Date.now() > end) throw Error('Media menu condition timed out'); await pause(); } };
  const context = async selector => { const before = menus.length; await read(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});element.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));})()`); await until(() => menus.length > before); return menus.at(-1); };
  const invoke = async (menu, label) => { const item = menu.items.find(item => item.label === label); assert.ok(item?.enabled, label); item.click(); await pause(); };
  try {
    await win.loadFile(path.join(directory, 'ui', 'index.html'));
    await until(() => read('document.querySelector(".message-image-preview img")?.naturalWidth>0'));
    const files = await read('files');
    assert.equal(await read('Boolean(document.querySelector(".message-media-path"))'), false);
    const visible = await read('document.body.innerText');
    assert.ok(!visible.includes(directory), 'media never adds an absolute path to the visible transcript');
    assert.ok(visible.indexOf('视频说明') < visible.indexOf('海报说明') && visible.indexOf('海报说明') < visible.indexOf('音频说明'), 'surrounding prose retains its order');
    const menu = await context('.message-image-preview');
    for (const label of ['复制图片', '复制文件', '复制路径', '打开方式...']) assert.ok(menu.items.some(item => item.label === label && item.enabled), label);
    await invoke(menu, '复制文件');
    const copied = actions.at(-1); assert.equal(copied[0], 'file'); assert.equal(copied[3], files.image);
    assert.ok(copied[2].includes('-STA')); assert.match(copied[2].at(-1), /SetFileDropList/); assert.ok(!copied[2].at(-1).includes(files.image), 'paths travel as environment data, never shell code');
    await invoke(menu, '复制图片'); assert.equal(actions.at(-1)[0], 'image');
    assert.ok(await read(`document.elementFromPoint(${actions.at(-1)[1]},${actions.at(-1)[2]}) instanceof HTMLImageElement`), 'pixel copying targets the displayed image');
    await invoke(menu, '复制路径'); assert.deepEqual(actions.at(-1), ['path', files.image]);
    await invoke(menu, '打开方式...'); assert.deepEqual(actions.at(-1), ['with', files.image]);
    for (const [selector, expected] of [['.message-video-player', files.video], ['.message-audio-player', files.audio], ['.message-file-attachment', files.document]]) {
      const fileMenu = await context(selector); await invoke(fileMenu, '复制文件'); assert.equal(actions.at(-1)[3], expected);
    }
    await read('document.querySelector(".message-image-preview").click()');
    await until(() => read('document.querySelector(".image-preview-stage img")?.naturalWidth>0'));
    const previewMenu = await context('.image-preview-stage img');
    await invoke(previewMenu, '复制路径'); assert.deepEqual(actions.at(-1), ['path', files.image]);
    await invoke(previewMenu, '复制图片'); assert.equal(actions.at(-1)[0], 'image');
    failCopy = true; const currentUrl = win.webContents.getURL();
    await invoke(previewMenu, '复制文件'); await until(() => errors.length > 0);
    assert.match(errors.at(-1).message, /Copy file exited/); assert.equal(win.webContents.getURL(), currentUrl);
    assert.ok(await read('Boolean(document.querySelector(".image-preview-dialog"))'), 'operation errors keep the current preview and app intact');
    failCopy = false;
    await read('document.querySelector(".image-preview-close").click();setMode("remote")');
    await until(() => read('document.querySelector(".image-preview-stage img")?.naturalWidth>0'));
    const remote = await context('.image-preview-stage img'); assert.deepEqual(remote.items.map(item => item.label), ['复制图片']);
    await read('setMode("inspector")'); await until(() => read('document.querySelector(".inspector-media-preview img")?.naturalWidth>0'));
    await invoke(await context('.inspector-media-preview img'), '复制文件'); assert.equal(actions.at(-1)[3], files.image);
    const beforeMissing = menus.length;
    await read(`cardbushDesktop.showFileContextMenu(${JSON.stringify(path.join(directory, 'missing.png'))})`);
    await until(() => menus.length > beforeMissing);
    assert.equal(menus.at(-1).items.find(item => item.label === '复制文件').enabled, false);
    assert.equal(menus.at(-1).items.find(item => item.label === '复制路径').enabled, true);
    console.log('Media file menus passed: real chat/preview/inspector right clicks, no path captions, native file-drop routing, image pixels, open-with, remote images, missing files and error dialogs without navigation.');
  } finally { win.destroy(); clearTimeout(deadline); }
}).then(() => app.exit(0), error => { console.error(error); clearTimeout(deadline); app.exit(1); });
