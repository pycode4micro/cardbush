// Actual extracted views in isolated Chromium: no product profile, real files,
// network requests, model calls or Runtime subscriptions.
const { app, BrowserWindow, protocol } = require('electron');
if (process.env.CARDBUSH_APP_VIEWS_CASE === 'agent-file-preview') {
  protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-agent', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  } }]);
}
if (process.env.CARDBUSH_APP_VIEWS_CASE === 'review-preview') {
  protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: {
    standard: true, secure: true, supportFetchAPI: true, stream: true,
  } }]);
}
// Xvfb runners have no hardware GPU. Keep offscreen fixtures on software
// rendering so Viz crashes do not interrupt unrelated UI assertions.
if (process.env.CI === 'true' && process.platform === 'linux') app.disableHardwareAcceleration();
// CI Windows Server disables system animations. Motion regressions need an
// explicit baseline; reduced-motion cases below still use media emulation.
app.commandLine.appendSwitch('force-prefers-no-reduced-motion');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pause = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));

async function buildViews() {
  const { appViewFiles } = await import('./helpers/app-view-sources.mjs');
  const moved = new Set(appViewFiles.slice(1).map(file => path.resolve(root, file)));
  const graph = new Map();
  for (const file of moved) {
    const dependencies = [];
    graph.set(file, dependencies);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const node of source.statements.filter(ts.isImportDeclaration)) {
      const spec = node.moduleSpecifier.text;
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      assert.notEqual(target, path.join(root, 'src/App'), 'views must not import their composition root');
      if (target.endsWith(path.join('hooks', 'useCardbushChat'))) {
        assert.equal(node.importClause?.isTypeOnly, true, 'view imports of Hook types must be erased');
      }
      if (!node.importClause?.isTypeOnly) {
        const dependency = [target + '.tsx', target + '.ts'].find(candidate => moved.has(candidate));
        if (dependency) dependencies.push(dependency);
      }
      assert.ok(!/[\\/]packages[\\/].*[\\/]src[\\/]/.test(target), 'views must not reach into Runtime internals');
    }
  }
  const visit = (file, ancestors = new Set()) => {
    assert.ok(!ancestors.has(file), `circular view dependency: ${file}`);
    for (const dependency of graph.get(file)) visit(dependency, new Set([...ancestors, file]));
  };
  for (const file of moved) visit(file);
  const appSource = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true);
  const rootNames = new Set(appSource.statements.map(node =>
    (ts.isVariableStatement(node) ? node.declarationList.declarations[0].name : node.name)?.text));
  for (const name of ['ChatPanel', 'WelcomeComposer', 'TopBar', 'InspectorWebview', 'InteractionCard']) {
    assert.ok(!rootNames.has(name), `${name} must have one owner outside App`);
  }
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const entryId = '\0app-view-test.ts';
  const exports = [...appViewFiles.slice(1), 'src/features/sidebar/ChatSidebar.tsx',
    'src/features/panels/FeatureContentPanel.tsx',
    'src/components/SidebarResizer.tsx', 'src/components/RightInspectorResizer.tsx',
    'src/hooks/useCapabilityCatalogRefresh.ts',
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'ssh' ? ['src/features/ssh/SshConnectionsPanel.tsx', 'src/features/ssh/WorkspaceLocationPicker.tsx'] : []),
    'src/hooks/useSoftPanelPresence.ts',
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'compact-window' ? [
      'src/hooks/useCompactSidebar.ts', 'src/components/CompactSidebarBackdrop.tsx', 'src/features/SettingsView.tsx',
    ] : []),
    'src/features/chatMessages/MessageBubble.tsx',
    'src/features/appearance/useVisualThemeContext.ts',
    'src/features/chatMessages/FileMemoReference.tsx',
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'agent-file-preview' ? [
      'src/features/conversationHost.ts', 'src/features/inspector/ConversationHostPreview.tsx',
      'src/features/agents/useAgentConversationHost.tsx', 'src/features/agents/agentConversationBackend.ts',
    ] : []),
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'media-reveal' ? [
      'src/features/chatMessages/InlineMedia.tsx', 'src/features/chat/chatScrollMotion.ts',
    ] : []),
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'loop-previews' ? [
      'src/backend/runtimeSessionMessageProjection.ts', 'src/features/chatMessages/transcript/messageProjection.ts',
    ] : []),
    'src/features/tools/WorkspaceChangeStateContext.ts',
    'src/features/tools/toolChangeReports.ts',
    'src/features/sidebar/reviewCommentModel.ts',
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'shadow-state' ? ['src/ShadowWindow.tsx'] : []),
    'src/features/inspector/InspectorErrorBoundary.tsx',
    'src/features/composer/queueOrdering.ts',
    'src/features/settings/SettingsKeyboardPanel.tsx',
    'src/features/shortcuts/useKeyboardShortcuts.ts',
    'src/features/shortcuts/keyboardShortcuts.ts',
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'app-center' ? [
      'src/features/appCenter/AppCenter.tsx', 'src/features/appCenter/appCenterStore.ts',
      'src/components/GlobalTooltip.tsx', 'src/components/WindowFrame.tsx',
      'src/features/windowMenu/applicationMenus.ts', 'src/features/conversationHost.ts',
    ] : []),
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'page-navigation' ? [
      'src/features/navigation/PageNavigation.tsx', 'src/features/plugins/PluginManagementPanel.tsx',
      'src/features/plugins/PluginWorkspace.tsx', 'src/features/plugins/pluginNavigationRequests.ts',
      'src/features/settings/SettingsHostContext.ts', 'src/features/automations/AutomationPanel.tsx',
      'src/features/windowMenu/applicationMenus.ts',
    ] : []),
    'src/features/shortcuts/usePreviousConversationShortcut.ts',
    'src/features/search/ConversationSearchDialog.tsx',
    'src/features/search/useConversationSearch.ts',
    'src/features/chatMessages/transcript/liveMessageUpdates.ts']
    .map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), {
      name: 'app-view-test-entry',
      enforce: 'pre',
      resolveId: (value, importer) => {
        if (process.env.CARDBUSH_APP_VIEWS_CASE === 'loop-previews' && value.endsWith('runtime-client/ElectronRuntimeSession')) return '\0loop-preview-runtime';
        if (process.env.CARDBUSH_APP_VIEWS_CASE === 'shadow-state' && value === './backend/api' && importer?.endsWith('ShadowWindow.tsx')) return '\0shadow-view-api';
        return value.endsWith('__app_view_test__.ts') ? entryId : undefined;
      },
      load: value => value === '\0loop-preview-runtime' ? `export function createDesktopRuntimeSession(){return {dispose(){},client:window.loopFixtureClient};}` : value === '\0shadow-view-api'
        ? ['closeShadowConversation', 'createShadowConversation', 'fetchSessionMessages', 'streamShadowConversationMessage', 'updateShadowConversationMode']
          .map(name => `export const ${name} = (...args) => window.shadowFixture.${name}(...args);`).join('\n')
        : value === entryId ? exports : undefined,
    }],
    build: {
      write: false, minify: false,
      lib: { entry: path.join(root, 'src/__app_view_test__.ts'), formats: ['cjs'] },
      rolldownOptions: {
        external: /^react(?:-dom)?(?:\/|$)/,
        output: { codeSplitting: false },
      },
    },
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(result => result.output).filter(chunk => chunk.type === 'chunk');
  assert.equal(chunks.length, 1, 'test must evaluate all real view dependencies and lazy syntax renderer');
  return chunks[0].code;
}

