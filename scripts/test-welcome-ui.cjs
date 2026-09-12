// Real welcome/composer views in isolated Chromium; history is a fixture and
// there are no model calls, product-profile reads, or visible helper windows.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function bundle() {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const appSource = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = appSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CardbushApp').body.statements;
  const modeCallbacks = ['activateConversationScope', 'changeOnlyTalkMode'].map(name => statements.find(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(appSource) === name).getText(appSource));
  const modeRecovery = statements.find(node => ts.isExpressionStatement(node) && node.getText(appSource).includes('const activeMatchesMode = onlyTalkMode')).getText(appSource);
  const modeFixture = `import { useCallback, useEffect } from 'react';
    import { firstConversationInScope, conversationMatchesScope } from ${JSON.stringify(path.join(root, 'src/features/conversationScope.ts'))};
    import { isOnlyTalkConversation } from ${JSON.stringify(path.join(root, 'src/features/conversationWorkspace.ts'))};
    export function useModeSwitchFixture({ chat, onlyTalkMode, section, setSection, setOnlyTalkMode, fallbackProjectId, fallbackProjectDir }: any) {
      const onlyTalkModeStorageKey = 'fixture-only-talk';
      ${modeCallbacks.join('\n')}
      ${modeRecovery}
      return changeOnlyTalkMode;
    }`;
  const result = await build({ configFile: false, logLevel: 'error', plugins: [react(), {
    name: 'welcome-fixture', enforce: 'pre',
    resolveId: id => id.endsWith('__welcome__.ts') ? '\0welcome-entry.ts' : id.endsWith('/backend/welcomeHistory') ? '\0welcome-history' : undefined,
    load: id => id === '\0welcome-entry.ts' ? `export * from ${JSON.stringify(path.join(root, 'src/features/chat/WelcomeComposer.tsx'))};\n${modeFixture}`
      : id === '\0welcome-history' ? `export async function fetchWelcomeHistory(signal) { window.historyRequests++; const rows = await window.historyGate; return rows; }` : undefined,
  }], build: { write: false, minify: false, lib: { entry: path.join(root, '__welcome__.ts'), formats: ['cjs'] },
    rolldownOptions: { external: /^react(?:-dom)?(?:\/|$)/, output: { codeSplitting: false } } } });
  return (Array.isArray(result) ? result : [result]).flatMap(item => item.output).find(item => item.type === 'chunk').code;
}

