// Real components in isolated Chromium; no product profile or external requests.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const { build } = await import('vite');
  const result = await build({ configFile: false, logLevel: 'warn', plugins: [{
    name: 'settings-context-fixture',
    enforce: 'pre',
    resolveId: id => id.endsWith('__settings_context_test__.ts') ? '\0settings-context-fixture' : undefined,
    load: id => id === '\0settings-context-fixture' ? [
      'src/features/SettingsView.tsx', 'src/features/composer/Composer.tsx', 'src/features/chat/GitBranchMenu.tsx', 'src/features/chat/TaskWorkspaceBar.tsx',
      'src/features/settings/conversationStyle.ts',
      'src/features/shortcuts/keyboardShortcuts.ts',
      'src/components/WindowSidebarToggle.tsx', 'src/components/SidebarResizer.tsx',
      'src/hooks/useSoftPanelPresence.ts', 'src/features/sidebar/ChatSidebar.tsx',
      'src/features/sidebar/conversationArchives.ts',
    ].map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n')
      : undefined,
  }], build: { write: false, minify: false,
    lib: { entry: path.join(root, '__settings_context_test__.ts'), formats: ['cjs'] },
    rolldownOptions: { external: /^react(?:-dom)?(?:\/|$)/, output: { codeSplitting: false } },
  } });
  const bundle = (Array.isArray(result) ? result : [result]).flatMap(item => item.output).find(item => item.type === 'chunk').code;
  const win = new BrowserWindow({ show: false, width: 1200, height: 850,
    webPreferences: { nodeIntegration: true, contextIsolation: false, offscreen: true, backgroundThrottling: false, partition: 'settings-context-test' } });
  const errors = [];
  win.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/.test(details.url);
    if (external) errors.push('Unexpected network request: ' + details.url);
    done({ cancel: external });
  });
  const run = code => win.webContents.executeJavaScript(code);
  const until = async code => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await run(code)) return;
      await pause(25);
    }
    throw Error('Timed out: ' + code + '\n' + await run('document.body.innerText') + '\nRenderer errors: ' + JSON.stringify(await run('failures')));
  };
  const click = label => run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const choose = async (selector, value) => {
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until("!!document.querySelector('.settings-dropdown-popover:popover-open')");
    await run(`Array.from(document.querySelectorAll('.settings-dropdown-popover:popover-open [role=option]')).find(option => option.value === ${JSON.stringify(value)}).click()`);
  };
  const edit = (selector, value, textarea = false) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  try {
    await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await win.webContents.insertCSS(['src/styles/theme.css', 'src/styles/app.css', 'src/styles/themes/cyberpunk.css', 'src/features/settings/keyboardSettings.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n'));
    await run(`
      window.failures = []; window.usageReads = 0;
      window.usageFixture = { startedAt:'2025-09-12T00:00:00Z', promptTokens:59446000, completionTokens:515000, totalTokens:59961000,
        promptCacheHitTokens:0, promptCacheMissTokens:59446000, requestCount:206, conversationCount:38, activeDays:38, longestStreak:38,
        activity:Array.from({length:38}, (_, index) => {const day = new Date(); day.setDate(day.getDate() - index); return {date:[day.getFullYear(), String(day.getMonth()+1).padStart(2,'0'), String(day.getDate()).padStart(2,'0')].join('-'), tokens:(1 + index % 8) * 25103, requests:1};}) };
      addEventListener('error', event => failures.push(event.message));
      addEventListener('unhandledrejection', event => failures.push(String(event.reason)));
      for (const name of ['localStorage', 'sessionStorage']) {
        const values = new Map();
        Object.defineProperty(window, name, { value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) } });
      }
      const React = require(${JSON.stringify(require.resolve('react'))});
      const { createRoot } = require(${JSON.stringify(require.resolve('react-dom/client'))});
      const sourceRequire = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});
      const module = { exports: {} };
      new Function('require', 'module', 'exports', ${JSON.stringify(bundle)})(sourceRequire, module, module.exports);
      const views = module.exports, h = React.createElement, reactRoot = createRoot(document.getElementById('root'));
      window.archiveFixture = { setArchived: views.setConversationsArchived, storageKey: views.conversationArchivesStorageKey };
      window.file = { path: 'C:/Users/fixture/AppData/Roaming/cardbush/AGENTS.md', content: '请使用中文，并核对交付结果。', revision: 'one' };
      window.failSave = false; window.checkouts = [];
      window.cardbushDesktop = {
        productHostCommand: async command => {
          if (!command.kind.startsWith('sandbox.')) throw Error('Unexpected fixture command: ' + command.kind);
          sandboxCalls.push(command.kind);
          if (command.kind === 'sandbox.install') { if (sandboxFail) throw Error('fixture install denied'); sandboxStatus = { ...sandboxStatus, state:'ready', installed:true, enabled:true, canInstall:false }; }
          if (command.kind === 'sandbox.update') sandboxStatus = { ...sandboxStatus, enabled:command.enabled };
          return { protocol:'cardbush.product_host_ipc.v1', ok:true, value:structuredClone(sandboxStatus) };
        },
        usageStatistics: async () => { usageReads++; return structuredClone(usageFixture); },
        readGlobalInstructions: async () => ({ ...file }),
        saveGlobalInstructions: async (content, revision) => {
          if (failSave) throw Error('fixture disk write failed');
          if (revision !== file.revision) throw Error('AGENTS.md changed; reload it before saving.');
          file = { ...file, content, revision: revision + '-saved' }; return { ...file };
        },
        gitInfo: async () => ({ branch: 'main' }), gitBranches: async () => ['main', 'preview'],
        gitCheckout: async (root, branch) => { checkouts.push({ root, branch }); return { branch }; },
      };
      window.sandboxCalls = []; window.sandboxFail = false;
      window.sandboxStatus = { platform:'linux', state:'missing', installed:false, enabled:false, managed:false, canInstall:true, installer:'fixture' };
      const noop = () => {};
      window.fixtureModel = { id: 'fixture', provider: 'deepseek', modelName: 'deepseek-v4.1-flash-expires-on-0910', baseUrl: 'https://api.deepseek.com', apiKey: '', hasApiKey: true, maxContextTokens: 400000, maxCompletionTokens: 128000 };
      window.settingsProps = { active: true, onReady: noop, language: 'zh', languageMode: 'zh', systemLanguage: 'zh', themePreference: 'cyberpunk',
        settings: { conversationStyle: views.readConversationStyle(), managedModelConfigs: [fixtureModel, { ...fixtureModel, id: 'vision', modelName: 'deepseek-v4-flash-vision-exp' }], terminal: { runtime: 'powershell' }, browser: {}, proxy: {}, thinking: {visible:true}, guidance: {deliveryMode:'queue'}, user: {}, font: {}, companion: {} },
        selectedModel: 'fixture', availableModels: [fixtureModel], backendCapabilities: {terminalRuntimes:['powershell','wsl'], runtimeAssetResetCategories:[], browserPrivacyMode:false, reasoningStream:true}, runtimeBusy: false, conversations: [], skills: [], disabledSkillNames: new Set(),
        initialSection: 'instructions', initialPluginTab: 'plugins', onBack: noop,
        onThemePreferenceChange: value => { settingsProps.themePreference = value; renderSettings(); }, onLanguageModeChange: noop,
        onSettingsChange: fn => { settingsProps.settings = fn(settingsProps.settings); views.saveConversationStyle(settingsProps.settings.conversationStyle); renderSettings(); }, onUseModel: noop, onSidebarWidthChange: noop,
        onToggleSkill: noop, onReloadSkills: async () => [], onLoadSkillDetail: async () => null,
        visualInputAvailable: true, visualInputEnabled: false, onVisualInputEnabledChange: value => { settingsProps.visualInputEnabled = value; renderSettings(); },
      };
      function SettingsLayout() {
        const [collapsed, setCollapsed] = React.useState(false);
        const [width, setWidth] = React.useState(272);
        const [active, setActive] = React.useState(true);
        const presence = views.useSoftPanelPresence(!collapsed);
        window.settingsSidebarState = { collapsed, width, active, ...presence };
        window.setSettingsActive = setActive;
        window.restoreSidebarWidth = () => setWidth(272);
        return h('div', { className: 'app theme-' + (window.settingsTheme || 'dark'), style: { width: '100vw', height: '100vh', minWidth: 0, '--sidebar-width': width + 'px' } },
          h('header', { className: 'window-frame window-drag' }, h(views.WindowSidebarToggle, {
            language: 'zh', collapsed, onToggle: () => setCollapsed(value => !value),
          })),
          h(views.SettingsView, { ...settingsProps, active, onBack: () => setActive(false),
            sidebarCollapsed: collapsed, sidebarPresence: presence, sidebarWidth: width,
            onSidebarWidthChange: setWidth, onSidebarCollapse: () => setCollapsed(true),
          }),
          h('main', { className: 'desktop-shell' + (collapsed ? ' sidebar-is-collapsed' : '') + (active ? ' app-content-suspended' : ''), inert: active ? true : undefined },
            presence.mounted && h(views.ChatSidebar, {
              language:'zh', section:'chat', activeConversationId:'', projects:settingsProps.projects || [], conversations:settingsProps.conversations, changeReportsByConversation:{},
              onSectionChange:noop, onConversationChange:id => window.sidebarOpenedConversations?.push(id), onCreateConversation:noop, onAddProject:noop,
              onProjectAction:(action, project) => settingsProps.onProjectAction?.(action, project), onDeleteConversation:noop, onRenameConversation:noop, onOpenConversationChanges:noop,
              onOpenSettings:() => setActive(true),
              onOpenArchives:() => { settingsProps.initialSection = 'cache'; setActive(true); renderSettings(); }, softVisible:presence.visible,
            }),
            presence.mounted && h(views.SidebarResizer, { language:'zh', width, onWidthChange:setWidth,
              onCollapse:() => setCollapsed(true), softVisible:presence.visible && !active }),
            h('section', { className:'main-stage' }, h('button', { onClick:() => setActive(true) }, '打开设置'))));
      }
      window.renderSettings = () => reactRoot.render(h(SettingsLayout));
      window.composerProps = { language: 'zh', draft: '', onDraftChange: noop, sending: false, selectedModel: 'fixture', availableModels: [fixtureModel],
        referencePlanAvailable: true, referencePlanMode: 'auto', permissionMode: 'task_free', subagentPermissionRouting: 'user', reasoningLevelAvailable: false, reasoningLevel: 'high', reasoningLevels: [],
        onModelChange: noop, onReferencePlanModeChange: value => { composerProps.referencePlanMode = value; renderComposer(); }, onPermissionModeChange: noop, onSubagentPermissionRoutingChange: noop,
        onReasoningLevelChange: noop, onSend: async () => {}, onCancel: async () => {}, skills: [{ name: 'Fixture skill', path: 'C:/fixture/skills/fixture/SKILL.md', description: 'Retained skill', descriptionZh: '保留的技能' }], disabledSkillNames: new Set(), onConfigureModels: noop, onToggleSkill: noop };
      window.renderComposer = () => reactRoot.render(h('div', { className: 'app theme-cyberpunk', style: { minWidth: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'end', padding: '36px' } }, h(views.Composer, composerProps)));
      window.renderWorkspace = busy => reactRoot.render(h(views.TaskWorkspaceBar, { sessionId: '', projectDir: 'D:/fixture', language: 'zh', busy, gitAvailable: true, onChanged: async () => {} }));
      window.renderGit = disabled => reactRoot.render(h(views.GitBranchMenu, { language: 'zh', activeProjectDir: 'D:/fixture', disabled }));
      renderSettings();
    `);
    await until("document.querySelector('#global-agent-instructions')?.value.includes('中文')");
    if (process.env.CARDBUSH_SETTINGS_CASE === 'sandbox') {
      await click('运行环境');
      await until("document.querySelector('.settings-sandbox-status')?.textContent === '未安装'");
      assert.deepEqual(await run('sandboxCalls'), ['sandbox.get'], 'opening settings must never install');
      await run('sandboxStatus.canInstall = false'); await click('重新检测');
      await until("document.querySelector('.settings-content')?.textContent.includes('未检测到支持的安装方式')");
      assert.equal(await run("Array.from(document.querySelectorAll('button')).find(b => b.textContent === '安装沙盒')?.disabled"), true, 'unsupported installation keeps a visible disabled button');
      await click('安装沙盒');
      assert.equal(await run("sandboxCalls.includes('sandbox.install')"), false);
      await run('sandboxStatus.canInstall = true'); await click('重新检测');
      await until("Array.from(document.querySelectorAll('button')).find(b => b.textContent === '安装沙盒')?.disabled === false");
      await run('sandboxFail = true'); await click('安装沙盒');
      await until("document.querySelector('[role=alert]')?.textContent.includes('fixture install denied')");
      assert.equal(await run('sandboxStatus.enabled'), false);
      await run('sandboxFail = false'); await click('安装沙盒');
      await until("document.querySelector('.settings-sandbox-status')?.textContent.includes('已启用')");
      assert.equal(await run("document.querySelector('.settings-switch input').checked"), true);
      await run("document.querySelector('.settings-switch input').click()");
      await until("document.querySelector('.settings-sandbox-status')?.textContent.includes('已关闭')");
      await click('重新检测');
      await until("!Array.from(document.querySelectorAll('button')).find(b => b.textContent === '重新检测')?.disabled");
      assert.equal(await run('sandboxStatus.enabled'), false);
      // A slow local check must not overwrite the next Agent's settings when it resolves.
      await run(`
        window.originalSandboxCommand = cardbushDesktop.productHostCommand;
        cardbushDesktop.productHostCommand = command => command.kind === 'sandbox.get'
          ? new Promise(resolve => { window.releaseSandboxCheck = () => resolve({protocol:'cardbush.product_host_ipc.v1',ok:true,
              value:{platform:'linux',state:'missing',installed:false,enabled:false,managed:false,canInstall:true}}); })
          : originalSandboxCommand(command);
        undefined;
      `);
      await click('重新检测');
      await until("typeof releaseSandboxCheck === 'function'");
      // Same page, different host: requests must target the Agent only.
      await run(`
        window.remoteSandboxCalls = [];
        cardbushDesktop.agents = { connect:async () => ({platform:'linux', capabilities:{sandboxSettings:true,sharedSettings:true}}),
          call:async (id, operation, input) => { remoteSandboxCalls.push([id,operation,input]); return {platform:'linux',state:'ready',installed:true,enabled:true,managed:true,canInstall:false}; } };
        settingsProps.agentId = 'remote-sandbox'; settingsProps.agentConnections = [{id:'remote-sandbox',name:'测试 Agent'}]; settingsProps.initialSection = 'runtime'; renderSettings();
      `);
      await until("document.querySelector('.settings-switch input')?.disabled && document.querySelector('.settings-sandbox-status')?.textContent.includes('已启用')");
      assert.deepEqual(await run('remoteSandboxCalls'), [['remote-sandbox','product.command',{kind:'sandbox.get'}]]);
      await run('releaseSandboxCheck(); new Promise(resolve => setTimeout(resolve, 0))');
      assert.equal(await run("document.querySelector('.settings-switch input')?.disabled"), true, 'late local status must not overwrite the remote policy');
      assert.equal(await run("document.querySelector('.settings-sandbox-status')?.textContent"), '已安装 · 已启用');
      assert.equal(await run("Array.from(document.querySelectorAll('button')).some(b => b.textContent === '安装沙盒')"), false);
      await run('void (cardbushDesktop.productHostCommand = originalSandboxCommand)');
      fs.writeFileSync(path.join(root, 'tmp/settings-sandbox.png'), (await win.webContents.capturePage()).toPNG());
      await run(`
        cardbushDesktop.agents.connect = async () => ({platform:'linux',capabilities:{sharedSettings:true}});
        settingsProps.agentId = 'legacy-sandbox'; settingsProps.agentConnections = [{id:'legacy-sandbox',name:'旧 Agent'}]; renderSettings();
      `);
      await until("document.querySelector('.settings-content')?.textContent.includes('请更新此 Agent 服务')");
      assert.equal(await run('remoteSandboxCalls.length'), 1, 'old servers must not fall back to local sandbox setup');
      assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
      console.log('Sandbox settings UI passed: detection-only opening, explicit install, failure retention, automatic enable, opt-out, shared remote page and managed policy.');
      return;
    }
    if (process.env.CARDBUSH_SETTINGS_CASE === 'agents') {
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await require('./helpers/settings-agents.cjs')({ run, until, click, choose, edit, window: win, root });
      assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
      win.destroy(); app.exit(0); return;
    }
    if (process.env.CARDBUSH_SETTINGS_CASE === 'models') {
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await require('./helpers/settings-models.cjs')({ run, until, click, edit, window: win, root });
      assert.deepEqual(await run('failures'), []); assert.deepEqual(errors, []);
      win.destroy(); app.exit(0); return;
    }
    if (process.env.CARDBUSH_SETTINGS_CASE === 'archives') {
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await require('./helpers/settings-archives.cjs')({ run, until, window: win, root, click, edit });
      assert.deepEqual(await run('failures'), []);
      assert.deepEqual(errors, []);
      win.destroy(); app.exit(0); return;
    }
    if (process.env.CARDBUSH_SETTINGS_CASE === 'maintenance') {
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
      await require('./helpers/settings-maintenance.cjs')({ run, until, window: win, root, click });
      win.destroy(); app.exit(0); return;
    }
    await require('./helpers/settings-sidebar.cjs')({ run, until, pause, window: win, root });
    await edit('#global-agent-instructions', '全局偏好：先确认事实。', true);
    await run('failSave = true'); await click('保存');
    await until("document.querySelector('[role=alert]')?.textContent.includes('disk write failed')");
    assert.equal(await run('file.content'), '请使用中文，并核对交付结果。');
    assert.equal(await run("document.querySelector('#global-agent-instructions').value"), '全局偏好：先确认事实。');
    await run('failSave = false'); await click('保存');
    await until("document.querySelector('[role=status]')?.textContent.includes('已保存')");
    assert.equal(await run('file.content'), '全局偏好：先确认事实。');
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp/settings-global-instructions.png'), (await win.webContents.capturePage()).toPNG());

    await click('个性化');
    await until("document.querySelector('#conversation-style-mode')?.value === 'natural'");
    const chooseStyle = value => choose('#conversation-style-mode', value);
    assert.equal(await run("document.querySelector('#conversation-style-custom') === null"), true);
    for (const mode of ['professional', 'concise', 'custom']) {
      await chooseStyle(mode);
      await until(`settingsProps.settings.conversationStyle.mode === ${JSON.stringify(mode)}`);
      assert.equal(await run("JSON.parse(localStorage.getItem('cardbush_conversation_style')).mode"), mode);
    }
    const tone = '  像朋友一样交流。\n先说重点，需要时举例。  ';
    await edit('#conversation-style-custom', tone, true);
    await until(`settingsProps.settings.conversationStyle.customTone === ${JSON.stringify(tone)}`);
    await chooseStyle('natural');
    await until("!document.querySelector('#conversation-style-custom')");
    await chooseStyle('custom');
    await until(`document.querySelector('#conversation-style-custom')?.value === ${JSON.stringify(tone)}`);
    await click('外观与语言');
    await click('个性化');
    await until(`document.querySelector('#conversation-style-custom')?.value === ${JSON.stringify(tone)}`);
    await run("settingsProps.settings.conversationStyle = views.readConversationStyle(); renderSettings()");
    assert.equal(await run("settingsProps.settings.conversationStyle.customTone"), tone, 'reloading saved preferences preserves the draft');
    await run("document.querySelector('.conversation-style-settings').closest('.settings-card').scrollIntoView({block:'center'})");
    await pause(100);
    fs.writeFileSync(path.join(root, 'tmp/settings-conversation-style.png'), (await win.webContents.capturePage()).toPNG());
    await edit('#conversation-style-custom', '', true);
    await until("settingsProps.settings.conversationStyle.customTone === ''");
    assert.equal(await run('file.content'), '全局偏好：先确认事实。', 'style preferences must not rewrite AGENTS.md');

    const expectedSettingsSections = ['browser', 'computer-use', 'mcp', 'models', 'profile', 'shortcuts', 'usage', 'appearance', 'ssh', 'runtime', 'proxy', 'cache', 'diagnostics'];
    assert.deepEqual(await run("Array.from(document.querySelectorAll('.settings-nav'), item => item.dataset.settingsSection)"), expectedSettingsSections, 'each supported local setting page has one navigation entry');
    await click('快捷键');
    await until("document.querySelectorAll('[data-shortcut-row]').length === views.shortcutDefinitions.length");
    assert.deepEqual(await run("Array.from(document.querySelectorAll('[data-shortcut-row]'), item => item.dataset.shortcutRow).sort()"), await run("views.shortcutDefinitions.map(item => item.id).sort()"), 'all registered shortcuts are configurable without duplicate rows');
    assert.equal(await run("document.querySelector('.settings-nav[aria-current=page]').textContent.trim()"), '快捷键');
    await pause(100);
    fs.writeFileSync(path.join(root, 'tmp/settings-keyboard-full.png'), (await win.webContents.capturePage()).toPNG());
    assert.equal(await run("document.querySelector('.usage-stat-grid')"), null, 'personalization does not load usage statistics');
    assert.equal(await run('usageReads'), 0, 'unrelated pages must not fetch the full usage history');
    assert.equal(await run("document.querySelector('[name=theme-mode]')"), null, 'appearance is separate from conversation preferences');
    await edit('.settings-search input', '浏览器');
    await until("document.querySelectorAll('.settings-nav').length === 2");
    assert.deepEqual(await run("Array.from(document.querySelectorAll('.settings-nav'), item => item.dataset.settingsSection)"), ['browser', 'mcp'], 'browser search includes its dedicated settings and plugins');
    await click('插件');
    await until("document.querySelector('.settings-nav[aria-current=page]')?.dataset.settingsSection === 'mcp'");
    assert.equal(await run("document.querySelector('.settings-search input').value"), '');
    await click('网络代理');
    await until("!!document.querySelector('[name=proxy-mode]')");
    assert.equal(await run("document.querySelector('.settings-content').textContent.includes('Cookie')"), false, 'browser privacy is not part of proxy settings');
    assert.equal(await run("document.querySelectorAll('.settings-page-tabs button').length"), 2, 'models and plugins share the network entry');
    await run("document.querySelector('#proxy-tab-models').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}))");
    await until("!!document.querySelector('#proxy-panel-plugins .plugin-network-page')");
    assert.equal(await run("document.querySelector('#proxy-panel-plugins .plugin-search-settings, #proxy-panel-plugins .plugin-back')"), null, 'network settings have no duplicate plugin navigation');
    await run("document.querySelector('#proxy-tab-plugins').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))");
    await until("!!document.querySelector('#proxy-panel-models [name=proxy-mode]')");
    await click('外观与语言');
    await until("!!document.querySelector('[name=theme-mode]')");
    assert.equal(await run("document.querySelector('[name=language-mode]') !== null"), true);
    assert.equal(await run("document.querySelector('.settings-disclosure').open"), false, 'infrequent theme import stays collapsed');
    for (const theme of ['light', 'cyberpunk', 'dark']) {
      await choose('[name=theme-mode] + [role=combobox]', theme);
      await until(`settingsProps.themePreference === ${JSON.stringify(theme)}`);
    }
    await pause(120);
    fs.writeFileSync(path.join(root, 'tmp/settings-appearance-reorganized.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('[name=theme-mode] + [role=combobox]').click()");
    await until("!!document.querySelector('.settings-dropdown-popover:popover-open')");
    await pause(180);
    fs.writeFileSync(path.join(root, 'tmp/settings-theme-dropdown.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('[name=theme-mode] + [role=combobox]').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));");
    await until("document.querySelector('.settings-dropdown-popover:popover-open .highlighted')?.value === 'system'");
    await run("document.querySelector('[name=theme-mode] + [role=combobox]').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));");
    await until("settingsProps.themePreference === 'system'");
    assert.equal(await run("document.querySelectorAll('.settings-content select').length"), 0, 'settings no longer use native select popups');
    await click('使用统计');
    await until("!!document.querySelector('.usage-stat-grid') && document.querySelector('.usage-stat-grid').getAttribute('aria-busy') === 'false'");
    assert.equal(await run('usageReads'), 1, 'usage loads only when its page opens');
    assert.equal(await run("document.querySelector('.usage-stat').title"), '59,961,000', 'usage retains the supplied totals');
    assert.equal(await run("document.querySelector('.usage-settings .settings-card')"), null, 'usage is a flat summary rather than a nested card');
    assert.equal(await run("document.querySelectorAll('.usage-heatmap-cell').length"), 371);
    assert.equal(await run("getComputedStyle(document.querySelector('.usage-heatmap-cell.entering')).animationName"), 'usage-cell-enter');
    await pause(900);
    await run("document.querySelector('.usage-heatmap-cell[tabindex=\"0\"]').focus(); document.activeElement.dispatchEvent(new FocusEvent('focusin', {bubbles:true}))");
    await until("document.querySelector('.usage-tooltip:popover-open')?.textContent.includes('Token')");
    await pause(140);
    fs.writeFileSync(path.join(root, 'tmp/settings-usage-reorganized.png'), (await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('.usage-heatmap-cell[tabindex=\"0\"]').blur()");
    await run("settingsTheme = 'bright'; renderSettings()"); await pause(150);
    fs.writeFileSync(path.join(root, 'tmp/settings-usage-light.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(760, 720); await pause(150);
    assert.equal(await run("document.querySelector('.usage-settings').scrollWidth <= document.querySelector('.usage-settings').clientWidth + 1"), true, 'usage fits a narrow settings column');
    assert.equal(await run("getComputedStyle(document.querySelector('.usage-stat-grid')).gridTemplateColumns.split(' ').length"), 2);
    fs.writeFileSync(path.join(root, 'tmp/settings-usage-narrow.png'), (await win.webContents.capturePage()).toPNG());
    win.setContentSize(1200, 850); await run("settingsTheme = 'dark'; renderSettings()"); await pause(100);
    await edit('.settings-search input', '不存在的设置');
    await until("!!document.querySelector('.settings-search-empty')");
    await run("document.querySelector('.settings-search input').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true }))");
    await until(`document.querySelectorAll('.settings-nav').length === ${expectedSettingsSections.length}`);
    assert.deepEqual(await run("Array.from(document.querySelectorAll('.settings-nav'), item => item.dataset.settingsSection)"), expectedSettingsSections, 'clearing search restores all local pages');

    // Failed reads must keep the last recorded totals, then recover on retry.
    await run("window.readUsageNormally = cardbushDesktop.usageStatistics; cardbushDesktop.usageStatistics = async () => { throw Error('fixture unavailable'); }; dispatchEvent(new Event('focus'));");
    await until("!!document.querySelector('.usage-load-error')");
    assert.equal(await run("document.querySelector('.usage-stat').title"), '59,961,000');
    await run("cardbushDesktop.usageStatistics = readUsageNormally; void 0"); await click('重试');
    await until("!document.querySelector('.usage-load-error')");

    await require('./helpers/settings-models.cjs')({ run, until, click, edit, window: win, root });
    win.setContentSize(1100, 800);
    await require('./helpers/settings-maintenance.cjs')({ run, until, window: win, root, click });
    await run('renderComposer()');
    await until("!!document.querySelector('.composer-surface')");
    await run("Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === '添加' || button.title === '添加').click()");
    await until("!!document.querySelector('.composer-add-menu')");
    assert.equal(await run("document.querySelectorAll('.composer-add-menu button').length"), 2);
    assert.doesNotMatch(await run("document.querySelector('.composer-add-menu').textContent"), /Skills|Git|项目上下文|视觉功能/);
    await run("document.querySelector('.composer-add-menu [role=switch]').click()");
    await until("composerProps.referencePlanMode === 'off'");
    fs.writeFileSync(path.join(root, 'tmp/composer-add-menu.png'), (await win.webContents.capturePage()).toPNG());
    await run('renderWorkspace(false)');
    await until("!!document.querySelector('.task-workspace-branches')");
    await run("document.querySelector('.task-workspace-details').open = true; document.querySelector('.task-workspace-branches').open = true");
    await until("document.querySelectorAll('.branch-list button').length === 2");
    assert.equal(await run("document.querySelectorAll('.branch-list button')[1].disabled"), false, 'Git remains usable before the first turn');
    await run('renderWorkspace(true)');
    await until("document.querySelectorAll('.branch-list button')[1].disabled");
    await run('renderGit(true)');
    await until("document.querySelectorAll('.branch-list button').length === 2");
    assert.equal(await run("Array.from(document.querySelectorAll('.branch-list button')).every(button => button.disabled)"), true);
    await run('renderGit(false)');
    await until("!document.querySelectorAll('.branch-list button')[1].disabled");
    await run("document.querySelectorAll('.branch-list button')[1].click()");
    await until('checkouts.length === 1');
    assert.deepEqual(await run('checkouts[0]'), { root: 'D:/fixture', branch: 'preview' });
    assert.deepEqual(await run('failures'), []);
    assert.deepEqual(errors, []);
    console.log('Settings context UI passed: grouped navigation, custom dropdowns and keyboard selection, blue controls, recorded usage with animation/tooltips/error recovery, responsive layout, saved styles, model limits and retained composer/Git operations.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
