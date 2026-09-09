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
    resolveId: id => id.endsWith('__settings_context_test__.ts') ? '\0settings-context-fixture' : undefined,
    load: id => id === '\0settings-context-fixture' ? [
      'src/features/SettingsView.tsx', 'src/features/composer/Composer.tsx', 'src/features/chat/GitBranchMenu.tsx', 'src/features/chat/TaskWorkspaceBar.tsx',
    ].map(file => `export * from ${JSON.stringify(path.join(root, file))};`).join('\n') : undefined,
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
    throw Error('Timed out: ' + code + '\n' + await run('document.body.innerText'));
  };
  const click = label => run(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const edit = (selector, value, textarea = false) => run(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(${textarea ? 'HTMLTextAreaElement' : 'HTMLInputElement'}.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  try {
    await win.loadURL('data:text/html,<html><body><div id="root"></div></body></html>');
    await win.webContents.insertCSS(['src/styles/theme.css', 'src/styles/app.css', 'src/styles/themes/cyberpunk.css'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n'));
    await run(`
      window.failures = [];
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
      window.file = { path: 'C:/Users/fixture/AppData/Roaming/cardbush/AGENTS.md', content: '请使用中文，并核对交付结果。', revision: 'one' };
      window.failSave = false; window.checkouts = [];
      window.cardbushDesktop = {
        readGlobalInstructions: async () => ({ ...file }),
        saveGlobalInstructions: async (content, revision) => {
          if (failSave) throw Error('fixture disk write failed');
          if (revision !== file.revision) throw Error('AGENTS.md changed; reload it before saving.');
          file = { ...file, content, revision: revision + '-saved' }; return { ...file };
        },
        gitInfo: async () => ({ branch: 'main' }), gitBranches: async () => ['main', 'preview'],
        gitCheckout: async (root, branch) => { checkouts.push({ root, branch }); return { branch }; },
      };
      const noop = () => {};
      window.fixtureModel = { id: 'fixture', provider: 'deepseek', modelName: 'deepseek-v4.1-flash-expires-on-0910', baseUrl: 'https://api.deepseek.com', apiKey: '', hasApiKey: true, maxContextTokens: 400000, maxCompletionTokens: 128000 };
      window.settingsProps = { active: true, onReady: noop, language: 'zh', languageMode: 'zh', systemLanguage: 'zh', themePreference: 'cyberpunk',
        settings: { managedModelConfigs: [fixtureModel, { ...fixtureModel, id: 'vision', modelName: 'deepseek-v4-flash-vision-exp' }], terminal: { runtime: 'powershell' }, browser: {}, proxy: {}, thinking: {}, guidance: {}, user: {}, font: {}, companion: {} },
        selectedModel: 'fixture', availableModels: [fixtureModel], backendCapabilities: {}, runtimeBusy: false, conversations: [], skills: [], disabledSkillNames: new Set(),
        initialSection: 'instructions', initialPluginTab: 'plugins', onBack: noop, onThemePreferenceChange: noop, onLanguageModeChange: noop,
        onSettingsChange: fn => { settingsProps.settings = fn(settingsProps.settings); renderSettings(); }, onUseModel: noop, onSidebarWidthChange: noop,
        onToggleSkill: noop, onReloadSkills: async () => [], onLoadSkillDetail: async () => null,
        visualInputAvailable: true, visualInputEnabled: false, onVisualInputEnabledChange: value => { settingsProps.visualInputEnabled = value; renderSettings(); },
      };
      window.renderSettings = () => reactRoot.render(h('div', { className: 'app theme-cyberpunk', style: { width: '100vw', height: '100vh', minWidth: 0 } }, h(views.SettingsView, settingsProps)));
      window.composerProps = { language: 'zh', draft: '', onDraftChange: noop, sending: false, selectedModel: 'fixture', availableModels: [fixtureModel],
        referencePlanAvailable: true, referencePlanMode: 'auto', permissionMode: 'task_free', subagentPermissionRouting: 'user', reasoningLevelAvailable: false, reasoningLevel: 'high', reasoningLevels: [],
        onModelChange: noop, onReferencePlanModeChange: value => { composerProps.referencePlanMode = value; renderComposer(); }, onPermissionModeChange: noop, onSubagentPermissionRoutingChange: noop,
        onReasoningLevelChange: noop, onSend: async () => {}, onCancel: async () => {}, skills: [{ name: 'Fixture skill', description: 'Retained skill', descriptionZh: '保留的技能' }], disabledSkillNames: new Set(), onConfigureModels: noop, onToggleSkill: noop };
      window.renderComposer = () => reactRoot.render(h('div', { className: 'app theme-cyberpunk', style: { minWidth: 0, width: '100vw', height: '100vh', display: 'flex', alignItems: 'end', padding: '36px' } }, h(views.Composer, composerProps)));
      window.renderWorkspace = busy => reactRoot.render(h(views.TaskWorkspaceBar, { sessionId: '', projectDir: 'D:/fixture', language: 'zh', busy, gitAvailable: true, onChanged: async () => {} }));
      window.renderGit = disabled => reactRoot.render(h(views.GitBranchMenu, { language: 'zh', activeProjectDir: 'D:/fixture', disabled }));
      renderSettings();
    `);
    await until("document.querySelector('#global-agent-instructions')?.value.includes('中文')");
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

    await click('模型管理');
    await until("document.querySelectorAll('.model-row').length === 2");
    assert.equal(await run("document.querySelector('.settings-switch input').checked"), false);
    await run("document.querySelector('.settings-switch input').click()");
    await until('settingsProps.visualInputEnabled === true');
    await edit('.model-row input', '500000');
    await run("document.querySelector('.model-context-save').click()");
    await until('settingsProps.settings.managedModelConfigs[0].maxContextTokens === 500000');
    for (const width of [1200, 1000, 760]) {
      win.setContentSize(width, 850); await pause(150);
      const bounds = await run(`Array.from(document.querySelectorAll('.model-row'), row => ({
        width: row.clientWidth, scroll: row.scrollWidth,
        inputs: Array.from(row.querySelectorAll('input'), input => { const r = input.getBoundingClientRect(), rowRect = row.getBoundingClientRect(); return { width: r.width, left: r.left - rowRect.left, right: rowRect.right - r.right }; })
      }))`);
      for (const row of bounds) {
        assert.ok(row.scroll <= row.width + 1, 'model row must fit width ' + width);
        for (const input of row.inputs) assert.ok(input.width >= 72 && input.left >= 0 && input.right >= 0, 'token controls remain readable and inside the row');
      }
      if (width === 1200) fs.writeFileSync(path.join(root, 'tmp/settings-model-limits.png'), (await win.webContents.capturePage()).toPNG());
    }
    win.setContentSize(1100, 800);
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
    console.log('Settings context UI passed: global save/failure, vision toggle, model limits at 3 widths, compact Add menu and retained Git operations.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
