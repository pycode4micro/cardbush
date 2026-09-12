// Isolated native window: actual shell components and appearance hook, no
// product profile, Runtime, model calls, or changes to desktop wallpaper.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { resolveWindowAppearance, WindowAppearanceController } = require('../dist-electron/windowAppearance.js');
const root = path.resolve(__dirname, '..');
const preview = process.argv.includes('--preview');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const backgrounds = { dark: '#1a1a1a', bright: '#f5f3ef', parchment: '#e1d4ba', cyberpunk: '#050607' };

async function bundleViews() {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const files = [
    'src/features/appearance/windowAppearance.ts', 'src/components/WindowSidebarToggle.tsx',
    'src/components/TopBar.tsx', 'src/features/sidebar/ChatSidebar.tsx',
    'src/features/chat/WelcomeComposer.tsx',
  ];
  const result = await build({
    configFile: false, logLevel: 'error', plugins: [react(), {
      name: 'window-material-fixture',
      resolveId: id => id.endsWith('__window_material__.ts') ? '\0window-material' : undefined,
      load: id => id === '\0window-material' ? files.map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n') : undefined,
    }],
    build: { write: false, minify: false,
      lib: { entry: path.join(root, '__window_material__.ts'), formats: ['cjs'] },
      rolldownOptions: { external: /^react(?:-dom)?(?:\/|$)/, output: { codeSplitting: false } },
    },
  });
  return (Array.isArray(result) ? result : [result]).flatMap(item => item.output)
    .find(item => item.type === 'chunk').code;
}