app.whenReady().then(async () => {
  const bundle = await buildViews();
  // Vite builds production feature gates; React itself must remain development
  // here so StrictMode actually replays mounts and effect cleanup.
  process.env.NODE_ENV = 'development';
  const window = new BrowserWindow({
    show: false, width: 1200, height: 800,
    ...(process.env.CARDBUSH_APP_VIEWS_CASE === 'compact-window' ? {
      ...require('../dist-electron/windowAppearance.js').mainWindowFrameOptions(process.platform), minWidth: 480, minHeight: 480,
    } : {}),
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
      webviewTag: ['agent-file-preview', 'html-references', 'html-lifecycle', 'media-reveal', 'review-preview'].includes(process.env.CARDBUSH_APP_VIEWS_CASE),
      offscreen: true, partition: 'cardbush-app-view-test',
    },
  });
  if (process.env.CARDBUSH_APP_VIEWS_CASE === 'review-preview') {
    const { net } = require('electron');
    const { pathToFileURL } = require('node:url');
    window.webContents.session.protocol.handle('cardbush-file', request => {
      const url = new URL(request.url);
      const file = /^[a-z]$/i.test(url.hostname) ? url.hostname + ':' + decodeURIComponent(url.pathname) : decodeURIComponent(url.pathname).replace(/^\/([a-z]:)/i, '$1');
      return net.fetch(pathToFileURL(file).href);
    });
  }
  const errors = [];
  window.webContents.on('console-message', event => {
    if (/Maximum update depth|Invalid hook call|ResizeObserver loop|passive event listener|Encountered two children with the same key/.test(event.message)) errors.push(event.message);
  });
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/.test(details.url);
    if (external) errors.push('Unexpected network request: ' + details.url);
    done({ cancel: external });
  });
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code); }
    catch (error) { throw new Error(`${error.message}\nExecuting: ${code.slice(0,240)}`); }
  };
  const until = async (condition, label) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await run(condition)) return;
      await pause(25);
    }
    throw new Error('Timed out: ' + label + '\n' + await run('document.body.innerText') + '\nRenderer errors: ' + await run('JSON.stringify(window.failures ?? [])'));
  };
  try {
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'media-reveal') {
      const host = path.join(root, 'tmp', 'media-reveal-host.html');
      fs.mkdirSync(path.dirname(host), { recursive: true });
      fs.writeFileSync(host, '<html><body><div id="root"></div></body></html>');
      await window.loadFile(host);
      fs.unlinkSync(host);
    } else await window.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/theme.css'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'src/styles/app.css'), 'utf8'));
    await run(`
      window.failures = [];
      addEventListener('error', event => failures.push(event.message));
      addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
      for (const name of ['localStorage', 'sessionStorage']) {
        const values = new Map();
        Object.defineProperty(window, name, { value: {
          getItem: key => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, String(value)),
          removeItem: key => values.delete(key),
        }});
      }
      window.fetch = () => { throw new Error('Network calls are forbidden in the view test'); };
      const React = require(${JSON.stringify(require.resolve('react'))});
      const { createRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const sourceRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const views = (() => {
        const module = { exports: {} };
        new Function('require', 'module', 'exports', ${JSON.stringify(bundle)})(sourceRequire, module, module.exports);
        return module.exports;
      })();
      const h = React.createElement;
      const reactRoot = createRoot(document.getElementById('root'));
      window.renderView = child => reactRoot.render(h(React.StrictMode, null, h('div', { className: 'app ' + (window.viewTheme || 'theme-dark'), style: { height: '100vh', width: '900px' } }, child)));
      window.views = views;
      window.h = h;
      window.inspectorRef = React.createRef();
      window.reads = [];
      window.errorDialogs = [];
      window.navigation = [];
      window.cardbushDesktop = {
        readTextPreview: path => new Promise((resolve, reject) => reads.push({ path, resolve, reject })),
        showErrorDialog: async error => { errorDialogs.push(error); },
        inspectLocalReference: async path => ({ path, name: path.replaceAll('\\\\', '/').split('/').pop(), kind: 'file' }),
      };
      const onNavigationStateChange = (identity, state) => navigation.push({ identity, ...state });
      const onOpenTarget = () => {};
      window.preview = target => renderView(h(views.InspectorWebview, {
        ref: inspectorRef, identity: target, target, source: views.inspectorSource(target),
        language: 'en', onNavigationStateChange, onOpenTarget,
      }));
      window.resolveReads = (path, content, truncated = false, encoding = 'utf-8') => {
        for (const read of reads.filter(read => read.path === path && !read.done)) {
          read.done = true; read.resolve({ content, truncated, encoding });
        }
      };
      if (!['sidebar-menu', 'conversation-titles', 'conversation-search', 'review-preview', 'app-center', 'page-navigation'].includes(${JSON.stringify(process.env.CARDBUSH_APP_VIEWS_CASE)})) preview('D:/fixture/first.md');
    `);
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'page-navigation') {
      await require('./helpers/page-navigation.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no page navigation renderer errors'); assert.deepEqual(errors, []); return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'startup-presentation') {
      await require('./helpers/startup-presentation.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no startup presentation renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'conversation-search') {
      await require('./helpers/conversation-search.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no conversation search renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'media-reveal') {
      await require('./helpers/media-reveal.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no media reveal renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'html-lifecycle') {
      await require('./helpers/html-preview-lifecycle.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no HTML lifecycle renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'review-preview') {
      await require('./helpers/review-preview.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no review preview renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'agent-file-preview') {
      await require('./helpers/agent-file-preview.cjs')({ run, until, pause, window, root });
      assert.deepEqual(errors, []); console.log('Remote Agent previews passed.'); return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'html-references') {
      await require('./helpers/html-references.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no HTML reference renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'loop-previews') {
      await require('./helpers/loop-execution-previews.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no loop preview renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'review-comments') {
      await require('./helpers/review-comments.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no review comment renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'review-file-nav') {
      await require('./helpers/review-file-nav.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no review file navigation renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'shadow-state') {
      await require('./helpers/shadow-state.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no Shadow renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'undo-revert') {
      await require('./helpers/workspace-undo-revert.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no undo-revert renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'sidebar-menu') {
      await require('./helpers/sidebar-context-menu.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no sidebar menu renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'conversation-titles') {
      await require('./helpers/conversation-title-rendering.cjs')({ run, until, pause, window });
      assert.deepEqual(await run('failures'), [], 'no conversation title renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!['ssh', 'compact-window', 'quick-context', 'tool-disclosure', 'tool-update-stability', 'composer-input', 'composer-resize', 'previous-conversation', 'guidance-rendering', 'session-scroll', 'submission-motion', 'app-center'].includes(process.env.CARDBUSH_APP_VIEWS_CASE)) {
    await until('reads.length >= 2', 'StrictMode preview effects');
    assert.equal(await run("views.normalizeInspectorBrowserAddress('127.0.0.1:51733')"), 'http://127.0.0.1:51733');
    assert.equal(await run("views.inspectorSource('D:/fixture/report.xlsx')"), 'cardbush-file://office-preview/?path=D%3A%2Ffixture%2Freport.xlsx');
    assert.equal(await run("views.inspectorTargetIdentity('D:/Fixture/Code.ts')"), 'd:\\fixture\\code.ts');
    await run("preview('D:/fixture/second.md')");
    await until("reads.some(read => read.path.endsWith('second.md'))", 'switch file');
    await run("resolveReads('D:/fixture/second.md', '# Current preview')");
    await until("document.querySelector('.markdown-inspector-preview h1')?.textContent === 'Current preview'", 'new preview');
    const navigationCount = await run('navigation.length');
    await run("resolveReads('D:/fixture/first.md', '# Obsolete preview')");
    await pause();
    assert.equal(await run("document.querySelector('.markdown-inspector-preview h1').textContent"), 'Current preview', 'late history must not replace current file');
    assert.equal(await run('navigation.length'), navigationCount, 'disposed reads must not publish stale navigation');
    await run('inspectorRef.current.reload()');
    await until("reads.some(read => read.path.endsWith('second.md') && !read.done)", 'reload reads again');
    await run("resolveReads('D:/fixture/second.md', '# Reloaded preview')");
    await until("document.querySelector('h1')?.textContent === 'Reloaded preview'", 'reload result');
    const urlParagraph = '一条命令即可：`npm start`（前台 http://localhost:51231/，后台 http://localhost:51231/admin.html）。如果之前是用自定义 `PORT/ADMIN_TOKEN` 启动的';
    await run("preview('D:/fixture/links.md')");
    await until("reads.some(read => read.path.endsWith('links.md'))", 'URL paragraph read');
    await run(`resolveReads('D:/fixture/links.md', ${JSON.stringify(urlParagraph)})`);
    await until("document.querySelectorAll('.markdown-content a').length === 2", 'two independent localhost links');
    assert.deepEqual(await run("Array.from(document.querySelectorAll('.markdown-content a'), link => [link.textContent, link.getAttribute('href')])"), [
      ['http://localhost:51231/', 'http://localhost:51231/'],
      ['http://localhost:51231/admin.html', 'http://localhost:51231/admin.html'],
    ], 'display labels and navigation URLs must both exclude Chinese prose');
    assert.equal(await run("document.querySelector('.markdown-content p').textContent"), urlParagraph.replaceAll('`', ''), 'all surrounding prose and punctuation remain visible');
    await run(`
      window.linkTargets = [];
      window.recordLinkTarget = event => linkTargets.push(event.detail.target);
      addEventListener('cardbush:open-inspector', recordLinkTarget);
      for (const link of document.querySelectorAll('.markdown-content a')) link.click();
      removeEventListener('cardbush:open-inspector', recordLinkTarget);
    `);
    assert.deepEqual(await run('linkTargets'), ['http://localhost:51231/', 'http://localhost:51231/admin.html'], 'clicks open the exact URL in the inspector');
    await require('./helpers/markdown-file-navigation.cjs')({ run, until, pause, window });
    await require('./helpers/chat-final-file-references.cjs')({ run, until, pause });
    await run("preview('D:/fixture/code.ts')");
    await until("reads.some(read => read.path.endsWith('code.ts'))", 'source read');
    await run("resolveReads('D:/fixture/code.ts', 'const extractedView = true;', true)");
    await until("document.querySelector('.source-inspector-preview')?.textContent.includes('extractedView')", 'lazy source syntax renderer');
    assert.equal(await run("document.querySelectorAll('.inspector-preview-notice').length"), 1);
    await run("preview('D:/fixture/unicode.txt')");
    await until("reads.some(read => read.path.endsWith('unicode.txt'))", 'Unicode text read');
    await run("resolveReads('D:/fixture/unicode.txt', '中文😀\\r\\n第二行\\r第三行', false, 'utf-16le')");
    await until("document.querySelector('.source-inspector-preview')?.textContent.includes('中文😀')", 'decoded UTF-16 reaches the text renderer');
    assert.equal(await run("document.querySelectorAll('.source-code-line').length"), 3, 'mixed CRLF/CR text has correct line boundaries');
    await run("preview('D:/fixture/legacy.log')");
    await until("reads.some(read => read.path.endsWith('legacy.log'))", 'legacy text read');
    assert.equal(await run("document.querySelector('.source-inspector-preview')?.textContent.includes('中文😀')"), false, 'new path does not show the old file while waiting');
    await run("resolveReads('D:/fixture/legacy.log', '旧编码中文', false, 'gb18030')");
    await until("document.querySelector('.inspector-preview-notice')?.textContent.includes('GB18030')", 'legacy decoding is explicit');
    for (const extension of ['txt', 'md']) {
      await run(`preview('D:/fixture/huge.${extension}')`);
      await until(`reads.some(read => read.path.endsWith('huge.${extension}'))`, 'large text read');
      await run(`window.largePreviewText = '# many lines\\n'.repeat(20000); resolveReads('D:/fixture/huge.${extension}', largePreviewText, true)`);
      await until("!!document.querySelector('[data-render-mode=virtual] .source-code-line')", 'large text renders only nearby blocks');
      assert.ok(await run("document.querySelectorAll('.source-code-line').length") < 200, 'large text must not allocate one DOM row per line');
      await run("window.largeScroller = document.querySelector('.source-inspector-document, .markdown-inspector-document'); largeScroller.scrollTop = largeScroller.scrollHeight;");
      await until("!!document.querySelector('[data-source-line=\"20001\"]')", 'all byte-bounded text remains reachable at the tail');
      assert.ok(await run("document.querySelectorAll('.source-code-line').length") < 200);
    }
    await run("preview('D:/fixture/binary.txt')");
    await until("reads.some(read => read.path.endsWith('binary.txt'))", 'binary file read');
    const binaryDialogsBefore = await run('errorDialogs.length');
    await run("for (const read of reads.filter(read => read.path.endsWith('binary.txt'))) read.reject(new Error('Error invoking remote method: [text_preview_binary] Preview target is not a text file.'))");
    await until("document.querySelector('[role=alert] p')?.textContent === 'This is a binary file and cannot be previewed as text.'", 'binary errors do not expose IPC boilerplate');
    assert.equal(await run('errorDialogs.length'), binaryDialogsBefore, 'unsupported file previews stay in their panel');
    await run("window.externalFiles = []; cardbushDesktop.openPath = async path => { externalFiles.push(path); return ''; }; document.querySelector('.inspector-open-external').click()");
    await until('externalFiles.length === 1', 'unsupported file opens only on explicit click');
    assert.deepEqual(await run('externalFiles'), ['D:/fixture/binary.txt']);
    await until("!document.querySelector('.inspector-open-external').disabled", 'external opener has finished');
    await run("cardbushDesktop.openPath = async () => 'No application associated with this file'; document.querySelector('.inspector-open-external').click()");
    await until(`errorDialogs.length === ${binaryDialogsBefore + 1}`, 'external opener failure is a dialog, not navigation');
    await run("preview('D:/fixture/invalid.txt')");
    await until("reads.some(read => read.path.endsWith('invalid.txt'))", 'malformed text read');
    const encodingDialogsBefore = await run('errorDialogs.length');
    await run("for (const read of reads.filter(read => read.path.endsWith('invalid.txt'))) read.reject(new Error('[text_preview_encoding] Unsupported encoding'))");
    await until("document.querySelector('.inspector-file-fallback [role=alert]')?.textContent.includes('encoding')", 'unreadable text uses the same fallback');
    assert.equal(await run('errorDialogs.length'), encodingDialogsBefore, 'expected decoding limits stay in the preview');

    await run("preview('D:/fixture/pending.md')");
    await until("reads.some(read => read.path.endsWith('pending.md'))", 'pending read before fallback');
    const readsBeforeFallback = await run('reads.length');
    await run("window.externalFiles = []; cardbushDesktop.openPath = async path => { externalFiles.push(path); return ''; }; void 0");
    for (const target of ['D:/fixture/unregistered.project', 'file:///D:/fixture/未识别%20%23%201.futureformat', 'cardbush-file://text-preview/?path=D%3A%2Ffixture%2Funregistered.custom']) {
      await run(`preview(${JSON.stringify(target)})`);
      await until(`!!document.querySelector('.inspector-file-fallback') && navigation.at(-1)?.url === ${JSON.stringify(target)} && navigation.at(-1)?.loading === false`, 'unknown format fallback is ready');
      assert.equal(await run('reads.length'), readsBeforeFallback, 'unregistered format does not read or decode its content');
      assert.equal(await run("!!document.querySelector('webview, .right-inspector-preview-loading, [role=alert]')"), false, 'unsupported formats are a normal UI state, without guests or error dialogs');
      assert.equal(await run('externalFiles.length'), 0, 'opening a preview never starts an external application');
      await run('inspectorRef.current.reload()');
      await until('navigation.at(-1)?.loading === false', 'fallback refresh settles');
      assert.equal(await run('reads.length'), readsBeforeFallback, 'refresh does not change unknown-format policy');
    }
    const fallbackNavigationCount = await run('navigation.length');
    await run("resolveReads('D:/fixture/pending.md', '# Stale result')");
    await pause();
    assert.equal(await run('navigation.length'), fallbackNavigationCount, 'old text read cannot alter fallback navigation');
    assert.equal(await run("document.querySelector('.inspector-file-fallback-name').textContent"), 'unregistered.custom');
    await run("document.querySelector('.inspector-open-external').click()");
    await until('externalFiles.length === 1', 'fallback opens file on explicit click');
    assert.deepEqual(await run('externalFiles'), ['D:/fixture/unregistered.custom'], 'opener receives decoded local path');
    assert.equal(await run('errorDialogs.length'), encodingDialogsBefore, 'unknown formats do not create popup errors');
    await run("preview('D:/fixture/missing.md')");
    await until("reads.some(read => read.path.endsWith('missing.md'))", 'error preview read');
    await run("for (const read of reads.filter(read => read.path.endsWith('missing.md'))) read.reject(new Error('Fixture file unavailable'))");
    await until("document.querySelector('[role=alert]')?.textContent === 'Fixture file unavailable'", 'localized preview error boundary');
    await run("preview('D:/fixture/abandoned.md')");
    await until("reads.some(read => read.path.endsWith('abandoned.md'))", 'pending unmount read');
    await run('renderView(null)');
    await pause();
    const unmountedNavigationCount = await run('navigation.length');
    await run("resolveReads('D:/fixture/abandoned.md', '# Must stay unmounted')");
    await pause();
    assert.equal(await run('navigation.length'), unmountedNavigationCount);
    await require('./helpers/resizer-lifecycle.cjs')({ run, until, pause });
    await require('./helpers/inspector-snap.cjs')({ run, until, pause, window, root });
    await require('./helpers/sidebar-snap.cjs')({ run, until, pause, window });
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'inspector-resize') {
      assert.deepEqual(await run('failures'), [], 'no inspector resize renderer errors');
      assert.deepEqual(errors, []);
      return;
    }

    await run(`
      window.inspectorArgs = null;
      const topbarProps = { title: 'Fixture', language: 'en', inspectorOpen: false,
        onToggleInspector: (...args) => { inspectorArgs = args; }, onToggleWorkSummary: () => {} };
      renderView(h(views.TopBar, topbarProps));
      window.showToolbar = (inspectorOpen = true) => renderView(h(views.TopBar, { ...topbarProps, inspectorOpen, conversationContentAvailable: true }));
      void 0;
    `);
    await pause();
    assert.equal(await run("document.querySelectorAll('[data-inspector-toggle]').length"), 1, 'welcome has a permanent sidebar button');
    assert.equal(await run("document.querySelectorAll('[data-work-summary-toggle]').length"), 0, 'welcome still hides the work summary');
    assert.equal(await run("document.querySelector('[data-inspector-toggle]').getAttribute('aria-expanded')"), 'false');
    await run("document.querySelector('[data-inspector-toggle]').click()");
    assert.deepEqual(await run('inspectorArgs'), [], 'the toggle must not receive a React click event');
    await run('showToolbar(false)');
    await until("document.querySelectorAll('.topbar button').length === 2", 'both conversation actions visible');
    assert.equal(await run("document.querySelector('[data-work-summary-toggle]').nextElementSibling?.matches('[data-inspector-toggle]')"), true, 'work summary precedes the right sidebar toggle');
    await run('showToolbar()');
    await until("!document.querySelector('[data-inspector-toggle]')", 'the expanded inspector owns its close control without a duplicate in the title');
    assert.equal(await run("document.querySelector('.topbar .lucide-menu')"), null, 'the old left sidebar hamburger is removed from conversation titles');
    await require('./helpers/window-sidebar-toggle.cjs')({ run, until, pause, window, root });
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'titlebar') {
      assert.deepEqual(await run('failures'), [], 'no title bar renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    await require('./helpers/inspector-start-layout.cjs')({ run, until, pause, window, root });
    }

    await run(`
      const noop = async () => {};
      window.chatProps = {
        language: 'en', theme: 'dark', title: 'Fixture session',
        sidebarCollapsed: false, windowMaximized: false, activeConversationId: 'draft',
        selectedProjectDir: 'D:/fixture', activeProjectDir: 'D:/fixture', projectPathAliases: [],
        availableProjects: [{ id: 'project', title: 'Fixture project', rootPath: 'D:/fixture' }],
        projectContext: '', messages: [], activeGoal: null, goalAvailable: false,
        goalCancelling: false, goalWaiting: false, changeReports: [], skills: [], disabledSkillNames: new Set(),
        visualInputAvailable: false, visualInputEnabled: false, turnHistoryAvailable: false,
        subagentObservabilityAvailable: false, shadowAvailable: false, shadowAccentColor: '#999999',
        shadowThemeVariables: {}, thinkingVisible: false, guidanceDeliveryMode: 'queue',
        loading: true, historyLoading: false, sending: false, stopping: false, activeTurnId: '',
        queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], pendingInteraction: null,
        error: null, notice: null, selectedModel: 'fixture', availableModels: [],
        referencePlanAvailable: false, referencePlanMode: 'off', permissionMode: 'task_free',
        subagentPermissionRouting: 'user', reasoningLevelAvailable: false, reasoningLevel: 'high',
        reasoningLevels: [], gitAvailable: false, draft: '',
      };
      for (const name of ${JSON.stringify(loadChatCallbackNames())}) chatProps[name] = noop;
      window.updateChat = patch => { Object.assign(chatProps, patch); renderView(h(views.ChatPanel, chatProps)); };
      updateChat({});
    `);
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'app-center') {
      await require('./helpers/app-center.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no app center renderer errors'); assert.deepEqual(errors, []); return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'quick-context') {
      await require('./helpers/quick-context-layout.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no context rail renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'ssh') {
      await require('./helpers/ssh-ui.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []); return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'compact-window') {
      await require('./helpers/compact-window.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no compact window renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    await until("!!document.querySelector('.welcome-composer textarea')", 'welcome composer during background startup');
    assert.equal(await run("!!document.querySelector('.loading-view')"), false, 'initial catalog loading never replaces the page');
    await run(`window.startupComposer = document.querySelector('.welcome-composer textarea'); updateChat({ loading: false });`);
    await until("document.querySelector('.welcome-composer textarea') === startupComposer", 'composer remains mounted after startup');
    await run('updateChat({ loading: true, historyLoading: true })');
    await until("document.querySelector('.loading-view')?.textContent.includes('Loading conversation')", 'history loading');
    await run('updateChat({ loading: false, historyLoading: false })');
    await until("!!document.querySelector('.workspace-location-control > button')", 'welcome composer');
    await run("document.querySelector('.workspace-location-control > button').click()");
    await until("!!document.querySelector('.ssh-dialog')", 'welcome project menu');
    await run("(document.querySelector('.ssh-dialog') || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('.ssh-dialog')", 'Escape closes only the project menu');
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'composer-resize') {
      await require('./helpers/composer-resize.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'composer-resize') {
      assert.deepEqual(await run('failures'), [], 'no composer resize renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'work-summary-layout') {
      await require('./helpers/work-summary-layout.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'work-summary-layout') {
      assert.deepEqual(await run('failures'), [], 'no work summary layout renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'session-scroll') {
      for (const theme of ['theme-dark', 'theme-cyberpunk']) await require('./helpers/chat-session-scroll.cjs')({ run, until, pause, theme });
      assert.deepEqual(await run('failures'), [], 'no session scroll renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'file-drop') {
      await require('./helpers/chat-file-drop.cjs')({ run, until, pause });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'file-drop') {
      assert.deepEqual(await run('failures'), [], 'no file drop renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    await run(`
      const messages = [
        { id: 'user-a', role: 'user', content: 'Fixture user question', turnId: 'turn-a', createdAt: '2026-09-05T00:00:00Z' },
        { id: 'assistant-a', role: 'assistant', content: 'Fixture assistant answer', turnId: 'turn-a', createdAt: '2026-09-05T00:00:01Z' },
      ];
      updateChat({ activeConversationId: 'session-a', messages });
    `);
    await until("document.querySelector('.message-list')?.textContent.includes('Fixture assistant answer')", 'draft to loaded session');
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'previous-conversation') {
      await require('./helpers/previous-conversation.cjs')({ run, until, pause });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'previous-conversation') {
      assert.deepEqual(await run('failures'), [], 'no previous conversation renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'composer-input') {
      await require('./helpers/composer-input.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'composer-input') {
      assert.deepEqual(await run('failures'), [], 'no composer input renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'startup') {
      await run(`window.startupMessage = document.querySelector('.message-list'); updateChat({ loading: true, historyLoading: true });`);
      assert.equal(await run("document.querySelector('.message-list') === startupMessage && !document.querySelector('.loading-view')"), true, 'refresh preserves loaded conversation content');
      assert.deepEqual(await run('failures'), []);
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'solution-selection') {
      await require('./helpers/solution-selection.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'solution-selection') {
      assert.deepEqual(await run('failures'), [], 'no solution selection renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'guidance-rendering') {
      await require('./helpers/chat-guidance-rendering.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'guidance-rendering') {
      assert.deepEqual(await run('failures'), [], 'no guidance renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'tool-disclosure') {
      await require('./helpers/chat-tool-disclosure.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'tool-disclosure') {
      assert.deepEqual(await run('failures'), [], 'no tool disclosure renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'tool-update-stability') {
      await require('./helpers/chat-transcript-batching.cjs')({ run, until, pause });
      await require('./helpers/chat-tool-update-stability.cjs')({ run, until, pause, window, root });
      await require('./helpers/chat-tool-update-stability.cjs')({ run, until, pause, window, root, theme: 'theme-dark' });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'tool-update-stability') {
      await require('./helpers/chat-tool-packages.cjs')({ run, until, pause });
      assert.deepEqual(await run('failures'), [], 'no tool update renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || ['window-scroll', 'window-scroll-references'].includes(process.env.CARDBUSH_APP_VIEWS_CASE)) {
      await require('./helpers/chat-window-reference-scroll.cjs')({ run, until, pause, window });
      await require('./helpers/chat-window-reference-scroll.cjs')({ run, until, pause, window, theme: 'theme-bright' });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'window-scroll-references') {
      assert.deepEqual(await run('failures'), [], 'no reference refresh renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'window-scroll-logs') {
      await require('./helpers/chat-window-scroll-diagnostics.cjs')({ run, until, pause, window });
      assert.deepEqual(await run('failures'), [], 'no window diagnostic renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (!process.env.CARDBUSH_APP_VIEWS_CASE || process.env.CARDBUSH_APP_VIEWS_CASE === 'submission-motion') {
      await require('./helpers/chat-submission-motion.cjs')({ run, until, pause, window, root });
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'submission-motion') {
      assert.deepEqual(await run('failures'), [], 'no submission renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'scroll-motion') {
      await require('./helpers/chat-scroll-motion.cjs')({ run, until, pause, window });
      assert.deepEqual(await run('failures'), [], 'no scroll motion renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'keyboard-shortcuts') {
      await require('./helpers/keyboard-shortcuts.cjs')({ run, until, pause, window, root });
      assert.deepEqual(await run('failures'), [], 'no keyboard shortcuts renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'window-scroll') {
      await require('./helpers/chat-window-scroll.cjs')({ run, until, pause, window });
      await require('./helpers/chat-window-scroll.cjs')({ run, until, pause, window, theme: 'theme-dark' });
      await require('./helpers/chat-stream-append.cjs')({ run, until, pause, window, root });
      await require('./helpers/chat-session-scroll.cjs')({ run, until, pause });
      assert.deepEqual(await run('failures'), [], 'no window scroll renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    await require('./helpers/queue-interaction.cjs')({ run, until, pause, window, root });
    if (process.env.CARDBUSH_APP_VIEWS_CASE === 'queue') {
      assert.deepEqual(await run('failures'), [], 'no queue renderer errors');
      assert.deepEqual(errors, []);
      return;
    }
    await run("window.retainedList = document.querySelector('.message-list'); updateChat({ title: 'Updated title' })");
    await pause();
    assert.equal(await run("retainedList === document.querySelector('.message-list')"), true, 'unrelated root props must not remount the list');
    await run("updateChat({ sending: true, activeTurnId: 'turn-a' })");
    await pause();
    await run("updateChat({ sending: false, activeTurnId: '' })");
    await until("document.querySelector('.message-list')?.textContent.includes('Fixture assistant answer')", 'stop keeps transcript');
    assert.equal(await run("document.querySelectorAll('.message-list').length"), 1);
    await run(`
      const localId = 'loop-optimistic';
      window.loopState = { 'session-a': [
        { id: 'loop-user', role: 'user', content: 'Desktop demo', turnId: 'loop-turn' },
        { id: localId, role: 'assistant', content: '', turnId: 'loop-turn' },
      ] };
      window.loopRoutes = Array.from({ length: 11 }, (_, index) => ({
        messageId: 'loop-round-' + index, turnId: 'loop-turn', segmentOrdinal: 1,
      }));
      for (let index = 0; index < loopRoutes.length; index++) {
        loopState = views.appendAssistantDelta(loopState, 'session-a', localId,
          index === 10 ? 'Only the final answer.' : 'Loop narration ' + index + '.', loopRoutes[index],
          { reason: 'segment_completed', segmentId: 'block-' + index, segmentOrdinal: 1 });
      }
      updateChat({ messages: loopState['session-a'], sending: true, activeTurnId: 'loop-turn' });
    `);
    await until("document.querySelector('.assistant-active-transcript')?.textContent.includes('Loop narration 0.')", 'live loop transcript');
    await run(`
      loopState = views.markLocalAssistantTurnCompleted(loopState, 'session-a', 'loop-optimistic',
        new Date().toISOString(), loopRoutes[10], 'Only the final answer.');
      loopState = views.applyTurnTerminalSnapshot(loopState, 'session-a', 'loop-optimistic', {
        turnId: 'loop-turn', status: 'completed', stopped: false, completedAt: new Date().toISOString(),
      });
      updateChat({ messages: loopState['session-a'], sending: false, activeTurnId: '' });
    `);
    await until("document.querySelector('.assistant-final-answer')?.textContent === 'Only the final answer.'", 'final answer excludes loop narration');
    assert.equal(await run("document.querySelectorAll('.message-row.assistant').length"), 1, 'one completed answer row');
    assert.equal(await run("document.querySelector('.message-list').textContent.includes('Loop narration')"), false, 'process text does not leak into completed chat');
    await require('./helpers/chat-stream-append.cjs')({ run, until, pause, window, root });
    await require('./helpers/chat-tool-packages.cjs')({ run, until, pause });
    await require('./helpers/chat-session-scroll.cjs')({ run, until, pause });
    await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/themes/cyberpunk.css'), 'utf8'));
    await require('./helpers/chat-stream-append.cjs')({ run, until, pause, window, root, theme: 'theme-cyberpunk' });
    await require('./helpers/chat-tool-packages.cjs')({ run, until, pause, theme: 'theme-cyberpunk' });
    await require('./helpers/chat-session-scroll.cjs')({ run, until, pause, theme: 'theme-cyberpunk' });
    await run("window.viewTheme = 'theme-dark'; void 0;");
    await run("updateChat({ activeConversationId: 'session-b', messages: [{ id: 'user-b', role: 'user', content: 'Other session only', createdAt: '2026-09-05T00:00:02Z' }] })");
    await until("document.querySelector('.message-list')?.textContent.includes('Other session only')", 'session switch');
    assert.equal(await run("document.querySelector('.message-list').textContent.includes('Fixture assistant answer')"), false, 'no cross-session transcript');
    await run(`updateChat({ sending: false, messages: [{ id: 'context-failure', role: 'assistant', content: '', status: 'failed',
      metadata: { stop_reason: 'current_turn_context_limit_exceeded', stop_details: { estimatedPromptTokens: 225000, usableInputTokens: 224000 } } }] });`);
    await until("document.querySelector('[data-failure-reason=current_turn_context_limit_exceeded]')?.textContent.includes('225,000')", 'context failure explains the measured budget');
    assert.equal(await run("document.querySelector('[data-failure-reason=current_turn_context_limit_exceeded]').textContent.includes('224,000')"), true);
    await run(`updateChat({ messages: [{ id: 'output-failure', role: 'assistant', content: '', status: 'failed',
      metadata: { stop_reason: 'model_output_limit_exceeded', stop_details: { continuationAttempts: 2 } } }] });`);
    await until("document.querySelector('[data-failure-reason=model_output_limit_exceeded]')?.textContent.includes('2 times')", 'output failure explains bounded continuation');
    await require('./helpers/quick-context-layout.cjs')({ run, until, pause, window, root });
    await require('./helpers/sidebar-title-layout.cjs')({ run, until, pause, window, root });
    await run(`
      window.retryNotice = {
        state: 'retrying', source: 'provider', sessionId: 'fixture', attempt: 8,
        maxAttempts: null, nextRetryMs: 1500, createdAt: new Date().toISOString(),
        reason: 'ECONNRESET', message: 'Connection error. (ECONNRESET)',
      };
      window.showRetryNotice = () => renderView(h(views.ConversationConnectionNotice, { language: 'zh', update: retryNotice }));
      showRetryNotice();
    `);
    await until("document.querySelector('.conversation-connection-notice')?.textContent.includes('秒后重试')", 'retry countdown');
    assert.equal(await run("document.querySelector('.conversation-connection-notice').textContent.includes('ECONNRESET')"), true, 'retry delay must not conceal the underlying failure');
    assert.equal(await run("document.querySelector('.conversation-connection-notice').textContent.includes('将持续重试，可点击停止')"), true);
    await until("document.querySelector('.conversation-connection-notice')?.textContent.includes('正在重新请求模型')", 'elapsed retry delay becomes an in-flight request');
    await run(`retryNotice = { ...retryNotice, state: 'failed', message: 'Authentication failed' }; showRetryNotice();`);
    await until("document.querySelector('.conversation-connection-notice')?.getAttribute('role') === 'alert'", 'terminal failure alert');
    assert.equal(await run("document.querySelector('.conversation-connection-notice').textContent.includes('将持续重试')"), false);
    await run('renderView(null)');
    await pause(400);
    assert.deepEqual(await run('failures'), [], 'no renderer exceptions or rejected effects');
    await require('./helpers/capability-refresh.cjs')({ run, until, pause });
    await require('./helpers/task-workspace-view.cjs')({ run, until, pause, window, root });
    assert.deepEqual(await run('failures'), [], 'workspace controls must not produce renderer exceptions');
    assert.deepEqual(errors, []);
    console.log('App views passed: module ownership, StrictMode, preview races/reload/error/unmount, lazy syntax, toolbar, welcome, session switch and stop.');
  } finally { window.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

function loadChatCallbackNames() {
  const file = path.join(root, 'src/features/chat/ChatPanel.tsx');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const chat = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'ChatPanel');
  return chat.parameters[0].name.elements.map(element => element.name.text).filter(name => /^on[A-Z]/.test(name));
}
