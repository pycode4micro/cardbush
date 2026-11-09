const { readSourceFile } = require('./helpers/read-source-file.cjs');
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
  const appSource = ts.createSourceFile('App.tsx', readSourceFile(path.join(root, 'src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statements = appSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'CardbushApp').body.statements;
  const navigationCallbacks = ['createConversation', 'openPluginPrompt', 'openConversation', 'changeWelcomeProject', 'handleProjectAction', 'handleSidebarCreateConversation'].map(name => statements.find(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(appSource) === name).getText(appSource));
  const hookSource = ts.createSourceFile('useCardbushChat.ts', readSourceFile(path.join(root, 'src/hooks/useCardbushChat.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const hookStatements = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useCardbushChat').body.statements;
  const draftCallbacks = ['prepareConversation', 'setConversationProject'].map(name => hookStatements.find(node =>
    ts.isVariableStatement(node) && node.declarationList.declarations[0].name.getText(hookSource) === name).getText(hookSource));
  const localConversation = hookSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'localConversation').getText(hookSource);
  const navigationFixture = `import { useCallback, useRef, useState } from 'react';
    import { uiText } from ${JSON.stringify(path.join(root, 'src/i18n/index.ts'))};
    import { withWorkspaceReference } from ${JSON.stringify(path.join(root, 'src/shared/promptReferences.ts'))};
    import { conversationMatchesScope } from ${JSON.stringify(path.join(root, 'src/features/conversationScope.ts'))};
    import { conversationProjectDir } from ${JSON.stringify(path.join(root, 'src/features/conversationWorkspace.ts'))};
    import { samePath, basename } from ${JSON.stringify(path.join(root, 'src/shared/localPaths.ts'))};
    import { pickWorkspace } from ${JSON.stringify(path.join(root, 'src/features/ssh/WorkspaceLocationPicker.tsx'))};
    import { showUiError } from ${JSON.stringify(path.join(root, 'src/shared/showUiError.ts'))};
    import { stableProjectId } from ${JSON.stringify(path.join(root, 'src/features/sidebar/projectStore.ts'))};
    import { adoptDraftConversationStyle } from ${JSON.stringify(path.join(root, 'src/features/settings/conversationStyle.ts'))};
    import { adoptDraftConversationSource } from ${JSON.stringify(path.join(root, 'src/features/settings/conversationSource.ts'))};
    import { adoptDraftConversationModel } from ${JSON.stringify(path.join(root, 'src/features/settings/conversationModel.ts'))};
    import { adoptConversationDraft } from ${JSON.stringify(path.join(root, 'src/shared/conversationDraft.ts'))};
    ${localConversation}
    function useDraftFixture({ activeId, setActiveId, conversations, setConversations }: any) {
      const backend = { scope: undefined, keepRunningOnUnmount: false }, selectedModel = 'fixture';
      const activeConversationIdRef = useRef(activeId); activeConversationIdRef.current = activeId;
      const [preparedConversationsById, setPreparedConversationsById] = useState({});
      const preparedConversationsRef = useRef(preparedConversationsById);
      const conversationsRef = useRef(conversations); conversationsRef.current = conversations;
      const workspaceSwitchesRef = useRef(new Map()), sendingSessionsRef = useRef(new Set()), activeTurnIdsRef = useRef({});
      const conversationCreationPromisesRef = useRef(new Map()), queuedMessagesRef = useRef([]);
      const navigationRevisionRef = useRef(0);
      const queuedMessageConversationId = item => item.conversation.id;
      const [, setMessagesByConversation] = useState({}); const [, setError] = useState(null);
      const setMessageHistoryLoading = useCallback(() => {}, []), setActiveConversationId = setActiveId;
      const errorMessage = String;
      const switchConversationWorkspace = async (id, dir, projectId) => {
        window.workspaceSwitchCalls.push({id, dir, projectId});
        if (window.failWorkspaceSwitch) throw Error('Fixture switch failed');
        if (window.workspaceSwitchGate) await window.workspaceSwitchGate;
        const previous = conversationsRef.current.find(item => item.id === id);
        return { ...previous, projectId:projectId || undefined, projectDir:dir || undefined, workspaceContext:undefined,
          metadata:{workspace_mode:dir?'project':'task', project_id:projectId, project_dir:dir, workspace_dir:dir || 'D:/tasks/' + id, task_dir:dir?null:'D:/tasks/' + id} };
      };
      ${draftCallbacks.join('\n')}
      const prepared = Object.values(preparedConversationsById);
      return { prepareConversation, setConversationProject, conversations, preparedConversations: prepared,
        activeConversationId: activeId, activeConversation: [...conversations, ...prepared].find(item => item.id === activeId),
        openConversation: setActiveId };
    }
    export function useNavigationFixture({ activeId, setActiveId, conversations, setConversations, projectItems, setProjectItems, setDraftsByConversation, setSection }: any) {
      const chat = useDraftFixture({ activeId, setActiveId, conversations, setConversations });
      const activeConversationProjectDir = conversationProjectDir(chat.activeConversation), language = 'zh';
      const drawerLayout = false, collapseSidebar = () => {};
      const [, setSettingsOpen] = useState(false), [, setFriendsOpen] = useState(false), [, setConversationPromptFocus] = useState(0);
      ${navigationCallbacks.join('\n')}
      return { chat, createConversation, openConversation, changeWelcomeProject, handleProjectAction, openPluginPrompt, newChat: handleSidebarCreateConversation,
        projectDir: conversationProjectDir(chat.activeConversation) };
    }`;
  const result = await build({ configFile: false, logLevel: 'error', plugins: [react(), {
    name: 'welcome-fixture', enforce: 'pre',
    resolveId: id => id.endsWith('__welcome__.ts') ? '\0welcome-entry.ts' : undefined,
    load: id => id === '\0welcome-entry.ts' ? `export * from ${JSON.stringify(path.join(root, 'src/features/chat/WelcomeComposer.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/features/ssh/WorkspaceLocationPicker.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/features/composer/Composer.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/components/TopBar.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/features/desktop/WorkspaceChatNavigation.tsx'))};
      export * from ${JSON.stringify(path.join(root, 'src/features/sidebar/ChatSidebar.tsx'))};\n${navigationFixture}`
 : undefined,
  }], build: { write: false, minify: false, lib: { entry: path.join(root, '__welcome__.ts'), formats: ['cjs'] },
    rolldownOptions: { external: /^react(?:-dom)?(?:\/|$)/, output: { codeSplitting: false } } } });
  const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  return { code: output.find(item => item.type === 'chunk').code,
    css: output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n') };
}

app.whenReady().then(async () => {
  const { code, css } = await bundle();
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
    throw Error('Timed out: ' + label + '\n' + await run('JSON.stringify({failures:window.failures, active:window.routing?.chat.activeConversation, draft:window.draftValue, text:document.body.innerText})'));
  };
  try {
    await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await win.webContents.insertCSS(readSourceFile(path.join(root, 'src/features/ssh/ssh.css'), 'utf8') + '\n' + ['theme.css', 'app.css', 'windowMaterial.css'].map(file => readSourceFile(path.join(root, 'src/styles', file), 'utf8')).join('\n') + '\n' + css);
    await run(`
      window.failures = []; window.historyRequests = 0; window.sent = 0; window.workspaceSwitchCalls = []; window.workspaceErrors = [];
      window.cardbushDesktop = { showErrorDialog: async value => workspaceErrors.push(value) };
      if (!crypto.randomUUID) crypto.randomUUID = () => require('node:crypto').randomUUID();
      addEventListener('error', event => failures.push(event.message));
      addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
      for (const name of ['localStorage', 'sessionStorage']) {
        const values = new Map(); Object.defineProperty(window, name, { value: {
          getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key),
        }});
      }
      const React = require(${JSON.stringify(require.resolve('react'))});
      const { createRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const module = { exports: {} };
      new Function('require','module','exports', ${JSON.stringify(code)})(require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))}), module, module.exports);
      const { WelcomeComposer, Composer, WorkspaceLocationButton, TopBar, ChatSidebar, WorkspaceChatNavigation, useNavigationFixture } = module.exports, h = React.createElement, noop = () => {};
      localStorage.setItem('cardbush_only_talk_mode', 'false');
      localStorage.setItem('cardbush_recent_project_dir', 'D:/fixture');
      window.navigationRenders = [];
      const project = { id:'saved-project-chat', title:'项目里的会话', preview:'', updatedAt:'', projectId:'project', projectDir:'D:/fixture', metadata:{workspace_mode:'project'} };
      const task = { id:'saved-task-chat', title:'独立会话', preview:'', updatedAt:'', metadata:{workspace_mode:'task'} };
      const initialProjects = [{ id:'project', title:'Fixture', rootPath:'D:/fixture' }, { id:'second', title:'Second', rootPath:'D:/second' }, {id:'missing', title:'Missing', rootPath:'D:/missing', missing:true}];
      function Fixture() {
        const [projects, setProjectItems] = React.useState(initialProjects); window.projectItems = projects;
        const [drafts, setDrafts] = React.useState({}), [theme, setTheme] = React.useState('dark'), [shown, setShown] = React.useState(true);
        const [activeId, setActiveId] = React.useState(''), [conversations, setConversations] = React.useState([project, task]);
        const [section, setSection] = React.useState('chat');
        const [running, setRunning] = React.useState(new Set()); window.setRunning = setRunning;
        const draftKey = activeId || '__new__', draft = drafts[draftKey] || '', setDraft = text => setDrafts(current => ({ ...current, [draftKey]:text }));
        const routing = useNavigationFixture({ activeId, setActiveId, conversations, setConversations, projectItems:projects, setProjectItems, setDraftsByConversation:setDrafts, setSection });
        const [projectsHost,setProjectsHost] = React.useState(null);
        const [recentHost, setRecentHost] = React.useState(null);
        window.routing = routing; window.clearActive = () => setActiveId('');
        React.useLayoutEffect(() => { navigationRenders.push({ id:activeId, projectDir:routing.projectDir }); });
        window.changeDraft = setDraft; window.changeTheme = setTheme; window.showWelcome = setShown; window.draftValue = draft;
        return h('div', { className: 'app theme-' + theme },
          h('header', { className: 'window-frame' }, h(WorkspaceChatNavigation, {language:'zh',assistantActive:false,onNewChat:routing.newChat,onAssistant:()=>setSection('assistant')})),
          h('main', { className: 'desktop-shell' },
            h(ChatSidebar, { projectsHost, recentList: recentHost && {element:recentHost, selectedId:activeId, limit:40, select:routing.openConversation, more:noop}, language:'zh', section, activeConversationId:activeId, projects, conversations, changeReportsByConversation:{},
              runningConversationIds:running, onConversationWorkspaceChange:(id, project)=>routing.chat.setConversationProject(id, project?.rootPath??null, project?.id??null),
              onSectionChange:setSection, onConversationChange:routing.openConversation, onCreateConversation:routing.newChat,
              onAddProject:noop, onProjectAction:routing.handleProjectAction,
              onDeleteConversation:noop, onRenameConversation:async()=>true, onOpenConversationChanges:noop, onOpenSettings:noop }),
            h('div',{ref:setProjectsHost}), h('aside', {className:'recent-turn-drawer', ref:setRecentHost}),
            h('section', { className: 'main-stage' }, h('div', { className: 'chat-panel' },
              h(TopBar, { title:'新会话', language:'zh', inspectorOpen:true, onToggleInspector:noop,
                workspaceControl:!shown && h(WorkspaceLocationButton, {key:activeId, placement:'toolbar', language:'zh', projects:projects.filter(p=>!p.missing),
                  root:routing.projectDir, disabled:running.has(activeId), onSelect:routing.changeWelcomeProject}) }),
              h('div', { className: 'chat-body' }, h('div', { className: 'chat-content-frame' }, shown && h(WelcomeComposer, {workspaceControl:h(WorkspaceLocationButton,{language:'zh',projects,root:routing.projectDir,onSelect:routing.changeWelcomeProject})}, h(Composer, {
                key: activeId || 'new-session', language: 'zh', draft, onDraftChange: setDraft, sending: false, stopping: false, guidanceDeliveryMode: 'immediate', cancelEnabled: false,
                queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], selectedModel: 'fixture', availableModels: [], goalAvailable: false, referencePlanAvailable: false,
                referencePlanMode: 'off', permissionMode: 'full-access', subagentPermissionRouting: 'inherit', reasoningLevelAvailable: false, reasoningLevel: 'medium', reasoningLevels: [],
                selectedProjectDir:routing.projectDir, availableProjects:projects, onProjectChange:routing.changeWelcomeProject, onOpenConversation:routing.openConversation, skills: [], disabledSkillNames: new Set(), onToggleSkill: noop, onModelChange: noop,
                onReferencePlanModeChange: noop, onPermissionModeChange: noop, onSubagentPermissionRoutingChange: noop, onReasoningLevelChange: noop, onConfigureModels: noop,
                onEditQueuedMessage: noop, onGuideQueuedMessage: async()=>{}, onRemoveQueuedMessage: noop, onSend: async()=>{window.sent++}, onCancel: async()=>{},
              }))))))));
      }
      window.reactRoot = createRoot(document.getElementById('root'));
      reactRoot.render(h(React.StrictMode, null, h(Fixture)));
    `);
    await until("!!document.querySelector('.new-chat-input [data-composer-input]')", 'centered new-chat input');
    await run("changeDraft('保留我的输入草稿')"); await pause(30);
    await run("document.querySelector('.new-chat-input .workspace-location-control > button').click()");
    await until("!!document.querySelector('.ssh-dialog')", 'open project selector');
    await run("[...document.querySelectorAll('.ssh-dialog .ssh-project-list button, .ssh-dialog > button')].find(item=>item.textContent.includes('Fixture')).click()");
    await until("routing.projectDir === 'D:/fixture' && draftValue === '保留我的输入草稿'", 'attach project and transfer anonymous draft');
    const draftId = await run('routing.chat.activeConversationId');
    for (let index = 0; index < 4; index++) {
      await run("document.querySelector('.new-chat-input .workspace-location-control > button').click()");
      await until("!!document.querySelector('.ssh-dialog')", 'project menu');
      const label = index % 2 === 0 ? '不在项目中工作' : 'Fixture';
      await run(`[...document.querySelectorAll('.ssh-dialog .ssh-project-list button, .ssh-dialog > button')].find(item=>item.textContent.includes(${JSON.stringify(label)})).click()`);
      await until(`routing.projectDir === ${JSON.stringify(index % 2 === 0 ? '' : 'D:/fixture')}`, 'project association updated');
      assert.equal(await run('routing.chat.activeConversationId'), draftId, 'project association retains the same draft');
      assert.equal(await run('draftValue'), '保留我的输入草稿');
    }
    await run("routing.openConversation('saved-project-chat')");
    await until("routing.chat.activeConversationId === 'saved-project-chat'", 'open project history');
    await until("document.querySelectorAll('.recent-session-rows .conversation-row').length === 2", 'project and independent history shown together in the recent drawer');
    await run("routing.openConversation('saved-task-chat')");
    await until("routing.chat.activeConversationId === 'saved-task-chat' && routing.projectDir === ''", 'independent history restores its own context');
    assert.equal(await run("document.querySelectorAll('.recent-session-rows .conversation-row').length"), 2, 'history stays visible across selection');
    await run("routing.openConversation('saved-project-chat')"); await pause(30);
    await run("document.querySelector('[data-nav-section=chat]').click()");
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
    await run("routing.openPluginPrompt('使用插件检查依赖')");
    await until("routing.projectDir === 'D:/fixture' && draftValue.includes('使用插件检查依赖')", 'plugin prompts retain the explicitly selected project');
    assert.ok(await run("draftValue.startsWith('保留我的输入草稿')"), 'plugin prompts keep the project draft');
    await run('routing.newChat()'); await pause(30);
    await run("changeDraft('')"); await pause(30);
    await run('showWelcome(false)');
    // Exercise actual sidebar drag handlers and the persisted-conversation hook.
    win.setSize(1180, 760);
    await run("routing.openConversation('saved-task-chat')");
    await until("!!document.querySelector('.workspace-location-control')", 'history workspace picker');
    async function dragChat(title, target, accepted = true) {
      await run(`window.transfer = new DataTransfer(); [...document.querySelectorAll('.conversation-row')].find(row => row.textContent.includes(${JSON.stringify(title)})).dispatchEvent(new DragEvent('dragstart', { bubbles:true, dataTransfer:transfer }));`);
      await pause(40);
      const over = await run(`!document.querySelector('[data-workspace-drop="${target}"]').dispatchEvent(new DragEvent('dragover', { bubbles:true, cancelable:true, dataTransfer:transfer }))`);
      assert.equal(over, accepted, 'only supported drops are accepted');
      if (accepted) {
        await until(`!!document.querySelector('[data-workspace-drop="${target}"].workspace-drop-active')`, 'drop highlight');
        await run(`document.querySelector('[data-workspace-drop="${target}"]').dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:transfer }))`);
      }
      await run("document.querySelector('.sidebar').dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:transfer}))");
    }
    await dragChat('独立会话', 'project');
    await until("routing.projectDir === 'D:/fixture'", 'drop attaches saved chat');
    assert.equal(await run('routing.chat.activeConversationId'), 'saved-task-chat');
    await dragChat('独立会话', 'second');
    await until("routing.projectDir === 'D:/second'", 'drop changes actual project binding');
    await until("document.querySelector('[data-workspace-drop=second] .conversation-row')?.textContent.includes('独立会话')", 'target expands to show moved chat');
    await dragChat('独立会话', 'recent');
    await until("routing.projectDir === ''", 'drop detaches saved chat');
    assert.equal(await run('routing.chat.activeConversation.projectId'), undefined, 'detaching clears project identity');
    assert.equal(await run('routing.chat.conversations.length'), 2, 'moves preserve conversation identity and count');
    await run("setRunning(new Set(['saved-task-chat']))"); await pause(40);
    await dragChat('独立会话', 'project', false);
    assert.equal(await run("document.querySelector('.workspace-location-control button').disabled"), true);
    await run('setRunning(new Set())'); await pause(40);
    await dragChat('独立会话', 'missing', false);
    await run('failWorkspaceSwitch = true');
    await dragChat('独立会话', 'project');
    await until('workspaceErrors.length === 1', 'failed move is reported');
    assert.equal(await run('routing.projectDir'), '', 'failed move leaves original binding visible');
    await run('failWorkspaceSwitch = false');
    await run("document.querySelector('.workspace-location-control > button').click()");
    await until("!!document.querySelector('.ssh-dialog')", 'toolbar picker opens');
    assert.ok(await run("document.querySelector('.ssh-dialog').getBoundingClientRect().top >= 0"), 'location picker stays on screen');
    await run("[...document.querySelectorAll('.ssh-dialog .ssh-project-list button')].find(button=>button.textContent.includes('Second')).click()");
    await until("routing.projectDir === 'D:/second'", 'toolbar switches existing history');
    await run("clearActive()"); await pause(30);
    await run("changeDraft('keep my draft')"); await until("draftValue === 'keep my draft'", 'unassigned SSH draft');
    await run("routing.changeWelcomeProject('ssh://test-server/work', '[@Server](cardbush-reference://ssh?connectionId=test-server&path=%2Fwork&title=Server)')");
    await until("draftValue.includes('cardbush-reference://ssh') && draftValue.includes('keep my draft')", 'SSH reference follows a newly selected conversation');
    assert.equal(await run("projectItems.filter(project=>project.rootPath==='ssh://test-server/work').length"),1,'new SSH workspace is saved in the sidebar');
    assert.equal(await run("routing.chat.activeConversation.projectId"),'project-ssh://test-server/work','new conversation shares the saved project identity');
    await run("routing.changeWelcomeProject('D:/fixture')");
    await until("!draftValue.includes('cardbush-reference://ssh') && draftValue.includes('keep my draft')", 'workspace switch removes stale SSH chips only');

    // Real App callbacks: a confirmed SSH picker must commit both the Runtime
    // binding and the sidebar project, rather than discard the selected URI.
    await run(`
      window.remoteDirectoryCalls=[];
      cardbushDesktop.sshConnections={
        list:async()=>[{id:'test-server',name:'测试服务器',host:'fixture.invalid',username:'test',defaultDirectory:'/work',status:'connected'}],
        directory:async uri=>{remoteDirectoryCalls.push(uri);const path=decodeURIComponent(new URL(uri).pathname);return {uri,path,entries:[]};},
      };
      routing.openConversation('saved-task-chat');
    `);
    await until("routing.chat.activeConversationId==='saved-task-chat'",'select existing chat for remote switch');
    await run("routing.changeWelcomeProject('ssh://test-server/work')");
    await until("routing.projectDir==='ssh://test-server/work'",'existing history switches to remote');
    await run("changeDraft('保留远程草稿')");
    const openRemoteProject = async rootPath => {
      await run(`document.querySelector('[data-workspace-drop="project-${rootPath}"] .project-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:150}))`);
      await until("!!document.querySelector('[data-sidebar-menu-item=open]')",'remote project context menu');
      assert.equal(await run("document.querySelector('[data-sidebar-menu-item=open]').textContent"),'选择远程目录…');
      await run("document.querySelector('[data-sidebar-menu-item=open]').click()");
      await until("!!document.querySelector('input[aria-label=\"远程目录\"]')",'remote picker opened by project action');
    };
    const chooseRemoteDirectory = async path => {
      await run(`var field=document.querySelector('input[aria-label="远程目录"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(path)});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`);
      await pause(30);
      await run("[...document.querySelectorAll('.workspace-picker button')].find(button=>button.textContent==='连接并使用此目录').click()");
      await until("!document.querySelector('.workspace-picker')",'directory selection confirmed');
    };
    await openRemoteProject('ssh://test-server/work');
    const beforeRemoteSwitch=await run('workspaceSwitchCalls.length');
    await chooseRemoteDirectory('/work/Child');
    await until("routing.projectDir==='ssh://test-server/work/Child'",'sidebar selection updates execution directory without reopening');
    assert.equal(await run('routing.chat.activeConversationId'),'saved-task-chat','keeps the current conversation');
    assert.equal(await run('draftValue'),'保留远程草稿');
    assert.equal(await run('workspaceSwitchCalls.length'),beforeRemoteSwitch+1);
    assert.deepEqual(await run('workspaceSwitchCalls.at(-1)'),{id:'saved-task-chat',dir:'ssh://test-server/work/Child',projectId:'project-ssh://test-server/work/Child'});
    await until("!!document.querySelector('[data-workspace-drop=\"project-ssh://test-server/work/Child\"] .conversation-row')",'history appears under the new sidebar project');
    assert.equal(await run("projectItems.find(project=>project.rootPath==='ssh://test-server/work').rootPath"),'ssh://test-server/work','other project remains available');

    await openRemoteProject('ssh://test-server/work/Child');
    await run("document.querySelector('.workspace-picker').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until("!document.querySelector('.workspace-picker')",'cancel remote selection');
    assert.equal(await run('workspaceSwitchCalls.length'),beforeRemoteSwitch+1);
    await openRemoteProject('ssh://test-server/work/Child');
    await run('failWorkspaceSwitch=true');
    await chooseRemoteDirectory('/work/failed');
    await until('workspaceErrors.length===2','failed remote workspace switch is reported');
    assert.equal(await run('routing.projectDir'),'ssh://test-server/work/Child');
    assert.equal(await run("projectItems.some(project=>project.rootPath==='ssh://test-server/work/failed')"),false,'failure cannot publish a misleading sidebar project');
    await run('failWorkspaceSwitch=false');
    await openRemoteProject('ssh://test-server/work/Child');
    await chooseRemoteDirectory('/work/child');
    await until("routing.projectDir==='ssh://test-server/work/child'",'remote paths preserve case when switching');
    assert.equal(await run("projectItems.filter(project=>['ssh://test-server/work/child','ssh://test-server/work/Child'].includes(project.rootPath)).length"),2);

    // Opening another remote project must not move an unrelated active chat.
    await run("routing.openConversation('saved-project-chat')");
    await until("routing.chat.activeConversationId==='saved-project-chat'",'unrelated local conversation');
    const beforeUnrelated=await run('workspaceSwitchCalls.length');
    await openRemoteProject('ssh://test-server/work');
    await chooseRemoteDirectory('/work/another');
    await until("routing.projectDir==='ssh://test-server/work/another'",'opens a new remote draft');
    assert.equal(await run('workspaceSwitchCalls.length'),beforeUnrelated,'unrelated conversation binding is unchanged');
    assert.equal(await run("routing.chat.conversations.find(item=>item.id==='saved-project-chat').projectDir"),'D:/fixture');
    fs.writeFileSync(path.join(root, 'tmp/workspace-switch-ui.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
    console.log('Welcome/workspace UI passed: draft and history navigation, toolbar switching, project-to-project drag, detach, drop highlighting, busy/missing targets, failed-switch recovery, centered input and workspace selection.');
  } finally { win.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
