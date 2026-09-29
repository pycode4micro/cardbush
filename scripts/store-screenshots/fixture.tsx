// Store artwork uses the shipping React views with isolated, bilingual demo data.
// No model, browser, terminal, filesystem or production-profile actions are run.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChatPanel } from '../../src/features/chat/ChatPanel';
import { ChatSidebar } from '../../src/features/sidebar/ChatSidebar';
import { WindowFrame } from '../../src/components/WindowFrame';
import { TopBar } from '../../src/components/TopBar';
import { SettingsView } from '../../src/features/SettingsView';
import { AutomationPanel } from '../../src/features/automations/AutomationPanel';
import { AppCenterProvider } from '../../src/features/appCenter/AppCenter';
import { requestAppCenter } from '../../src/features/appCenter/appCenterStore';
import { applicationMenus } from '../../src/features/windowMenu/applicationMenus';
import { ConversationHostContext } from '../../src/features/conversationHost';
import { readConversationStyle } from '../../src/features/settings/conversationStyle';
import { GlobalTooltip } from '../../src/components/GlobalTooltip';
import '../../src/styles/theme.css';
import '../../src/styles/app.css';
import '../../src/styles/windowMaterial.css';
import '../../src/styles/appearance.css';

const query = new URLSearchParams(location.search);
const language = query.get('language') === 'en' ? 'en' : 'zh';
const scene = query.get('scene') ?? 'conversation';
const zh = language === 'zh';
const theme = scene === 'app-center' || scene === 'automations' ? 'dark' : 'bright';
const t = (cn: string, en: string) => zh ? cn : en;
const noop = () => {};
const asyncNoop = async () => {};
const unsubscribe = () => noop;
const timestamp = '2026-09-29T02:00:00.000Z';
document.documentElement.lang = zh ? 'zh-CN' : 'en';
localStorage.setItem('cardbush_language_mode', language);
localStorage.setItem('cardbush_pinned_conversation_ids', JSON.stringify(['planning']));
localStorage.setItem('cardbush_app_center_v1', JSON.stringify({
  shortcuts: ['builtin:plugins', 'builtin:automations', 'builtin:settings'], display: 'always',
  links: [
    { id: 'external:learn', title: 'Microsoft Learn', url: 'https://learn.microsoft.com/' },
    { id: 'external:github', title: 'GitHub', url: 'https://github.com/' },
    { id: 'external:mdn', title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
  ],
}));

const conversations = [
  ['planning', t('本周工作计划', 'Weekly work plan')],
  ['meeting', t('把会议记录整理为行动清单', 'Turn meeting notes into actions')],
  ['research', t('整理产品调研资料', 'Organize product research')],
  ['writing', t('润色项目介绍', 'Refine a project introduction')],
  ['summary', t('汇总每周进展', 'Summarize weekly progress')],
].map(([id, title]) => ({ id, title, preview: title, updatedAt: timestamp }));
const projects = [
  { id: 'work', title: t('工作空间', 'Workspace'), rootPath: 'C:/Projects/Workspace' },
  { id: 'ideas', title: t('创意笔记', 'Creative notes'), rootPath: 'C:/Projects/Notes' },
];
const messages = [
  { id: 'demo-user', role: 'user', turnId: 'demo-turn', createdAt: timestamp,
    content: t('帮我把这段会议记录整理为行动清单，标出优先级和需要确认的事项。\n\n示例记录：周四前完成产品介绍初稿；下周发布新版；客服整理常见问题；发布时间还没确定。',
      'Turn these meeting notes into an action list. Highlight priorities and anything we still need to confirm.\n\nSample notes: finish the product brief by Thursday; release the update next week; compile customer FAQs; the release date is not confirmed.') },
  { id: 'demo-assistant', role: 'assistant', turnId: 'demo-turn', createdAt: '2026-09-29T02:00:18.000Z', status: 'completed',
    content: t('先完成**产品介绍初稿**，再根据确认后的发布时间安排后续工作。\n\n| 优先级 | 行动事项 | 截止时间 |\n| --- | --- | --- |\n| 高 | 完成产品介绍初稿 | 周四前 |\n| 高 | 确认新版发布时间与负责人 | 待确认 |\n| 中 | 整理客服常见问题 | 发布前 |\n| 中 | 汇总发布前检查清单 | 日期确认后 |\n\n**需要确认**\n\n- 新版的具体发布日期，以及最终确认人。\n- 产品介绍由谁审阅，初稿需要包含哪些内容。\n- 常见问题是用于内部培训，还是公开帮助页面。\n\n确认这些信息后，就可以把清单补全为可执行的时间表。',
      'Start with the **product brief**, then schedule the remaining work around the confirmed release date.\n\n| Priority | Action | Due |\n| --- | --- | --- |\n| High | Draft the product brief | Thursday |\n| High | Confirm the release date and owner | To be confirmed |\n| Medium | Compile customer FAQs | Before release |\n| Medium | Prepare a release checklist | After date confirmation |\n\n**Still to confirm**\n\n- The exact release date and who gives final approval.\n- Who reviews the product brief and what it should cover.\n- Whether the FAQs are for staff training or public help pages.\n\nOnce those details are confirmed, this list can become an actionable schedule.') },
];

const plugin = { id: 'chrome', name: 'Browser Use', source: 'bundled', version: '1.2.0', description: 'Browser Use',
  installed: true, enabled: true, config: { connectionMode: 'connector' }, components: [], capabilities: [], keywords: [], defaultPrompts: [] };
const apps = { revision: 1, serviceEnabled: true, plugins: [plugin] };
const browserStatus = {
  connectorEnabled: true, lifecycleState: 'enabled', platformSupported: true, nativeHostAvailable: true,
  extensionConnected: true, bridgeRegistered: false, bridgeRunning: true, controlledTabCount: 2,
  activeTabTitle: t('示例：产品资料', 'Sample: product research'), defaultConnectionId: 'demo-chrome',
  connections: [
    { id: 'demo-chrome', browser: 'chrome', label: t('Chrome · 工作', 'Chrome · Work'), connected: true, controlledTabCount: 2 },
    { id: 'demo-edge', browser: 'edge', label: t('Edge · 资料整理', 'Edge · Research'), connected: true, controlledTabCount: 0 },
  ],
};
const job = (id: string, name: string, prompt: string, hour: string, seconds?: number) => ({
  id, revision: 1, name, prompt, sessionId: 'planning', executionMode: 'isolated', state: 'active',
  timeZone: 'Asia/Shanghai', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: timestamp,
  trigger: seconds ? { kind: 'interval', at: `2026-09-28T${hour}:00+08:00`, seconds } : { kind: 'once', at: `2026-09-29T${hour}:00+08:00` },
  nextRunAt: `2026-09-29T${hour}:00+08:00`, runs: [],
});
const automations = { available: true, sessions: conversations.map(item => ({ ...item, model: 'demo' })), jobs: [
  job('daily', t('每日工作简报', 'Daily brief'), t('汇总工作区的最新进展，列出今天需要关注的事项。', 'Summarize workspace updates and list the items that need attention today.'), '11:00', 86400),
] };

(window as any).cardbushDesktop = {
  platform: 'win32', isMaximized: async () => false, writeDebugLog: asyncNoop,
  onChromeConnectorStatus: unsubscribe, onCapabilityCatalogChanged: unsubscribe,
  onAutomationChanged: unsubscribe, onCalendarChanged: unsubscribe,
  automationCommand: async () => structuredClone(automations),
  calendarCommand: async () => ({ state: { datasets: [], chineseLunar: false } }),
  readBrowserConfiguration: async () => ({ protocol: 'cardbush.browser_config.v1', revision: 1, startPage: 'https://www.google.com/' }),
  chromeConnectorStatus: async () => structuredClone(browserStatus),
  setupChromeConnector: asyncNoop, removeChromeConnector: asyncNoop, disableChromeConnector: asyncNoop,
  openChromeConnectorInstaller: asyncNoop, copyChromeConnectorDiagnostics: asyncNoop,
  pairChromeConnector: asyncNoop, revokeBrowserConnection: asyncNoop, selectDefaultBrowserConnection: asyncNoop,
  pluginCommands: async () => [],
  localApplications: { pick: async () => null, open: asyncNoop },
  productHostCommand: async ({ kind }: { kind: string }) => {
    if (kind === 'apps.get') return { protocol: 'cardbush.product_host_ipc.v1', ok: true, value: structuredClone(apps) };
    throw new Error('Unexpected screenshot fixture command: ' + kind);
  },
};
const host: any = { id: 'store-demo', plugins: [], pluginCommands: [], uploadFiles: async () => [],
  openFile: noop, toolDetails: async () => [], welcomeHistory: async () => [] };
const model: any = { id: 'demo', provider: 'custom', modelName: t('示例', 'Demo'), enabled: true, apiKey: '', hasApiKey: false };
const settings: any = { conversationStyle: readConversationStyle(), managedModelConfigs: [model],
  terminal: { runtime: 'powershell' }, browser: {}, proxy: {}, thinking: { visible: true },
  guidance: { deliveryMode: 'queue' }, user: {}, font: {}, companion: {}, importedThemeStyle: null };
const chatProps: any = {
  language, theme, title: t('把会议记录整理为行动清单', 'Turn meeting notes into actions'),
  sidebarCollapsed: false, windowMaximized: false, inspectorOpen: false, activeConversationId: 'meeting',
  selectedProjectDir: null, activeProjectDir: null, projectPathAliases: [], availableProjects: projects,
  projectContext: '', messages, activeGoal: null, goalAvailable: false, goalCancelling: false, goalWaiting: false,
  changeReports: [], skills: [], disabledSkillNames: new Set(), visualInputAvailable: false, visualInputEnabled: false,
  turnHistoryAvailable: false, subagentObservabilityAvailable: false, shadowAvailable: false,
  shadowAccentColor: '#78a9ef', shadowThemeVariables: {}, thinkingVisible: false, guidanceDeliveryMode: 'queue',
  loading: false, historyLoading: false, sending: false, stopping: false, activeTurnId: '',
  queuedMessageCount: 0, queuedMessagePreview: '', queuedMessages: [], pendingInteraction: null,
  error: null, notice: null, selectedModel: model.id, availableModels: [model], referencePlanAvailable: false,
  referencePlanMode: 'off', permissionMode: 'default', subagentPermissionRouting: 'user', reasoningLevelAvailable: false,
  reasoningLevel: 'medium', reasoningLevels: [], gitAvailable: false, draft: '',
};
for (const name of (window as any).screenshotCallbacks) chatProps[name] = asyncNoop;
const sidebar: any = { language, section: scene === 'automations' ? 'automations' : 'chat', activeConversationId: 'meeting',
  projects, conversations, changeReportsByConversation: {}, onSectionChange: noop, onConversationChange: noop,
  onCreateConversation: noop, onAddProject: noop, onProjectAction: noop, onDeleteConversation: noop,
  onRenameConversation: async () => true, onOpenConversationChanges: noop, onOpenSettings: noop, onOpenSearch: noop };
const menus = applicationMenus(language, {
  newConversation: noop, openAppCenter: requestAppCenter, openPlugins: noop, openAutomations: noop, openSettings: noop,
  showShortcuts: noop, openDiagnostics: noop, toggleSidebar: noop, toggleInspector: noop, search: noop, openBrowser: noop,
}, { sidebarVisible: true, inspectorVisible: false, native: true, externalLinks: false });

function Screen() {
  return <ConversationHostContext.Provider value={host}>
    <div className={`app theme-${theme}`} lang={language} style={{ '--sidebar-width': '272px' } as React.CSSProperties}>
      <AppCenterProvider language={language} onNavigate={noop}>
        <GlobalTooltip />
        <WindowFrame language={language} sidebarCollapsed={false} onToggleSidebar={noop} menus={menus} onError={console.error} />
        {scene === 'browser-use' ? <SettingsView {...{
          active: true, onReady: noop, language, languageMode: language, systemLanguage: language,
          themePreference: 'light', settings, selectedModel: model.id, availableModels: [model],
          backendCapabilities: { terminalRuntimes: ['powershell'], runtimeAssetResetCategories: [], browserPrivacyMode: false, reasoningStream: true },
          runtimeBusy: false, conversations, projects, skills: [], disabledSkillNames: new Set(), initialSection: 'browser',
          initialPluginTab: 'plugins', onBack: noop, onThemePreferenceChange: noop, onLanguageModeChange: noop,
          onSettingsChange: noop, onUseModel: noop, onSidebarWidthChange: noop, onToggleSkill: noop,
          onReloadSkills: async () => [], onLoadSkillDetail: async () => null, visualInputAvailable: false,
          visualInputEnabled: false, onVisualInputEnabledChange: noop, sidebarCollapsed: false,
          sidebarWidth: 272, sidebarPresence: { mounted: true, visible: true }, onSidebarCollapse: noop,
        } as any} /> : <main className="desktop-shell window-restored">
          <ChatSidebar {...sidebar} />
          <section className="main-stage">
            {scene === 'automations' ? <div className="feature-panel">
              <TopBar title={t('定时与自动化', 'Automations')} language={language} inspectorOpen={false} onToggleInspector={noop} />
              <AutomationPanel language={language} onOpenConversation={noop} onCreateAutomation={noop} />
            </div> : <ChatPanel {...chatProps} />}
          </section>
        </main>}
      </AppCenterProvider>
    </div>
  </ConversationHostContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<Screen />);
(window as any).openScreenshotAppCenter = requestAppCenter;
