import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchCardbushAppsConfiguration,
  saveCardbushAppsConfiguration,
} from '../../backend/api';
import { fileUrl } from '../../shared/localPaths';
import type {
  AppLanguage,
  CardbushAppPlugin,
  CardbushAppsConfiguration,
  SkillDetail,
  SkillSummary,
} from '../../types';
import { SkillIcon } from '../skills/SkillIcon';
import './plugin-management.css';

type Page =
  | { kind: 'catalog' }
  | { kind: 'manage' }
  | { kind: 'plugin'; pluginId: string }
  | { kind: 'skill'; skillName: string };

type ManageTab = 'plugins' | 'apps' | 'mcp';

export function PluginManagementPanel({
  language,
  initialTab,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onOpenMcp,
  onNotify,
}: {
  language: AppLanguage;
  initialTab: 'plugins' | 'skills';
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onOpenMcp: () => void;
  onNotify: (message: string) => void;
}) {
  const [tab, setTab] = useState<'plugins' | 'skills'>(initialTab);
  const [page, setPage] = useState<Page>({ kind: 'catalog' });
  const [configuration, setConfiguration] = useState<CardbushAppsConfiguration | null>(null);
  const [localSkills, setLocalSkills] = useState(skills);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setLocalSkills(skills), [skills]);
  useEffect(() => {
    setTab(initialTab);
    setPage({ kind: 'catalog' });
  }, [initialTab]);
  useEffect(() => {
    if (!addOpen) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !addMenuRef.current?.contains(target)) setAddOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside, true);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [addOpen]);

  const load = useCallback(async () => {
    setBusy('load');
    setError('');
    try {
      const [apps, loadedSkills] = await Promise.all([
        fetchCardbushAppsConfiguration(),
        onReloadSkills(),
      ]);
      setConfiguration(apps);
      setLocalSkills(loadedSkills);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [onReloadSkills]);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async (
    next: CardbushAppsConfiguration,
    key: string,
    message: string,
  ) => {
    setBusy(key);
    setError('');
    try {
      const saved = await saveCardbushAppsConfiguration(next);
      setConfiguration(saved);
      setLocalSkills(await onReloadSkills());
      onNotify(message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [onNotify, onReloadSkills]);

  const replacePlugin = useCallback((plugin: CardbushAppPlugin) => {
    setConfiguration((current) => current ? {
      ...current,
      plugins: current.plugins.map((item) => item.id === plugin.id ? plugin : item),
    } : current);
  }, []);

  const openSkill = useCallback(async (skill: SkillSummary) => {
    setPage({ kind: 'skill', skillName: skill.name });
    setSkillDetail(null);
    setBusy(`skill:${skill.name}`);
    setError('');
    try {
      setSkillDetail(await onLoadSkillDetail(skill.name));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [onLoadSkillDetail]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const plugins = configuration?.plugins ?? [];
  const filteredPlugins = useMemo(() => plugins.filter((plugin) => !normalizedQuery || [
    plugin.name,
    plugin.description,
    plugin.category,
    ...plugin.keywords,
    ...plugin.components.flatMap((component) => [component.name, component.description, component.id]),
  ].join(' ').toLocaleLowerCase().includes(normalizedQuery)), [normalizedQuery, plugins]);
  const filteredSkills = useMemo(() => localSkills.filter((skill) => !normalizedQuery || [
    skill.name,
    skill.description,
    skill.descriptionZh ?? '',
  ].join(' ').toLocaleLowerCase().includes(normalizedQuery)), [localSkills, normalizedQuery]);

  const selectedPlugin = page.kind === 'plugin'
    ? plugins.find((plugin) => plugin.id === page.pluginId)
    : undefined;
  if (selectedPlugin) {
    return (
      <PluginDetail
        language={language}
        plugin={selectedPlugin}
        busy={Boolean(busy)}
        onBack={() => setPage({ kind: 'catalog' })}
        onReplace={replacePlugin}
        onPersist={(plugin, message) => configuration && void persist({
          ...configuration,
          plugins: configuration.plugins.map((item) => item.id === plugin.id ? plugin : item),
        }, `plugin:${plugin.id}`, message)}
      />
    );
  }

  if (page.kind === 'skill') {
    const summary = localSkills.find((skill) => skill.name === page.skillName);
    return (
      <SkillDetailPage
        language={language}
        skill={skillDetail ?? summary ?? null}
        loading={busy === `skill:${page.skillName}`}
        error={error}
        enabled={!disabledSkillNames.has(page.skillName)}
        onBack={() => setPage({ kind: 'catalog' })}
        onToggle={(enabled) => onToggleSkill(page.skillName, enabled)}
      />
    );
  }

  if (page.kind === 'manage') {
    return (
      <PluginManagementList
        language={language}
        configuration={configuration}
        query={query}
        plugins={filteredPlugins}
        busy={Boolean(busy)}
        onQuery={setQuery}
        onBack={() => setPage({ kind: 'catalog' })}
        onOpen={(plugin) => setPage({ kind: 'plugin', pluginId: plugin.id })}
        onPersist={(next, message) => void persist(next, 'manage', message)}
      />
    );
  }

  return (
    <div className="plugin-hub">
      <div className="plugin-hub-toolbar">
        <div className="plugin-hub-tabs" role="tablist">
          <button className={tab === 'plugins' ? 'active' : ''} type="button" onClick={() => setTab('plugins')}>
            {language === 'zh' ? '插件' : 'Plugins'}
          </button>
          <button className={tab === 'skills' ? 'active' : ''} type="button" onClick={() => setTab('skills')}>
            {language === 'zh' ? '技能' : 'Skills'}
          </button>
        </div>
        <div className="plugin-hub-actions">
          <button type="button" title={language === 'zh' ? '刷新' : 'Refresh'} onClick={() => void load()}>
            {busy === 'load' ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
          <button type="button" title={language === 'zh' ? '管理' : 'Manage'} onClick={() => setPage({ kind: 'manage' })}>
            <Settings size={17} />
          </button>
          <div className="plugin-add-wrap" ref={addMenuRef}>
            <button className="plugin-add-button" type="button" onClick={() => setAddOpen((value) => !value)}>
              {language === 'zh' ? '添加' : 'Add'} <ChevronDown size={15} />
            </button>
            {addOpen && (
              <div className="plugin-add-menu">
                <button type="button" onClick={() => {
                  setAddOpen(false);
                  void window.cardbushDesktop?.installLocalPlugin().then((installed) => {
                    if (!installed) return;
                    onNotify(language === 'zh' ? `已安装 ${installed.id}` : `Installed ${installed.id}`);
                    void load();
                  }).catch((caught) => setError(errorMessage(caught)));
                }}>
                  <FolderOpen size={15} />
                  <span><strong>{language === 'zh' ? '从本地安装插件' : 'Install local plugin'}</strong><small>.codex-plugin/plugin.json</small></span>
                </button>
                <button type="button" onClick={() => { setAddOpen(false); onOpenMcp(); }}>
                  <Plus size={15} />
                  <span><strong>{language === 'zh' ? '添加 MCP 服务' : 'Add MCP server'}</strong><small>{language === 'zh' ? '连接本地或远程工具服务' : 'Connect a local or remote tool service'}</small></span>
                </button>
                <button type="button" onClick={() => { setAddOpen(false); setTab('skills'); }}>
                  <PackagePlus size={15} />
                  <span><strong>{language === 'zh' ? '查看技能' : 'Browse skills'}</strong><small>{language === 'zh' ? '管理 CardBush 技能目录' : 'Manage the CardBush Skill catalog'}</small></span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && <p className="plugin-hub-error">{error}</p>}
      {tab === 'plugins' ? (
        <PluginCatalog
          language={language}
          configuration={configuration}
          plugins={filteredPlugins}
          query={query}
          busy={Boolean(busy)}
          onQuery={setQuery}
          onOpen={(plugin) => setPage({ kind: 'plugin', pluginId: plugin.id })}
          onInstall={(plugin) => configuration && void persist({
            ...configuration,
            plugins: configuration.plugins.map((item) => item.id === plugin.id
              ? { ...item, installed: true, enabled: true }
              : item),
          }, `install:${plugin.id}`, language === 'zh' ? '插件已安装' : 'Plugin installed')}
        />
      ) : (
        <SkillCatalog
          language={language}
          skills={filteredSkills}
          query={query}
          disabledSkillNames={disabledSkillNames}
          onQuery={setQuery}
          onOpen={(skill) => void openSkill(skill)}
          onToggle={onToggleSkill}
        />
      )}
    </div>
  );
}

function PluginCatalog({ language, configuration, plugins, query, busy, onQuery, onOpen, onInstall }: {
  language: AppLanguage;
  configuration: CardbushAppsConfiguration | null;
  plugins: CardbushAppPlugin[];
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onOpen: (plugin: CardbushAppPlugin) => void;
  onInstall: (plugin: CardbushAppPlugin) => void;
}) {
  const [scope, setScope] = useState<'public' | 'personal'>('public');
  const scopedPlugins = plugins.filter((plugin) =>
    scope === 'public' ? plugin.source === 'bundled' : plugin.source === 'user');
  const installed = scopedPlugins.filter((plugin) => plugin.installed);
  return (
    <div className="plugin-catalog-page">
      <header className="plugin-catalog-heading"><h2>{language === 'zh' ? '插件' : 'Plugins'}</h2><p>{language === 'zh' ? '在你常用的工具中使用 CardBush' : 'Use CardBush with the tools you rely on'}</p></header>
      <SearchField language={language} value={query} onChange={onQuery} kind="plugins" />
      <section className="plugin-installed-section">
        <div className="plugin-section-title"><h3>{language === 'zh' ? '已安装' : 'Installed'}</h3><span>{installed.length}</span></div>
        <div className="plugin-installed-icons">
          {installed.map((plugin) => <button type="button" key={plugin.id} title={plugin.name} onClick={() => onOpen(plugin)}><PluginLogo plugin={plugin} /><span>{plugin.name}</span></button>)}
          {!installed.length && <small>{language === 'zh' ? '暂无已安装插件' : 'No installed plugins'}</small>}
        </div>
        <div className="plugin-scope-tabs" role="tablist">
          <button className={scope === 'public' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'public'} onClick={() => setScope('public')}>{language === 'zh' ? '公开' : 'Public'}</button>
          <button className={scope === 'personal' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'personal'} onClick={() => setScope('personal')}>{language === 'zh' ? '个人' : 'Personal'}</button>
        </div>
      </section>
      <section className="plugin-featured-section">
        <div className="plugin-section-title"><h3>{language === 'zh' ? 'CardBush 精选' : 'CardBush featured'}</h3></div>
        <div className="plugin-featured-grid">
          {scopedPlugins.map((plugin) => (
            <article key={plugin.id}>
              <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}>
                <PluginLogo plugin={plugin} />
                <span><strong>{plugin.name}</strong><small>{plugin.description}</small></span>
              </button>
              {plugin.installed ? <span className="plugin-installed-check"><Check size={17} /></span> : (
                <button className="plugin-install-button" type="button" disabled={busy || !configuration} onClick={() => onInstall(plugin)}>{language === 'zh' ? '安装' : 'Install'}</button>
              )}
            </article>
          ))}
          {scopedPlugins.length === 0 && <p className="plugin-catalog-empty">{language === 'zh' ? '当前分类还没有插件' : 'No plugins in this scope'}</p>}
        </div>
      </section>
    </div>
  );
}

function SkillCatalog({ language, skills, query, disabledSkillNames, onQuery, onOpen, onToggle }: {
  language: AppLanguage;
  skills: SkillSummary[];
  query: string;
  disabledSkillNames: Set<string>;
  onQuery: (value: string) => void;
  onOpen: (skill: SkillSummary) => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  return (
    <div className="plugin-catalog-page">
      <header className="plugin-catalog-heading"><h2>{language === 'zh' ? '技能' : 'Skills'}</h2><p>{language === 'zh' ? '通过任务专用技能扩展 CardBush' : 'Extend CardBush with task-specific skills'}</p></header>
      <SearchField language={language} value={query} onChange={onQuery} kind="skills" />
      <section className="plugin-featured-section">
        <div className="plugin-section-title"><h3>{language === 'zh' ? '已安装' : 'Installed'}</h3><span>{skills.length}</span></div>
        <div className="skill-catalog-grid">
          {skills.map((skill) => {
            const enabled = !disabledSkillNames.has(skill.name);
            return (
              <article key={skill.name}>
                <button className="plugin-featured-main" type="button" onClick={() => onOpen(skill)}>
                  <SkillIcon skill={skill} />
                  <span><strong>{skill.name}</strong><small>{language === 'zh' ? skill.descriptionZh ?? skill.description : skill.description}</small></span>
                </button>
                <button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={() => onToggle(skill.name, !enabled)}><span /></button>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function PluginManagementList({ language, configuration, plugins, query, busy, onQuery, onBack, onOpen, onPersist }: {
  language: AppLanguage;
  configuration: CardbushAppsConfiguration | null;
  plugins: CardbushAppPlugin[];
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onBack: () => void;
  onOpen: (plugin: CardbushAppPlugin) => void;
  onPersist: (configuration: CardbushAppsConfiguration, message: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<ManageTab>('plugins');
  const installed = plugins.filter((plugin) => plugin.installed);
  const appCount = installed.reduce((sum, plugin) => sum + plugin.components.filter((item) => item.kind === 'app').length, 0);
  const mcpCount = installed.reduce((sum, plugin) => sum + plugin.components.filter((item) => item.kind === 'mcp').length, 0);
  const components = installed.flatMap((plugin) => plugin.components
    .filter((component) => component.kind === (activeTab === 'apps' ? 'app' : 'mcp'))
    .map((component) => ({ plugin, component })));
  const togglePlugin = (plugin: CardbushAppPlugin) => {
    if (!configuration) return;
    onPersist({
      ...configuration,
      plugins: configuration.plugins.map((item) => item.id === plugin.id
        ? { ...item, enabled: !item.enabled }
        : item),
    }, plugin.enabled
      ? (language === 'zh' ? '插件已停用' : 'Plugin disabled')
      : (language === 'zh' ? '插件已启用' : 'Plugin enabled'));
  };
  return (
    <div className="plugin-manage-page">
      <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{language === 'zh' ? '插件' : 'Plugins'}</button>
      <div className="plugin-manage-tabs" role="tablist">
        <button className={activeTab === 'plugins' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'plugins'} onClick={() => setActiveTab('plugins')}>{language === 'zh' ? '插件' : 'Plugins'} <em>{installed.length}</em></button>
        <button className={activeTab === 'apps' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'apps'} onClick={() => setActiveTab('apps')}>{language === 'zh' ? '应用' : 'Apps'} <em>{appCount}</em></button>
        <button className={activeTab === 'mcp' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')}>MCP <em>{mcpCount}</em></button>
      </div>
      <SearchField language={language} value={query} onChange={onQuery} kind={activeTab === 'plugins' ? 'plugins' : activeTab} />
      <div className="plugin-manage-list">
        {activeTab === 'plugins' && installed.map((plugin) => (
          <article key={plugin.id}>
            <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}><PluginLogo plugin={plugin} /><span><strong>{plugin.name}</strong><small>{plugin.description}</small></span></button>
            <button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy || !configuration} onClick={() => togglePlugin(plugin)}><span /></button>
          </article>
        ))}
        {activeTab !== 'plugins' && components.map(({ plugin, component }) => (
          <article key={`${plugin.id}:${component.kind}:${component.id}`}>
            <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}>
              <PluginLogo plugin={plugin} />
              <span><strong>{component.name}</strong><small>{component.description} · {plugin.name}</small></span>
            </button>
            <button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy || !configuration} onClick={() => togglePlugin(plugin)}><span /></button>
          </article>
        ))}
        {((activeTab === 'plugins' && installed.length === 0) || (activeTab !== 'plugins' && components.length === 0)) && (
          <p className="plugin-manage-empty">{language === 'zh' ? '没有匹配的已安装项目' : 'No matching installed items'}</p>
        )}
      </div>
    </div>
  );
}

function PluginDetail({ language, plugin, busy, onBack, onReplace, onPersist }: {
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  busy: boolean;
  onBack: () => void;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  return (
    <div className="plugin-detail-page">
      <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{language === 'zh' ? '返回插件' : 'Back to plugins'}</button>
      <header className="plugin-detail-hero">
        <PluginLogo plugin={plugin} large />
        <div><h2>{plugin.name}</h2><p>{plugin.description}</p></div>
        {plugin.installed ? <button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy} onClick={() => onPersist({ ...plugin, enabled: !plugin.enabled }, plugin.enabled ? (language === 'zh' ? '插件已停用' : 'Plugin disabled') : (language === 'zh' ? '插件已启用' : 'Plugin enabled'))}><span /></button> : <button className="plugin-detail-primary" type="button" disabled={busy} onClick={() => onPersist({ ...plugin, installed: true, enabled: true }, language === 'zh' ? '插件已安装' : 'Plugin installed')}>{language === 'zh' ? '立即试用' : 'Install'}</button>}
      </header>
      {plugin.defaultPrompts.length > 0 && <div className="plugin-prompt-showcase" style={{ '--plugin-brand': plugin.brandColor } as CSSProperties}>{plugin.defaultPrompts.map((prompt) => <div key={prompt}><PluginLogo plugin={plugin} compact /><span><strong>{plugin.name}</strong>{prompt}</span><ChevronRight size={18} /></div>)}</div>}
      <p className="plugin-long-description">{plugin.longDescription}</p>
      <section className="plugin-detail-section"><h3>{language === 'zh' ? `组成 ${plugin.components.length}` : `Components ${plugin.components.length}`}</h3>{plugin.components.map((component) => <div className="plugin-component-row" key={`${component.kind}-${component.id}`}><span className={`plugin-component-kind ${component.kind}`}>{component.kind === 'skill' ? 'S' : component.kind === 'mcp' ? 'M' : 'A'}</span><div><strong>{component.name}</strong><small>{component.description}</small></div>{plugin.installed && <Check size={17} />}</div>)}</section>
      {plugin.id === 'computer-use' && plugin.installed && <section className="plugin-detail-section"><h3>{language === 'zh' ? '配置' : 'Settings'}</h3><label className="plugin-path-setting"><span>{language === 'zh' ? '截图保存目录' : 'Screenshot directory'}</span><input value={String(plugin.config.screenshotDirectory ?? '')} placeholder={language === 'zh' ? '留空时使用系统临时目录' : 'Use the system temp directory when empty'} onChange={(event) => onReplace({ ...plugin, config: { ...plugin.config, screenshotDirectory: event.currentTarget.value } })} /></label><label className="plugin-check-setting"><input type="checkbox" checked={plugin.config.allowOpenApp !== false} onChange={(event) => onReplace({ ...plugin, config: { ...plugin.config, allowOpenApp: event.currentTarget.checked } })} />{language === 'zh' ? '允许启动应用' : 'Allow opening apps'}</label><label className="plugin-check-setting"><input type="checkbox" checked={plugin.config.allowWindowClose !== false} onChange={(event) => onReplace({ ...plugin, config: { ...plugin.config, allowWindowClose: event.currentTarget.checked } })} />{language === 'zh' ? '允许关闭窗口' : 'Allow closing windows'}</label><button className="plugin-install-button" type="button" onClick={() => onPersist(plugin, language === 'zh' ? '配置已保存' : 'Settings saved')}>{language === 'zh' ? '保存配置' : 'Save settings'}</button></section>}
      {plugin.id === 'chrome' && plugin.installed && (
        <ChromeConnectionSettings
          language={language}
          plugin={plugin}
          onReplace={onReplace}
          onPersist={onPersist}
        />
      )}
      <section className="plugin-detail-section plugin-info"><h3>{language === 'zh' ? '信息' : 'Information'}</h3><Info label={language === 'zh' ? '功能' : 'Capabilities'} value={plugin.capabilities.join(', ')} /><Info label={language === 'zh' ? '开发者' : 'Developer'} value={plugin.developerName} /><Info label={language === 'zh' ? '类别' : 'Category'} value={plugin.category} /><Info label={language === 'zh' ? '版本' : 'Version'} value={plugin.version} /><Info label="Manifest" value={plugin.manifestPath} /></section>
    </div>
  );
}

function ChromeConnectionSettings({ language, plugin, onReplace, onPersist }: {
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const connectionMode = plugin.config.connectionMode === 'managed' ? 'managed' : 'existing';
  const setConnectionMode = (mode: 'managed' | 'existing') => {
    onReplace({ ...plugin, config: { ...plugin.config, connectionMode: mode } });
  };
  return (
    <section className="plugin-detail-section">
      <h3>{language === 'zh' ? '浏览器连接' : 'Browser connection'}</h3>
      <label className="plugin-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={connectionMode === 'managed'} onChange={() => setConnectionMode('managed')} />
        <span>
          <strong>{language === 'zh' ? '独立受控浏览器' : 'Managed browser'}</strong>
          <small>{language === 'zh' ? '由 Chrome 插件启动独立实例，不使用日常浏览器的登录状态。' : 'Launch a separate instance without using your everyday browser session.'}</small>
        </span>
      </label>
      <label className="plugin-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={connectionMode === 'existing'} onChange={() => setConnectionMode('existing')} />
        <span>
          <strong>{language === 'zh' ? '优先复用当前 Chrome' : 'Prefer current Chrome'}</strong>
          <small>{language === 'zh' ? '远程调试可用时复用标签页与登录状态；不可用时自动使用独立受控浏览器，避免任务中断。' : 'Reuse tabs and signed-in state when remote debugging is available, otherwise fall back to a managed browser so the task can continue.'}</small>
        </span>
      </label>
      {connectionMode === 'existing' && (
        <p className="plugin-setting-note">
          {language === 'zh'
            ? '需要 Chrome 144 或更高版本，并在 chrome://inspect/#remote-debugging 开启远程调试。Agent 将能访问该浏览器中的页面和登录数据。'
            : 'Requires Chrome 144 or newer with remote debugging enabled at chrome://inspect/#remote-debugging. The Agent can access pages and signed-in data in that browser.'}
        </p>
      )}
      <button className="plugin-install-button" type="button" onClick={() => onPersist(plugin, language === 'zh' ? 'Chrome 连接方式已保存' : 'Chrome connection saved')}>
        {language === 'zh' ? '保存配置' : 'Save settings'}
      </button>
    </section>
  );
}

function SkillDetailPage({ language, skill, loading, error, enabled, onBack, onToggle }: { language: AppLanguage; skill: SkillSummary | SkillDetail | null; loading: boolean; error: string; enabled: boolean; onBack: () => void; onToggle: (enabled: boolean) => void }) {
  return <div className="plugin-detail-page"><button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{language === 'zh' ? '返回技能' : 'Back to skills'}</button>{loading ? <div className="plugin-detail-loading"><LoaderCircle className="spin" />{language === 'zh' ? '正在加载技能' : 'Loading skill'}</div> : skill ? <><header className="plugin-detail-hero"><SkillIcon skill={skill} /><div><h2>{skill.name}</h2><p>{language === 'zh' ? skill.descriptionZh ?? skill.description : skill.description}</p></div><button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" onClick={() => onToggle(!enabled)}><span /></button></header><section className="plugin-detail-section plugin-info"><h3>{language === 'zh' ? '信息' : 'Information'}</h3>{'version' in skill && <Info label={language === 'zh' ? '版本' : 'Version'} value={skill.version || '—'} />}<Info label={language === 'zh' ? '位置' : 'Location'} value={skill.path} /></section>{'content' in skill && <section className="plugin-detail-section"><h3>SKILL.md</h3><pre className="plugin-skill-source">{skill.content}</pre></section>}</> : <p className="plugin-hub-error">{error}</p>}</div>;
}

function PluginLogo({ plugin, large = false, compact = false }: { plugin: CardbushAppPlugin; large?: boolean; compact?: boolean }) {
  const source = plugin.logoPath ? fileUrl(plugin.logoPath) : '';
  return <span className={`plugin-logo${large ? ' large' : ''}${compact ? ' compact' : ''}`} style={{ '--plugin-brand': plugin.brandColor } as CSSProperties}>{source ? <img src={source} alt="" /> : <PackagePlus size={large ? 28 : 20} />}</span>;
}

function SearchField({ language, value, onChange, kind }: { language: AppLanguage; value: string; onChange: (value: string) => void; kind: 'plugins' | 'skills' | 'apps' | 'mcp' }) {
  const chineseKind = kind === 'plugins' ? '插件' : kind === 'skills' ? '技能' : kind === 'apps' ? '应用' : 'MCP';
  return <label className="plugin-search"><Search size={18} /><input value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={language === 'zh' ? `搜索${chineseKind}` : `Search ${kind}`} /></label>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="plugin-info-row"><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