app.whenReady().then(async () => {
  const bundle = await bundleViews();
  const win = new BrowserWindow({
    title: 'CardBush · 窗口材质预览', width: 1180, height: 760, minWidth: 960,
    minHeight: 620, frame: false, show: false, backgroundColor: backgrounds.dark,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
      partition: 'cardbush-window-material-fixture' },
  });
  const errors = [];
  const controller = new WindowAppearanceController(win, process.platform, error => errors.push(String(error)));
  let lastRequest = { theme: 'dark', material: 'auto', customTheme: false, themeSource: 'dark' };
  let reducedTransparency = false;
  let delayedReply;
  let delayNext = false;
  const refresh = () => {
    const state = controller.apply(resolveWindowAppearance({
      theme: lastRequest.theme, preference: lastRequest.material, customTheme: lastRequest.customTheme,
      platform: process.platform, release: os.release(), reducedTransparency: reducedTransparency || nativeTheme.prefersReducedTransparency,
      highContrast: nativeTheme.shouldUseHighContrastColors || nativeTheme.inForcedColorsMode,
      gpuCompositing: app.getGPUFeatureStatus().gpu_compositing,
    }), backgrounds[lastRequest.theme]);
    win.webContents.send('fixture:appearance', state);
    return state;
  };
  ipcMain.handle('fixture:theme', async (_event, theme, options) => {
    lastRequest = { theme, ...options };
    nativeTheme.themeSource = options.themeSource;
    const state = refresh();
    if (delayNext) {
      delayNext = false;
      await new Promise(resolve => { delayedReply = resolve; });
    }
    return state;
  });
  ipcMain.on('fixture:window', (_event, action) => {
    if (action === 'close') win.close();
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  nativeTheme.on('updated', refresh);
  const run = source => win.webContents.executeJavaScript(source);
  const until = async (condition, label) => {
    for (let i = 0; i < 100; i++) { if (await run(condition)) return; await pause(30); }
    throw Error(`Timed out: ${label}`);
  };
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    if (/^https?:/.test(details.url)) errors.push(`Unexpected network: ${details.url}`);
    done({ cancel: /^https?:/.test(details.url) });
  });
  await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
  const css = ['theme.css', 'app.css', 'windowMaterial.css', 'themes/cyberpunk.css']
    .map(file => fs.readFileSync(path.join(root, 'src/styles', file), 'utf8')).join('\n');
  await win.webContents.insertCSS(css);
  await run(`
    const { ipcRenderer } = require('electron');
    window.failures = [];
    addEventListener('error', event => failures.push(event.message));
    addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
    const values = new Map();
    Object.defineProperty(window, 'localStorage', { value: {
      getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    }});
    window.cardbushDesktop = {
      setWindowTheme: (theme, options) => ipcRenderer.invoke('fixture:theme', theme, options),
      onWindowAppearanceChanged: callback => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('fixture:appearance', listener);
        return () => ipcRenderer.removeListener('fixture:appearance', listener);
      },
    };
    const React = require(${JSON.stringify(require.resolve('react'))});
    const { createRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
    const sourceRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
    const module = { exports: {} };
    new Function('require','module','exports', ${JSON.stringify(bundle)})(sourceRequire, module, module.exports);
    const views = module.exports, h = React.createElement, noop = () => {};
    function Preview() {
      const [theme, setTheme] = React.useState('dark');
      const [material, setMaterial] = React.useState('auto');
      const [themePreference, setThemePreference] = React.useState('dark');
      const [collapsed, setCollapsed] = React.useState(false);
      const [draft, setDraft] = React.useState('');
      const [settings, setSettings] = React.useState(false);
      window.openFixtureSettings = setSettings;
      window.changeAppearance = (nextTheme, nextMaterial = 'auto', nextPreference = nextTheme === 'bright' ? 'light' : nextTheme) => {
        setTheme(nextTheme); setMaterial(nextMaterial); setThemePreference(nextPreference);
      };
      views.useWindowAppearance(theme, themePreference, material);
      return h('div', { className: 'app ' + (theme === 'cyberpunk' ? 'theme-dark theme-cyberpunk' : 'theme-' + theme), style: { '--sidebar-width':'252px' } },
        h('header', { className:'window-frame window-drag' },
          h(views.WindowSidebarToggle, { language:'zh', collapsed, onToggle:() => setCollapsed(!collapsed) }),
          h('button', { className:'frame-chip cache-chip' }, '缓存'), h('button', { className:'frame-chip' }, '插件'),
          h('div', { className:'window-spacer window-drag' }),
          h('button', { className:'frame-chip cache-chip', onClick:() => changeAppearance(theme === 'dark' ? 'bright' : 'dark', material) }, theme === 'dark' ? '浅色' : '深色'),
          h('button', { className:'frame-chip cache-chip', onClick:() => setMaterial(material === 'auto' ? 'solid' : 'auto') }, material === 'auto' ? '玻璃 · 开' : '玻璃 · 关'),
          ...['minimize','maximize','close'].map(action => h('button', { key:action, className:'window-button' + (action === 'close' ? ' danger' : ''), onClick:() => ipcRenderer.send('fixture:window',action) }, h('span',{className:'window-glyph ' + action})))),
        h('main', { className: settings ? 'settings-shell' : 'desktop-shell' },
          settings ? h('aside', { className:'settings-sidebar' }, h('button', { className:'back-button', onClick:() => setSettings(false) }, '返回应用'), h('button', { className:'settings-nav active' }, '个性化')) :
          h(views.ChatSidebar, { language:'zh', section:'chat', activeConversationId:'', runningConversationIds:new Set(), attentionByConversation:{}, projects:[], conversations:[], changeReportsByConversation:{}, onlyTalkMode:true,
            softVisible:!collapsed, onOnlyTalkModeChange:noop, onSectionChange:noop, onConversationChange:noop, onCreateConversation:noop, onAddProject:noop, onProjectAction:noop, onDeleteConversation:noop,
            onRenameConversation:async()=>true, onOpenConversationChanges:noop, onOpenSettings:()=>setSettings(true) }),
          h('section', { className: settings ? 'settings-content' : 'main-stage' }, h('div', { className:'chat-panel' },
            h(views.TopBar, { title:settings ? '个性化' : '新会话', language:'zh', inspectorOpen:false, onToggleInspector:noop }),
            settings ? h('div', { style:{padding:32} }, '顶栏右侧可切换玻璃 / 纯色与浅色 / 深色。') :
            h(views.WelcomeComposer, { language:'zh', onlyTalkMode:true, draft, onDraftChange:setDraft, sending:false, stopping:false, guidanceDeliveryMode:'immediate', cancelEnabled:false,
              queuedMessageCount:0, queuedMessagePreview:'', queuedMessages:[], selectedModel:'preview', availableModels:[{id:'preview',provider:'preview',modelName:'CardBush 预览'}],
              goalAvailable:false, referencePlanAvailable:false, referencePlanMode:'off', permissionMode:'full-access', subagentPermissionRouting:'inherit', reasoningLevelAvailable:false, reasoningLevel:'medium', reasoningLevels:[],
              selectedProjectDir:'', availableProjects:[], skills:[], disabledSkillNames:new Set(), onProjectChange:async()=>{}, onToggleSkill:noop, onModelChange:noop, onReferencePlanModeChange:noop,
              onPermissionModeChange:noop, onSubagentPermissionRoutingChange:noop, onReasoningLevelChange:noop, onConfigureModels:noop, onEditQueuedMessage:noop, onGuideQueuedMessage:async()=>{},
              onRemoveQueuedMessage:noop, onSend:async()=>{}, onCancel:async()=>{} })))));
    }
    createRoot(document.getElementById('root')).render(h(React.StrictMode, null, h(Preview)));
  `);
  await until("document.documentElement.dataset.windowMaterial === 'mica' || document.documentElement.dataset.windowMaterial === 'none'", 'native acknowledgement');
  await pause(400);
  const nativeState = refresh();
  console.log('Native appearance:', JSON.stringify({ ...nativeState, background: win.getBackgroundColor(), gpu: app.getGPUFeatureStatus().gpu_compositing }));
  if (nativeState.material === 'mica') {
    await until("document.documentElement.dataset.windowMaterial === 'mica'", 'Mica');
    // Electron's getter serializes RGB for a normal HWND and drops alpha.
    assert.match(win.getBackgroundColor(), /^#000000(?:00)?$/);
    const checkTransparency = async () => {
      for (const selector of ['html','body','#root','.app','.desktop-shell','.window-frame','.sidebar']) {
        const style = await run(`({ color:getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor, image:getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundImage })`);
        assert.equal(style.image, 'none', `${selector} must not cover native material with a gradient`);
        assert.match(style.color, /rgba\(/, `${selector} must expose native material`);
      }
      assert.match(await run("getComputedStyle(document.querySelector('.main-stage')).backgroundColor"), /^rgb\(/);
    };
    await checkTransparency();
    await run("dispatchEvent(new Event('focus')); dispatchEvent(new Event('pageshow')); document.dispatchEvent(new Event('visibilitychange'))");
    await checkTransparency();
    // A stale completion must not reopen transparency after a newer selection.
    delayNext = true;
    await run("changeAppearance('bright')");
    await until("document.documentElement.dataset.startTheme === 'bright' && document.documentElement.dataset.windowMaterial === 'mica'", 'light');
    reducedTransparency = true; refresh();
    await until("document.documentElement.dataset.windowMaterial === 'none'", 'newer system event');
    delayedReply?.();
    await pause(100);
    assert.equal(await run('document.documentElement.dataset.windowMaterial'), 'none', 'old reply cannot undo a newer system accessibility event');
    reducedTransparency = false; refresh();
    await until("document.documentElement.dataset.windowMaterial === 'mica'", 'newer system restore');
    delayNext = true;
    await run("changeAppearance('dark')");
    await until("document.documentElement.dataset.startTheme === 'dark' && document.documentElement.dataset.windowMaterial === 'mica'", 'pending dark reply');
    await run("changeAppearance('dark','solid')");
    await until("document.documentElement.dataset.windowMaterial === 'none'", 'solid');
    delayedReply?.();
    await pause(100);
    assert.equal(await run('document.documentElement.dataset.windowMaterial'), 'none');
    assert.equal(win.getBackgroundColor().toLowerCase(), backgrounds.dark);
    await run("changeAppearance('dark')");
    await until("document.documentElement.dataset.windowMaterial === 'mica'", 'restored');
    reducedTransparency = true; refresh();
    await until("document.documentElement.dataset.windowMaterial === 'none'", 'OS accessibility change');
    reducedTransparency = false; refresh();
    await until("document.documentElement.dataset.windowMaterial === 'mica'", 'OS restored');
    await run("changeAppearance('dark','auto','custom')");
    await until("document.documentElement.dataset.windowMaterial === 'none'", 'custom palette owns backdrop');
    await run("changeAppearance('cyberpunk')");
    await until("document.documentElement.dataset.startTheme === 'cyberpunk'", 'special theme');
    assert.equal(await run('document.documentElement.dataset.windowMaterial'), 'none');
    await run("changeAppearance('dark')");
    await until("document.documentElement.dataset.windowMaterial === 'mica'", 'preview ready');
  }
  for (const theme of ['dark', 'bright']) {
    await run(`changeAppearance(${JSON.stringify(theme)}); openFixtureSettings(false)`);
    await until("!!document.querySelector('.main-stage')", 'home surface');
    await until(`document.documentElement.dataset.startTheme === ${JSON.stringify(theme)} && document.documentElement.dataset.windowMaterial === ${JSON.stringify(nativeState.material)}`, 'surface material acknowledgement');
    const homeSurface = await run("({radius:getComputedStyle(document.querySelector('.main-stage')).borderRadius, shadow:getComputedStyle(document.querySelector('.main-stage')).boxShadow, background:getComputedStyle(document.querySelector('.main-stage')).backgroundColor})");
    await run('openFixtureSettings(true)'); await until("!!document.querySelector('.settings-content')", 'settings surface');
    const settingsSurface = await run("({radius:getComputedStyle(document.querySelector('.settings-content')).borderRadius, shadow:getComputedStyle(document.querySelector('.settings-content')).boxShadow, background:getComputedStyle(document.querySelector('.settings-content')).backgroundColor})");
    assert.deepEqual(settingsSurface, homeSurface, 'settings uses the same rounded surface as home');
    assert.equal(settingsSurface.radius, '14px 0px 0px 14px');
  }
  await run("openFixtureSettings(false); changeAppearance('dark')");
  if (!preview) await require('./helpers/window-titlebar-native.cjs')({ win, run, until, pause, root });
  assert.deepEqual(await run('failures'), []);
  assert.deepEqual(errors, []);
  console.log('Window appearance UI passed: native material, transparent ancestors, opaque reading surface, theme changes, stale replies, accessibility and special themes.');
  if (!preview) {
    win.destroy(); app.exit(0); return;
  }
  // The isolated data: page cannot resolve the production-relative logo URL.
  assert.equal(await run("document.querySelector('.welcome-star-wordmark')?.getAttribute('aria-label')"), 'cardbush');
  await run("document.title = 'CardBush · 窗口材质预览'");
  win.show(); win.focus();
  win.on('closed', () => app.exit(0));
  console.log('Preview ready:', JSON.stringify({ visible:win.isVisible(), focused:win.isFocused(), source:win.getMediaSourceId() }));
}).catch(error => { console.error(error); app.exit(1); });
