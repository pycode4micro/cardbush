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
  const navigationCallbacks = ['createConversation', 'openConversationPrompt', 'openPluginPrompt', 'createAutomationConversation', 'openConversation', 'changeWelcomeProject', 'handleSidebarCreateConversation'].map(name => statements.find(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(appSource) === name).getText(appSource));
  const hookSource = ts.createSourceFile('useCardbushChat.ts', fs.readFileSync(path.join(root, 'src/hooks/useCardbushChat.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const hookStatements = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat').body.statements;
  const draftCallbacks = ['prepareConversation', 'setConversationProject'].map(name => hookStatements.find(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(hookSource) === name).getText(hookSource));
  const localConversation = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'localConversation').getText(hookSource);
  const navigationFixture = `import { useCallback, useRef, useState } from 'react';
    import { conversationMatchesScope } from ${JSON.stringify(path.join(root, 'src/features/conversationScope.ts'))};
    import { conversationProjectDir } from ${JSON.stringify(path.join(root, 'src/features/conversationWorkspace.ts'))};
    import { samePath } from ${JSON.stringify(path.join(root, 'src/shared/localPaths.ts'))};
    import { automationSetupPrompt } from ${JSON.stringify(path.join(root, 'src/features/automations/automationPrompts.ts'))};
    ${localConversation}
    function useDraftFixture({ activeId, setActiveId, conversations, setConversations }: any) {
      const [preparedConversationsById, setPreparedConversationsById] = useState({});
      const preparedConversationsRef = useRef(preparedConversationsById);
      const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
      const [, setMessagesByConversation] = useState({}); const [, setError] = useState(null);
      const setMessageHistoryLoading = useCallback(() => {}, []), setActiveConversationId = setActiveId;
      const updateConversation = async () => { throw Error('Unexpected persisted mutation'); }, errorMessage = String;
      ${draftCallbacks.join('\n')}
      const prepared = Object.values(preparedConversationsById);
      return { prepareConversation, setConversationProject, conversations, preparedConversations: prepared,
        activeConversationId: activeId, activeConversation: [...conversations, ...prepared].find(item => item.id === activeId),
        openConversation: setActiveId };
    }
    export function useNavigationFixture({ activeId, setActiveId, conversations, setConversations, projectItems, setDraftsByConversation, setSection }: any) {
      const chat = useDraftFixture({ activeId, setActiveId, conversations, setConversations });
      const activeConversationProjectDir = conversationProjectDir(chat.activeConversation), language = 'zh';
      const [, setSettingsOpen] = useState(false), [, setConversationPromptFocus] = useState(0);
      ${navigationCallbacks.join('\n')}
      return { chat, createConversation, openConversation, changeWelcomeProject, createAutomationConversation, openPluginPrompt, newChat: handleSidebarCreateConversation,
        projectDir: conversationProjectDir(chat.activeConversation) };
    }`;
  const result = await build({ configFile: false, logLevel: 'error', plugins: [react(), {
    name: 'welcome-fixture', enforce: 'pre',
    resolveId: id => id.endsWith('__welcome__.ts') ? '\0welcome-entry.ts' : id.endsWith('/backend/welcomeHistory') ? '\0welcome-history' : undefined,
    load: id => id === '\0welcome-entry.ts' ? `export * from ${JSON.stringify(path.join(root, 'src/features/chat/WelcomeComposer.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/features/sidebar/ChatSidebar.tsx'))};\n${navigationFixture}`
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
    throw Error('Timed out: ' + label + '\n' + await run('JSON.stringify({failures, active:routing?.chat.activeConversation, draft:draftValue, text:document.body.innerText})'));
  };
  try {
    await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await win.webContents.insertCSS(['theme.css', 'app.css', 'windowMaterial.css'].map(file => fs.readFileSync(path.join(root, 'src/styles', file), 'utf8')).join('\n'));
    await run(`
      window.failures = []; window.historyRequests = 0; window.sent = 0;
      if (!crypto.randomUUID) crypto.randomUUID = () => require('node:crypto').randomUUID();
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
      const { WelcomeComposer, ChatSidebar, useNavigationFixture } = module.exports, h = React.createElement, noop = () => {};
      localStorage.setItem('cardbush_only_talk_mode', 'false');
      localStorage.setItem('cardbush_recent_project_dir', 'D:/fixture');
      window.navigationRenders = [];
      const project = { id:'saved-project-chat', title:'项目里的会话', preview:'', updatedAt:'', projectId:'project', projectDir:'D:/fixture', metadata:{workspace_mode:'project'} };
      const task = { id:'saved-task-chat', title:'独立会话', preview:'', updatedAt:'', metadata:{workspace_mode:'task'} };
      const projects = [{ id:'project', title:'Fixture', rootPath:'D:/fixture' }];
      function Fixture() {
        const [drafts, setDrafts] = React.useState({}), [theme, setTheme] = React.useState('dark'), [shown, setShown] = React.useState(true);
        const [activeId, setActiveId] = React.useState(''), [conversations, setConversations] = React.useState([project, task]);
        const [section, setSection] = React.useState('chat');
        const draftKey = activeId || '__new__', draft = drafts[draftKey] || '', setDraft = text => setDrafts(current => ({ ...current, [draftKey]:text }));
        const routing = useNavigationFixture({ activeId, setActiveId, conversations, setConversations, projectItems:projects, setDraftsByConversation:setDrafts, setSection });
        window.routing = routing;
        React.useLayoutEffect(() => { navigationRenders.push({ id:activeId, projectDir:routing.projectDir }); });
        window.changeDraft = setDraft; window.changeTheme = setTheme; window.showWelcome = setShown; window.draftValue = draft;
        return h('div', { className: 'app theme-' + theme },
          h('header', { className: 'window-frame' }, 'cardbush'),
          h('main', { className: 'desktop-shell' },
            h(ChatSidebar, { language:'zh', section, activeConversationId:activeId, projects, conversations, changeReportsByConversation:{},
              onSectionChange:setSection, onConversationChange:routing.openConversation, onCreateConversation:routing.newChat,
              onAddProject:noop, onProjectAction:(action, project)=>{ if(action==='newChat') routing.createConversation(project.rootPath); },
              onDeleteConversation:noop, onRenameConversation:async()=>true, onOpenConversationChanges:noop, onOpenSettings:noop }),
            h('section', { className: 'main-stage' }, h('div', { className: 'chat-panel' },
              h('header', { className: 'topbar' }, h('strong', null, '新会话')),
              h('div', { className: 'chat-body' }, h('div', { className: 'chat-content-frame' }, shown && h(WelcomeComposer, {
                key: activeId || 'new-session', language: 'zh', draft, onDraftChange: setDraft, sending: false, stopping: false, guidanceDeliveryMode: 'immediate', cancelEnabled: false,
                queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], selectedModel: 'fixture', availableModels: [], goalAvailable: false, referencePlanAvailable: false,
                referencePlanMode: 'off', permissionMode: 'full-access', subagentPermissionRouting: 'inherit', reasoningLevelAvailable: false, reasoningLevel: 'medium', reasoningLevels: [],
                selectedProjectDir:routing.projectDir, availableProjects:projects, onProjectChange:routing.changeWelcomeProject, onOpenConversation:routing.openConversation, skills: [], disabledSkillNames: new Set(), onToggleSkill: noop, onModelChange: noop,
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
    assert.equal(await run("document.querySelector('.welcome-project-trigger').textContent.trim()"), '关联项目', 'saved global preferences cannot select a project');
    assert.equal(await run("document.querySelector('.only-talk-toggle')"), null);
    await run("changeDraft('保留我的输入草稿')"); await pause(30);
    await run("document.querySelector('.welcome-project-trigger').click()");
    await until("!!document.querySelector('.welcome-project-menu')", 'open project selector');
    await run("[...document.querySelectorAll('.welcome-project-menu [role=menuitemradio]')].find(item=>item.textContent.includes('Fixture')).click()");
    await until("routing.projectDir === 'D:/fixture' && draftValue === '保留我的输入草稿'", 'attach project and transfer anonymous draft');
    const draftId = await run('routing.chat.activeConversationId');
    for (let index = 0; index < 4; index++) {
      await run("document.querySelector('.welcome-project-trigger').click()");
      await until("!!document.querySelector('.welcome-project-menu')", 'project menu');
      const label = index % 2 === 0 ? '不关联项目' : 'Fixture';
      await run(`[...document.querySelectorAll('.welcome-project-menu [role=menuitemradio]')].find(item=>item.textContent.includes(${JSON.stringify(label)})).click()`);
      await until(`routing.projectDir === ${JSON.stringify(index % 2 === 0 ? '' : 'D:/fixture')}`, 'project association updated');
      assert.equal(await run('routing.chat.activeConversationId'), draftId, 'project association retains the same draft');
      assert.equal(await run('draftValue'), '保留我的输入草稿');
    }
    await run("routing.openConversation('saved-project-chat')");
    await until("routing.chat.activeConversationId === 'saved-project-chat'", 'open project history');
    await until("document.querySelectorAll('.conversation-row').length === 2", 'project and independent history shown together');
    await run("routing.openConversation('saved-task-chat')");
    await until("routing.chat.activeConversationId === 'saved-task-chat' && routing.projectDir === ''", 'independent history restores its own context');
    assert.equal(await run("document.querySelectorAll('.conversation-row').length"), 2, 'history stays visible across selection');
    await run("routing.openConversation('saved-project-chat')"); await pause(30);
    await run("document.querySelector('.sidebar-nav .nav-row').click()");
    await until("routing.chat.activeConversationId !== 'saved-project-chat' && routing.projectDir === ''", 'general new chat starts independently');
    await run("changeDraft('独立工作草稿')"); await pause(30);
    const independentDraftId = await run('routing.chat.activeConversationId');
    await run("routing.createConversation('D:/fixture')");
    await until("draftValue === '保留我的输入草稿'", 'explicit project chat restores its draft');
    await run('routing.changeWelcomeProject(null)');
    await until("routing.projectDir === ''", 'detach while another independent draft exists');
    assert.equal(await run('routing.chat.preparedConversations.length'), 2, 'changing association must not overwrite another draft');
    assert.equal(await run('draftValue'), '保留我的输入草稿');
    await run("routing.changeWelcomeProject('D:/fixture')");
    await until("routing.projectDir === 'D:/fixture'", 'reattach the current draft');
    await run('routing.newChat()');
    await until("draftValue === '独立工作草稿'", 'independent draft is retained');
    assert.equal(await run('routing.chat.activeConversationId'), independentDraftId);
    assert.equal(await run('routing.chat.conversations.length'), 2, 'drafts are not persisted by navigation');
    await run("routing.openConversation('saved-project-chat')"); await pause(30);
    await run('routing.createAutomationConversation()');
    await until("routing.projectDir === '' && draftValue.includes('我想创建一个定时任务')", 'automation opens the same independent conversation entry');
    assert.ok(await run("draftValue.startsWith('独立工作草稿')"), 'automation keeps the existing independent draft');
    await run("routing.openConversation('saved-project-chat')"); await pause(30);
    await run("routing.openPluginPrompt('使用插件检查依赖')");
    await until("routing.projectDir === 'D:/fixture' && draftValue.includes('使用插件检查依赖')", 'plugin prompts retain the explicitly selected project');
    assert.ok(await run("draftValue.startsWith('保留我的输入草稿')"), 'plugin prompts keep the project draft');
    await run('routing.newChat()'); await pause(30);
    await run("changeDraft('')"); await pause(30);
    const suggestionDraftId = await run('routing.chat.activeConversationId');
    await run("document.querySelector('.welcome-suggestion').click()");
    await until("document.activeElement?.hasAttribute('data-composer-input') && draftValue.length > 0", 'default suggestion fills and focuses draft');
    assert.equal(await run('routing.chat.activeConversationId'), suggestionDraftId, 'a default suggestion does not navigate');
    assert.equal(await run('sent'), 0);
    const defaultDraft = await run('draftValue');
    await run("document.querySelectorAll('.welcome-suggestion')[1].click()");
    assert.equal(await run('draftValue'), defaultDraft, 'default suggestions do not overwrite an existing draft');
    await run("changeDraft('')"); await until('draftValue === ""', 'clear the default suggestion');
    const history = [
      ['帮我优化缓存命中率，排查动态上下文的变化。', 'a'], ['检查缓存命中率与上下文拼接，保留稳定前缀。', 'b'],
      ['分析缓存命中率下降的原因。', 'c'], ['修复插件代理连接失败，检查网络配置。', 'a'], ['给插件增加独立的代理配置。', 'b'],
      ['根据参考图片生成一张苹果照片。', 'a'], ['根据参考照片调整图片的背景。', 'b'],
    ].map(([content, sessionId], i) => ({ content, sessionId: sessionId === 'b' ? 'saved-task-chat' : 'saved-project-chat', messageId: String(i), createdAt: new Date(Date.now() - 3600000).toISOString(), truncated: false }));
    await run(`deliverHistory(${JSON.stringify(history)})`);
    await until("document.querySelector('.welcome-suggestions-caption').textContent.includes('7 天')", 'history suggestions');
    for (const draft of ['', '跳转时保留这份草稿']) {
      await run(`changeDraft(${JSON.stringify(draft)})`); await pause(30);
      const text = await run("document.querySelector('.welcome-suggestion-text').textContent");
      const source = history.find(row => row.content === text);
      assert.ok(source, 'the card retains a real history source');
      assert.equal(await run("document.querySelector('.welcome-suggestion').disabled"), false, 'history navigation remains available with a draft');
      await run("document.querySelector('.welcome-suggestion').click()");
      await until(`routing.chat.activeConversationId === ${JSON.stringify(source.sessionId)}`, 'history suggestion opens its source conversation');
      assert.equal(await run('draftValue'), '', 'history navigation does not paste into the destination conversation');
      assert.equal(await run('sent'), 0, 'history navigation does not submit a new message');
      await run('routing.newChat()');
      await until(`routing.chat.activeConversationId === ${JSON.stringify(suggestionDraftId)}`, 'return to the original draft');
      assert.equal(await run('draftValue'), draft, 'history navigation preserves the original draft');
      await until("document.querySelector('.welcome-suggestions-caption').textContent.includes('7 天')", 'history restored on return');
    }
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
    console.log('Welcome UI passed: unified sidebar, independent new chat, project association, history navigation with preserved drafts, default suggestion input/focus, dark/light/narrow layout, pointer regroup, reduced motion, visibility and unmount.');
  } finally { win.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