app.whenReady().then(async () => {
  const code = await bundle();
  process.env.NODE_ENV = 'development';
  const win = new BrowserWindow({ width: 1180, height: 760, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false, partition: 'welcome-ui-fixture' } });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const network = /^https?:/.test(details.url);
    if (network) errors.push(details.url);
    done({ cancel: network });
  });
  const run = code => win.webContents.executeJavaScript(code);
  const until = async (condition, label) => {
    for (let index = 0; index < 100; index++) { if (await run(condition)) return; await pause(30); }
    throw Error('Timed out: ' + label);
  };
  try {
    await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await win.webContents.insertCSS(['theme.css', 'app.css', 'windowMaterial.css'].map(file => fs.readFileSync(path.join(root, 'src/styles', file), 'utf8')).join('\n'));
    await run(`
      window.failures = []; window.historyRequests = 0; window.sent = 0;
      addEventListener('error', event => failures.push(event.message));
      addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
      for (const name of ['localStorage', 'sessionStorage']) {
        const values = new Map(); Object.defineProperty(window, name, { value: {
          getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
        }});
      }
      window.historyGate = new Promise(resolve => { window.deliverHistory = resolve; });
      const nativeMatchMedia = window.matchMedia.bind(window), motion = new EventTarget();
      motion.matches = false; motion.media = '(prefers-reduced-motion: reduce)';
      window.matchMedia = query => query === motion.media ? motion : nativeMatchMedia(query);
      window.setReduced = value => { motion.matches = value; motion.dispatchEvent(new Event('change')); };
      let hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => hidden });
      window.setHidden = value => { hidden = value; document.dispatchEvent(new Event('visibilitychange')); };
      const clear = CanvasRenderingContext2D.prototype.clearRect, move = CanvasRenderingContext2D.prototype.moveTo;
      window.draws = 0; window.points = [];
      CanvasRenderingContext2D.prototype.clearRect = function(...args) {
        if (this.canvas.className === 'welcome-star-wordmark') { window.draws++; window.points = []; }
        return clear.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.moveTo = function(x,y) {
        if (this.canvas.className === 'welcome-star-wordmark') window.points.push([x,y]);
        return move.call(this,x,y);
      };
      const React = require(${JSON.stringify(require.resolve('react'))});
      const { createRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const module = { exports: {} };
      new Function('require','module','exports', ${JSON.stringify(code)})(require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))}), module, module.exports);
      const { WelcomeComposer, useModeSwitchFixture } = module.exports, h = React.createElement, noop = () => {};
      window.modeRenders = []; window.modeClears = 0; window.modePrepares = 0;
      const project = { id:'draft-project', title:'Project', preview:'', updatedAt:'', projectId:'project', projectDir:'D:/fixture', metadata:{workspace_mode:'project'} };
      const task = { id:'draft-task', title:'Task', preview:'', updatedAt:'', metadata:{workspace_mode:'task'} };
      function Fixture() {
        const [drafts, setDrafts] = React.useState({}), [theme, setTheme] = React.useState('dark'), [shown, setShown] = React.useState(true);
        const [activeId, setActiveId] = React.useState(task.id), [prepared, setPrepared] = React.useState([project, task]);
        const [onlyTalkMode, setOnlyTalkMode] = React.useState(true), [section, setSection] = React.useState('chat');
        const draft = drafts[activeId] || '', setDraft = text => setDrafts(current => ({ ...current, [activeId]:text }));
        const chat = { preparedConversations:prepared, conversations:[], activeConversationId:activeId,
          activeConversation:prepared.find(item => item.id === activeId), loading:false,
          openConversation:id => setActiveId(id), clearConversationSelection:() => { window.modeClears++; setActiveId(''); },
          prepareConversation:dir => { window.modePrepares++; const target = dir ? project : task;
            setPrepared(current => current.some(item => item.id === target.id) ? current : [...current, target]); setActiveId(target.id); },
        };
        window.changeMode = useModeSwitchFixture({ chat, onlyTalkMode, section, setSection, setOnlyTalkMode, fallbackProjectId:'project', fallbackProjectDir:'D:/fixture' });
        window.dropTaskDraft = () => setPrepared(current => current.filter(item => item.id !== task.id));
        React.useLayoutEffect(() => { modeRenders.push({ id:activeId, onlyTalkMode }); });
        window.changeDraft = setDraft; window.changeTheme = setTheme; window.showWelcome = setShown; window.draftValue = draft;
        return h('div', { className: 'app theme-' + theme },
          h('header', { className: 'window-frame' }, 'cardbush'),
          h('main', { className: 'desktop-shell' },
            h('aside', { className: 'sidebar', style: { width: 220, minWidth: 220, padding: 20 } }, h('p', null, '新会话'), h('p', null, '搜索'), h('p', null, '定时与自动化')),
            h('section', { className: 'main-stage' }, h('div', { className: 'chat-panel' },
              h('header', { className: 'topbar' }, h('strong', null, '新会话')),
              h('div', { className: 'chat-body' }, h('div', { className: 'chat-content-frame' }, shown && h(WelcomeComposer, {
                key: activeId || 'new-session', language: 'zh', onlyTalkMode, draft, onDraftChange: setDraft, sending: false, stopping: false, guidanceDeliveryMode: 'immediate', cancelEnabled: false,
                queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], selectedModel: 'fixture', availableModels: [], goalAvailable: false, referencePlanAvailable: false,
                referencePlanMode: 'off', permissionMode: 'full-access', subagentPermissionRouting: 'inherit', reasoningLevelAvailable: false, reasoningLevel: 'medium', reasoningLevels: [],
                selectedProjectDir: '', availableProjects: [], onProjectChange: async()=>{}, skills: [], disabledSkillNames: new Set(), onToggleSkill: noop, onModelChange: noop,
                onReferencePlanModeChange: noop, onPermissionModeChange: noop, onSubagentPermissionRoutingChange: noop, onReasoningLevelChange: noop, onConfigureModels: noop,
                onEditQueuedMessage: noop, onGuideQueuedMessage: async()=>{}, onRemoveQueuedMessage: noop, onSend: async()=>{window.sent++}, onCancel: async()=>{},
              })))))));
      }
      window.reactRoot = createRoot(document.getElementById('root'));
      reactRoot.render(h(React.StrictMode, null, h(Fixture)));
    `);
    await until("document.querySelectorAll('.welcome-suggestion').length === 3 && draws > 3", 'welcome cards and animation');
    assert.equal(await run("document.querySelector('.welcome-star-wordmark').getAttribute('aria-label')"), 'cardbush');
    assert.ok(await run('points.length > 100'), 'word must contain visible stars');
    for (let index = 0; index < 6; index++) {
      const onlyTalk = index % 2 === 1;
      await run(`modeRenders.length = 0; changeMode(${onlyTalk})`);
      await until(`modeRenders.at(-1)?.id === ${JSON.stringify(onlyTalk ? 'draft-task' : 'draft-project')}`, 'mode destination');
      await pause(45);
      assert.ok(await run(`modeRenders.every(item => item.id === ${JSON.stringify(onlyTalk ? 'draft-task' : 'draft-project')} && item.onlyTalkMode === ${onlyTalk})`), 'no empty intermediate welcome frame');
    }
    assert.equal(await run('modeClears'), 0);
    await run("changeDraft('仅会话草稿')"); await pause(30);
    await run('changeMode(false)'); await until('draftValue === ""', 'separate project draft');
    await run("changeDraft('项目草稿')"); await pause(30);
    await run('changeMode(true)'); await until('draftValue === "仅会话草稿"', 'task draft retained');
    await run('changeMode(false)'); await until('draftValue === "项目草稿"', 'project draft retained');
    await run('dropTaskDraft()'); await pause(30);
    await run('modeRenders.length = 0; changeMode(true)'); await until('modeRenders.at(-1)?.id === "draft-task"', 'prepare first task draft');
    assert.equal(await run('modePrepares'), 1, 'first empty scope prepares exactly once');
    assert.equal(await run('modeClears'), 0, 'first empty scope also skips transient blank selection');
    await run("changeDraft('')"); await pause(30);
    const history = [
      ['帮我优化缓存命中率，排查动态上下文的变化。', 'a'], ['检查缓存命中率与上下文拼接，保留稳定前缀。', 'b'],
      ['分析缓存命中率下降的原因。', 'c'], ['修复插件代理连接失败，检查网络配置。', 'a'], ['给插件增加独立的代理配置。', 'b'],
      ['根据参考图片生成一张苹果照片。', 'a'], ['根据参考照片调整图片的背景。', 'b'],
    ].map(([content, sessionId], i) => ({ content, sessionId, messageId: String(i), createdAt: new Date(Date.now() - 3600000).toISOString(), truncated: false }));
    await run(`deliverHistory(${JSON.stringify(history)})`);
    await until("document.querySelector('.welcome-suggestions-caption').textContent.includes('7 天')", 'history suggestions');
    await run("document.querySelector('.welcome-suggestion').click()");
    await until("document.activeElement?.hasAttribute('data-composer-input') && draftValue.length > 0", 'suggestion only fills and focuses draft');
    assert.equal(await run('sent'), 0);
    const draft = await run('draftValue');
    await run("document.querySelectorAll('.welcome-suggestion')[1].click()");
    assert.equal(await run('draftValue'), draft, 'existing draft must not be overwritten');
    await run("changeDraft('')");
    await until('draftValue === ""', 'draft cleared');

    // Movement changes star positions; removing the pointer restores the word.
    await run('window.homePoints = points.map(point => [...point])');
    await run(`const canvas = document.querySelector('canvas'), rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new PointerEvent('pointermove', {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, pointerType:'mouse'}));`);
    await pause(350);
    assert.ok(await run('points.some((point,i) => Math.hypot(point[0]-homePoints[i][0],point[1]-homePoints[i][1]) > 3)'), 'pointer scatters the lettering');
    await run("document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerleave'))");
    await pause(900);
    assert.ok(await run('points.every((point,i) => Math.hypot(point[0]-homePoints[i][0],point[1]-homePoints[i][1]) < 2)'), 'word reassembles');
    await run('setReduced(true)'); await pause(50);
    let before = await run('draws'); await pause(180);
    assert.equal(await run('draws'), before, 'reduced motion stops animation');
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp/welcome-redesign-dark.png'), (await win.webContents.capturePage()).toPNG());
    await run("changeTheme('bright')"); await pause(150);
    fs.writeFileSync(path.join(root, 'tmp/welcome-redesign-light.png'), (await win.webContents.capturePage()).toPNG());

    win.setSize(780, 620); await pause(180);
    assert.equal(await run("getComputedStyle(document.querySelector('.welcome-suggestions-list')).gridTemplateColumns.split(' ').length"), 1);
    assert.ok(await run("document.querySelector('.welcome-hero').scrollWidth <= document.querySelector('.welcome-hero').clientWidth + 1"), 'narrow welcome does not overflow horizontally');
    assert.ok(await run("document.querySelector('.welcome-input-stack').getBoundingClientRect().bottom <= innerHeight"), 'composer stays reachable at short height');
    fs.writeFileSync(path.join(root, 'tmp/welcome-redesign-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await run('setReduced(false)'); await pause(90); await run('setHidden(true)');
    before = await run('draws'); await pause(160);
    assert.equal(await run('draws'), before, 'hidden page pauses animation');
    await run('setHidden(false)'); await pause(120);
    assert.ok(await run('draws') > before, 'visible page resumes animation');
    await run('showWelcome(false)'); await until("!document.querySelector('canvas')", 'welcome unmount');
    before = await run('draws'); await pause(180);
    assert.equal(await run('draws'), before, 'no orphan animation after leaving welcome');
    assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
    console.log('Welcome UI passed: atomic only-talk switching, scoped drafts, history, draft/focus, dark/light/narrow layout, pointer regroup, reduced motion, visibility and unmount.');
  } finally { win.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
