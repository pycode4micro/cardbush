// Actual extracted views in isolated Chromium: no product profile, real files,
// network requests, model calls or Runtime subscriptions.
const { app, BrowserWindow } = require('electron');
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
  const exports = [...appViewFiles.slice(1), 'src/features/sidebar/ChatSidebar.tsx']
    .map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n');
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [react(), {
      name: 'app-view-test-entry',
      resolveId: value => value.endsWith('__app_view_test__.ts') ? entryId : undefined,
      load: value => value === entryId ? exports : undefined,
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
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, backgroundThrottling: false,
      offscreen: true, partition: 'cardbush-app-view-test',
    },
  });
  const errors = [];
  window.webContents.on('console-message', event => {
    if (/Maximum update depth|Invalid hook call|ResizeObserver loop|passive event listener/.test(event.message)) errors.push(event.message);
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
    throw new Error('Timed out: ' + label + '\n' + await run('document.body.innerText'));
  };
  try {
    await window.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
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
      window.renderView = child => reactRoot.render(h(React.StrictMode, null, h('div', { className: 'app theme-dark', style: { height: '100vh', width: '900px' } }, child)));
      window.views = views;
      window.h = h;
      window.inspectorRef = React.createRef();
      window.reads = [];
      window.navigation = [];
      window.cardbushDesktop = {
        readTextPreview: path => new Promise((resolve, reject) => reads.push({ path, resolve, reject })),
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
      preview('D:/fixture/first.md');
    `);
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
      await until("!!document.querySelector('[data-render-mode=plain]')", 'large text skips parsing and highlighting');
      assert.equal(await run("document.querySelector('.source-plain-text').textContent === largePreviewText"), true, 'plain mode retains all byte-bounded text');
      assert.equal(await run("document.querySelectorAll('.source-code-line').length"), 0, 'large text must not allocate one DOM row per line');
      assert.ok(await run("document.querySelectorAll('*').length") < 100);
    }
    await run("preview('D:/fixture/binary.txt')");
    await until("reads.some(read => read.path.endsWith('binary.txt'))", 'binary file read');
    await run("for (const read of reads.filter(read => read.path.endsWith('binary.txt'))) read.reject(new Error('Error invoking remote method: [text_preview_binary] Preview target is not a text file.'))");
    await until("document.querySelector('[role=alert]')?.textContent === 'This is a binary file and cannot be previewed as text.'", 'binary errors do not expose IPC boilerplate');
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

    await run(`
      window.reviewArgs = null;
      const topbarProps = { title: 'Fixture', sidebarCollapsed: false, language: 'en', reviewAvailable: true,
        onRevealSidebar: () => {}, onOpenReview: (...args) => { reviewArgs = args; }, onToggleWorkSummary: () => {} };
      renderView(h(views.TopBar, topbarProps));
      window.showToolbar = () => renderView(h(views.TopBar, { ...topbarProps, conversationContentAvailable: true }));
      void 0;
    `);
    await pause();
    assert.equal(await run("document.querySelectorAll('[data-change-review-toggle], [data-work-summary-toggle]').length"), 0, 'welcome must hide conversation actions');
    await run('showToolbar()');
    await until("!!document.querySelector('[data-change-review-toggle]')", 'conversation toolbar');
    await run("document.querySelector('[data-change-review-toggle]').click()");
    assert.deepEqual(await run('reviewArgs'), [], 'review must not receive a React click event as a file path');

    await run(`
      const noop = async () => {};
      window.chatProps = {
        language: 'en', theme: 'dark', title: 'Fixture session', onlyTalkMode: false,
        sidebarCollapsed: false, windowMaximized: false, activeConversationId: 'draft',
        selectedProjectDir: 'D:/fixture', activeProjectDir: 'D:/fixture', projectPathAliases: [],
        availableProjects: [{ id: 'project', title: 'Fixture project', rootPath: 'D:/fixture' }],
        projectContext: '', messages: [], activeGoal: null, goalAvailable: false,
        goalCancelling: false, goalWaiting: false, changeReports: [], skills: [], disabledSkillNames: new Set(),
        visualInputAvailable: false, visualInputEnabled: false, contextSearchAvailable: false,
        subagentObservabilityAvailable: false, shadowAvailable: false, shadowAccentColor: '#999999',
        shadowThemeVariables: {}, thinkingVisible: false, guidanceDeliveryMode: 'queue',
        loading: true, historyLoading: true, sending: false, stopping: false, activeTurnId: '',
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
    await until("document.querySelector('.loading-view')?.textContent.includes('Loading conversation')", 'history loading');
    await run('updateChat({ loading: false, historyLoading: false })');
    await until("!!document.querySelector('.welcome-project-trigger')", 'welcome composer');
    await run("document.querySelector('.welcome-project-trigger').click()");
    await until("!!document.querySelector('.welcome-project-menu')", 'welcome project menu');
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('.welcome-project-menu')", 'Escape closes only the project menu');
    await run(`
      const messages = [
        { id: 'user-a', role: 'user', content: 'Fixture user question', turnId: 'turn-a', createdAt: '2026-09-05T00:00:00Z' },
        { id: 'assistant-a', role: 'assistant', content: 'Fixture assistant answer', turnId: 'turn-a', createdAt: '2026-09-05T00:00:01Z' },
      ];
      updateChat({ activeConversationId: 'session-a', messages });
    `);
    await until("document.querySelector('.message-list')?.textContent.includes('Fixture assistant answer')", 'draft to loaded session');
    await run("window.retainedList = document.querySelector('.message-list'); updateChat({ title: 'Updated title' })");
    await pause();
    assert.equal(await run("retainedList === document.querySelector('.message-list')"), true, 'unrelated root props must not remount the list');
    await run("updateChat({ sending: true, activeTurnId: 'turn-a' })");
    await pause();
    await run("updateChat({ sending: false, activeTurnId: '' })");
    await until("document.querySelector('.message-list')?.textContent.includes('Fixture assistant answer')", 'stop keeps transcript');
    assert.equal(await run("document.querySelectorAll('.message-list').length"), 1);
    await run("updateChat({ activeConversationId: 'session-b', messages: [{ id: 'user-b', role: 'user', content: 'Other session only', createdAt: '2026-09-05T00:00:02Z' }] })");
    await until("document.querySelector('.message-list')?.textContent.includes('Other session only')", 'session switch');
    assert.equal(await run("document.querySelector('.message-list').textContent.includes('Fixture assistant answer')"), false, 'no cross-session transcript');
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
