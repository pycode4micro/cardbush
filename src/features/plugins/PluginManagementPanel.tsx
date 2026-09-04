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
    skill.sourceLabel ?? '',
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
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const standaloneSkills = skills.filter((skill) => skill.source !== 'plugin');
  const pluginGroups = [...skills.reduce((groups, skill) => {
    if (skill.source !== 'plugin') return groups;
    const key = skill.sourceId || skill.sourceLabel || 'plugin';
    const group = groups.get(key) ?? {
      key,
      label: skill.sourceLabel || skill.sourceId || (language === 'zh' ? '插件' : 'Plugin'),
      skills: [] as SkillSummary[],
    };
    group.skills.push(skill);
    groups.set(key, group);
    return groups;
  }, new Map<string, { key: string; label: string; skills: SkillSummary[] }>()).values()]
    .sort((left, right) => left.label.localeCompare(right.label));
  const searching = Boolean(query.trim());
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <div className="plugin-catalog-page">
      <header className="plugin-catalog-heading"><h2>{language === 'zh' ? '技能' : 'Skills'}</h2><p>{language === 'zh' ? '通过任务专用技能扩展 CardBush' : 'Extend CardBush with task-specific skills'}</p></header>
      <SearchField language={language} value={query} onChange={onQuery} kind="skills" />
      <section className="plugin-featured-section">
        <div className="plugin-section-title"><h3>{language === 'zh' ? '已安装' : 'Installed'}</h3><span>{skills.length}</span></div>
        <div className="skill-catalog-grid">
          {standaloneSkills.map((skill) => (
            <SkillCatalogCard
              key={skill.name}
              language={language}
              skill={skill}
              enabled={!disabledSkillNames.has(skill.name)}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
          {pluginGroups.map((group) => {
            const expanded = searching || expandedGroups.has(group.key);
            const countLabel = language === 'zh'
              ? `${group.skills.length} 个技能`
              : `${group.skills.length} ${group.skills.length === 1 ? 'skill' : 'skills'}`;
            return (
              <section className={`skill-plugin-group${expanded ? ' expanded' : ''}`} key={group.key}>
                <button
                  className="skill-plugin-group-header"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="skill-plugin-group-icon"><PackagePlus size={20} /></span>
                  <strong>{group.label} · {countLabel}</strong>
                  <ChevronRight size={17} />
                </button>
                {expanded && (
                  <div className="skill-plugin-group-grid">
                    {group.skills.map((skill) => (
                      <SkillCatalogCard
                        key={skill.name}
                        language={language}
                        skill={skill}
                        enabled={!disabledSkillNames.has(skill.name)}
                        onOpen={onOpen}
                        onToggle={onToggle}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {skills.length === 0 && <p className="plugin-catalog-empty">{language === 'zh' ? '没有匹配的技能' : 'No matching skills'}</p>}
        </div>
      </section>
    </div>
  );
}

function SkillCatalogCard({ language, skill, enabled, onOpen, onToggle }: {
  language: AppLanguage;
  skill: SkillSummary;
  enabled: boolean;
  onOpen: (skill: SkillSummary) => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const source = skillSourceText(language, skill);
  return (
    <article>
      <button className="plugin-featured-main" type="button" onClick={() => onOpen(skill)}>
        <SkillIcon skill={skill} />
        <span>
          <span className="skill-card-title"><strong>{skill.name}</strong>{source && <em>{source}</em>}</span>
          <small>{language === 'zh' ? skill.descriptionZh ?? skill.description : skill.description}</small>
        </span>
      </button>
      <button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={() => onToggle(skill.name, !enabled)}><span /></button>
    </article>
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
          busy={busy}
          onReplace={onReplace}
          onPersist={onPersist}
        />
      )}
      <section className="plugin-detail-section plugin-info"><h3>{language === 'zh' ? '信息' : 'Information'}</h3><Info label={language === 'zh' ? '功能' : 'Capabilities'} value={plugin.capabilities.join(', ')} /><Info label={language === 'zh' ? '开发者' : 'Developer'} value={plugin.developerName} /><Info label={language === 'zh' ? '类别' : 'Category'} value={plugin.category} /><Info label={language === 'zh' ? '版本' : 'Version'} value={plugin.version} /><Info label="Manifest" value={plugin.manifestPath} /></section>
    </div>
  );
}

type ChromeConnectorStatus = NonNullable<Window['cardbushDesktop']> extends infer Desktop
  ? Desktop extends { chromeConnectorStatus: () => Promise<infer Status> } ? Status : never
  : never;

export function ChromeConnectionSettings({ language, plugin, busy, onReplace, onPersist }: {
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  busy: boolean;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const [status, setStatus] = useState<ChromeConnectorStatus | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const connector = window.cardbushDesktop;
  const mode = plugin.config.connectionMode === 'remote_debugging'
    ? 'remote_debugging'
    : 'connector';

  const refresh = useCallback(async () => {
    if (!connector?.chromeConnectorStatus) return;
    try {
      setStatus(await connector.chromeConnectorStatus());
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [connector]);

  useEffect(() => {
    void refresh();
    return connector?.onChromeConnectorStatus?.((next) => setStatus(next));
  }, [connector, refresh]);

  const selectMode = (connectionMode: 'connector' | 'remote_debugging') => {
    const next = { ...plugin, config: { ...plugin.config, connectionMode } };
    onReplace(next);
    onPersist(next, language === 'zh' ? 'Chrome 连接方式已保存' : 'Chrome connection mode saved');
  };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setWorking(key);
    setError('');
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking('');
    }
  };

  return (
    <section className="plugin-detail-section">
      <h3>{language === 'zh' ? '浏览器连接' : 'Browser connection'}</h3>
      <label className="plugin-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'connector'} disabled={busy} onChange={() => selectMode('connector')} />
        <span><strong>{language === 'zh' ? 'Browser Connector（推荐）' : 'Browser Connector (recommended)'}</strong><small>{language === 'zh' ? '通过 Chrome 扩展和本地桥复用当前标签页、Cookie 与登录状态。' : 'Reuse current tabs, cookies, and signed-in state through the Chrome extension and local bridge.'}</small></span>
      </label>
      <label className="plugin-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'remote_debugging'} disabled={busy} onChange={() => selectMode('remote_debugging')} />
        <span><strong>{language === 'zh' ? '远程调试兼容模式' : 'Remote debugging compatibility mode'}</strong><small>{language === 'zh' ? '仅供开发者使用；连接已主动开启远程调试的 Chrome，不创建临时资料。' : 'For advanced development only; connects to an opted-in remote-debugging Chrome without creating a temporary profile.'}</small></span>
      </label>
      {mode === 'connector' ? (
        <div className="chrome-connector-card">
          <div className="chrome-connector-heading">
            <span className={`chrome-connector-indicator ${status?.extensionConnected ? 'online' : status?.bridgeRunning ? 'waiting' : ''}`} />
            <div>
              <strong>{status?.extensionConnected
                ? (language === 'zh' ? 'Chrome 已连接' : 'Chrome connected')
                : status?.bridgeRunning
                  ? (language === 'zh' ? '本地桥已就绪，等待扩展' : 'Local bridge ready; waiting for extension')
                  : (language === 'zh' ? '连接器未就绪' : 'Connector not ready')}</strong>
              <small>{status?.extensionConnected
                ? `${status.activeTabTitle || (language === 'zh' ? '当前标签页' : 'Current tab')} · ${status.controlledTabCount} ${language === 'zh' ? '个受控标签页' : 'controlled tabs'}`
                : (language === 'zh' ? '安装扩展后，在扩展弹窗中授权本次、当前网站或全部网站。' : 'After installing, grant this tab, this site, or all sites in the extension popup.')}</small>
            </div>
          </div>
          <div className="chrome-connector-actions">
            <button className="plugin-install-button" type="button" disabled={working !== '' || status?.bridgeRegistered === true || status?.nativeHostAvailable === false} title={status?.setupMessage} onClick={() => void run('bridge', async () => connector?.setupChromeConnector())}>
              {working === 'bridge' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.bridgeRegistered ? (language === 'zh' ? '本地桥已配置' : 'Local bridge configured') : (language === 'zh' ? '1. 配置本地桥' : '1. Configure local bridge')}
            </button>
            <button className="plugin-install-button" type="button" disabled={working !== '' || !connector?.openChromeConnectorInstaller} onClick={() => void run('extension', async () => connector?.openChromeConnectorInstaller())}>
              {working === 'extension' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.storeUrl ? (language === 'zh' ? '2. 从商店安装扩展' : '2. Install from Chrome Web Store') : (language === 'zh' ? '2. 打开扩展目录' : '2. Open extension folder')}
            </button>
            <button className="plugin-install-button secondary" type="button" disabled={working !== ''} onClick={() => void refresh()}><RefreshCw size={14} />{language === 'zh' ? '刷新状态' : 'Refresh'}</button>
          </div>
          {!status?.storeUrl && <p className="plugin-setting-note">{language === 'zh' ? '开发版本：扩展目录已随 CardBush 提供。按钮会复制目录路径并打开文件夹，请在 chrome://extensions 的“加载已解压的扩展程序”中选择它。正式发布可配置 Chrome Web Store 地址。' : 'Development build: the extension ships with CardBush. The button copies and reveals its directory; select it with “Load unpacked” at chrome://extensions. Production builds can configure a Chrome Web Store URL.'}</p>}
          {status?.setupMessage && <p className="plugin-setting-note">{status.setupMessage}</p>}
          {status?.lastError && <p className="plugin-hub-error">{status.lastError}</p>}
          {error && <p className="plugin-hub-error">{error}</p>}
        </div>
      ) : (
        <p className="plugin-setting-note">
          {language === 'zh'
            ? '在 Chrome 144+ 的 chrome://inspect/#remote-debugging 中主动开启远程调试。此兼容路径仍依赖 DevToolsActivePort，仅在扩展连接器不可用时使用。'
            : 'Explicitly enable remote debugging at chrome://inspect/#remote-debugging in Chrome 144+. This compatibility path still relies on DevToolsActivePort and is only for cases where the extension connector cannot be used.'}
        </p>
      )}
    </section>
  );
}

function SkillDetailPage({ language, skill, loading, error, enabled, onBack, onToggle }: { language: AppLanguage; skill: SkillSummary | SkillDetail | null; loading: boolean; error: string; enabled: boolean; onBack: () => void; onToggle: (enabled: boolean) => void }) {
  return <div className="plugin-detail-page"><button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{language === 'zh' ? '返回技能' : 'Back to skills'}</button>{loading ? <div className="plugin-detail-loading"><LoaderCircle className="spin" />{language === 'zh' ? '正在加载技能' : 'Loading skill'}</div> : skill ? <><header className="plugin-detail-hero"><SkillIcon skill={skill} /><div><h2>{skill.name}</h2><p>{language === 'zh' ? skill.descriptionZh ?? skill.description : skill.description}</p></div><button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" onClick={() => onToggle(!enabled)}><span /></button></header><section className="plugin-detail-section plugin-info"><h3>{language === 'zh' ? '信息' : 'Information'}</h3>{'version' in skill && <Info label={language === 'zh' ? '版本' : 'Version'} value={skill.version || '—'} />}<Info label={language === 'zh' ? '来源' : 'Source'} value={skillSourceText(language, skill) || '—'} /><Info label={language === 'zh' ? '位置' : 'Location'} value={skill.path} /></section>{'content' in skill && <section className="plugin-detail-section"><h3>SKILL.md</h3><pre className="plugin-skill-source">{skill.content}</pre></section>}</> : <p className="plugin-hub-error">{error}</p>}</div>;
}

function skillSourceText(language: AppLanguage, skill: SkillSummary): string {
  if (skill.source === 'plugin') {
    const plugin = skill.sourceLabel || skill.sourceId || (language === 'zh' ? '插件' : 'Plugin');
    return language === 'zh' ? `来自 ${plugin}` : `From ${plugin}`;
  }
  if (skill.source === 'bundled') return language === 'zh' ? '内置' : 'Built in';
  if (skill.source === 'user') return language === 'zh' ? '用户' : 'User';
  if (skill.source === 'external') return language === 'zh' ? '外部' : 'External';
  return '';
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
