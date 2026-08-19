import {
  CheckCircle2,
  Circle,
  Code2,
  Edit3,
  LoaderCircle,
  PackagePlus,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type {
  AppLanguage,
  AppSection,
  ConversationSummary,
  SkillDetail,
  SkillSummary,
} from '../../types';
import {
  fetchRuntimeToolInventory,
  manageRuntimeTool,
  type RuntimeToolInventory,
  type RuntimeToolInventoryEntry,
} from '../../backend/api';

const LazyTeamPanel = lazy(async () => {
  const module = await import('../TeamPanel');
  return { default: module.TeamPanel };
});

export function FeatureContentPanel({
  language,
  section,
  activeProjectDir,
  workflowValidationAvailable,
  conversations,
  skills,
  disabledSkillNames,
  disabledToolNames,
  onToggleSkill,
  onToggleTool,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  section: AppSection;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  conversations: ConversationSummary[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  disabledToolNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onToggleTool: (toolName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  if (section === 'search') {
    return (
      <SearchPanel
        language={language}
        conversations={conversations}
        onCreateConversation={onCreateConversation}
        onOpenConversation={onOpenConversation}
      />
    );
  }
  if (section === 'skills') {
    return (
      <SkillsPanel
        language={language}
        items={skills}
        disabledSkillNames={disabledSkillNames}
        onToggleSkill={onToggleSkill}
        onReload={onReloadSkills}
        onLoadDetail={onLoadSkillDetail}
      />
    );
  }
  if (section === 'tools') {
    return (
      <ToolsPanel
        language={language}
        disabledToolNames={disabledToolNames}
        onToggleTool={onToggleTool}
      />
    );
  }
  if (section === 'subagents') {
    return null;
  }
  if (section === 'team') {
    return (
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyTeamPanel
          language={language}
          activeProjectDir={activeProjectDir}
          workflowValidationAvailable={workflowValidationAvailable}
        />
      </Suspense>
    );
  }
  return null;
}

function ToolsPanel({
  language,
  disabledToolNames,
  onToggleTool,
}: {
  language: AppLanguage;
  disabledToolNames: Set<string>;
  onToggleTool: (toolName: string, enabled: boolean) => void;
}) {
  const [inventory, setInventory] = useState<RuntimeToolInventory | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'enabled' | 'disabled' | 'core'>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<RuntimeToolInventoryEntry | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [busyNames, setBusyNames] = useState<Set<string>>(() => new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setInventory(await fetchRuntimeToolInventory());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    for (const tool of inventory?.installed ?? []) {
      if (tool.injection.core && disabledToolNames.has(tool.name)) {
        onToggleTool(tool.name, true);
      }
    }
  }, [disabledToolNames, inventory, onToggleTool]);

  const normalizedQuery = query.trim().toLowerCase();
  const tools = useMemo(() => (inventory?.installed ?? [])
    .filter((tool) => {
      const enabled = tool.injection.core || !disabledToolNames.has(tool.name);
      if (scope === 'enabled' && !enabled) return false;
      if (scope === 'disabled' && enabled) return false;
      if (scope === 'core' && !tool.injection.core) return false;
      return !normalizedQuery || `${tool.name} ${tool.package} ${tool.description} ${tool.category}`
        .toLowerCase()
        .includes(normalizedQuery);
    })
    .sort((left, right) => Number(right.injection.core) - Number(left.injection.core)
      || left.name.localeCompare(right.name)), [disabledToolNames, inventory, normalizedQuery, scope]);

  const manageableTools = (inventory?.installed ?? []).filter((tool) => !tool.injection.core);
  const isToolEnabled = (tool: RuntimeToolInventoryEntry) => tool.injection.core
    || (tool.enabled && !disabledToolNames.has(tool.name));
  const disabledCount = manageableTools.filter((tool) => !isToolEnabled(tool)).length;
  const runManagement = useCallback(async (
    key: string,
    request: Parameters<typeof manageRuntimeTool>[0],
  ) => {
    setBusyNames((current) => new Set(current).add(key));
    setError('');
    try {
      const result = await manageRuntimeTool(request);
      await reload();
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setBusyNames((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [reload]);
  const setToolEnabled = async (tool: RuntimeToolInventoryEntry, enabled: boolean) => {
    if (tool.injection.core) return;
    await runManagement(tool.name, { action: enabled ? 'enable' : 'disable', toolName: tool.name });
    onToggleTool(tool.name, enabled);
  };
  const setAllManageable = async (enabled: boolean) => {
    for (const tool of manageableTools) {
      if (isToolEnabled(tool) !== enabled) {
        await setToolEnabled(tool, enabled);
      }
    }
  };

  return (
    <div className="feature-content tools-manager">
      <div className="feature-toolbar tools-manager-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={language === 'zh' ? '搜索工具、工具包或分类' : 'Search tools, packages, or categories'} />
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新' : 'Refresh'}
        </button>
        <button className="primary-button" type="button" onClick={() => setInstallOpen(true)}><Plus size={14} />{language === 'zh' ? '添加工具' : 'Add tool'}</button>
      </div>
      <div className="tool-manager-summary">
        <div><strong>{inventory?.installed.length ?? 0}</strong><span>{language === 'zh' ? '已安装' : 'Installed'}</span></div>
        <div><strong>{inventory?.installed.filter((tool) => tool.injection.core).length ?? 0}</strong><span>{language === 'zh' ? '核心工具' : 'Core tools'}</span></div>
        <div><strong>{manageableTools.length - disabledCount}</strong><span>{language === 'zh' ? '已启用' : 'Enabled'}</span></div>
        <div><strong>{disabledCount}</strong><span>{language === 'zh' ? '已禁用' : 'Disabled'}</span></div>
      </div>
      <div className="tool-manager-actions">
        <div className="tool-filter-tabs">
          {(['all', 'enabled', 'disabled', 'core'] as const).map((value) => (
            <button className={scope === value ? 'active' : ''} type="button" key={value} onClick={() => setScope(value)}>
              {{ all: language === 'zh' ? '全部' : 'All', enabled: language === 'zh' ? '已启用' : 'Enabled', disabled: language === 'zh' ? '已禁用' : 'Disabled', core: language === 'zh' ? '核心' : 'Core' }[value]}
            </button>
          ))}
        </div>
        <div className="tool-bulk-actions">
          <button type="button" disabled={manageableTools.length === 0 || disabledCount === 0 || busyNames.size > 0} onClick={() => void setAllManageable(true).catch(() => undefined)}>{language === 'zh' ? '全部启用' : 'Enable all'}</button>
          <button type="button" disabled={manageableTools.length === 0 || disabledCount === manageableTools.length || busyNames.size > 0} onClick={() => void setAllManageable(false).catch(() => undefined)}>{language === 'zh' ? '禁用非核心' : 'Disable non-core'}</button>
        </div>
      </div>
      <p className="feature-hint tool-manager-hint">{language === 'zh' ? '工具策略独立于运行环境。核心工具受系统保护，始终启用且不可管理。' : 'Tool policy is separate from runtime settings. Core tools are protected, always enabled, and read-only.'}</p>
      {error && <p className="feature-error">{error}</p>}
      {!loading && !error && tools.length === 0 && <div className="tool-manager-empty">{language === 'zh' ? '没有符合条件的工具' : 'No matching tools'}</div>}
      <div className="tool-manager-grid">
        {tools.map((tool) => {
          const core = tool.injection.core;
          const enabled = isToolEnabled(tool);
          const busy = busyNames.has(tool.name);
          return (
            <article className={`tool-manager-card${enabled ? '' : ' disabled'}${core ? ' core' : ''}`} key={tool.name}>
              <button className="tool-manager-card-main" type="button" onClick={() => setDetail(tool)}>
                <span className="tool-manager-icon">{core ? <ShieldCheck size={18} /> : <Wrench size={18} />}</span>
                <span className="tool-manager-copy"><strong>{tool.name}</strong><small>{tool.description || (language === 'zh' ? '暂无描述' : 'No description')}</small><code>{tool.package || tool.category || 'runtime'}</code></span>
              </button>
              {core ? (
                <span className="tool-core-lock"><ShieldCheck size={13} />{language === 'zh' ? '核心保护' : 'Protected'}</span>
              ) : (
                <button className={`skill-toggle ${enabled ? 'on' : ''}`} type="button" disabled={busy} aria-pressed={enabled} onClick={() => void setToolEnabled(tool, !enabled).catch(() => undefined)}>
                  {busy ? <LoaderCircle className="spin" size={14} /> : enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}{enabled ? (language === 'zh' ? '已启用' : 'Enabled') : (language === 'zh' ? '已禁用' : 'Disabled')}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {detail && <ToolDetailDialog language={language} tool={detail} enabled={isToolEnabled(detail)} busy={busyNames.has(detail.name)} onManage={async (request) => { await runManagement(detail.name, request); setDetail(null); }} onClose={() => setDetail(null)} />}
      {installOpen && <ToolInstallDialog language={language} busy={busyNames.has('install')} onInstall={async (request) => { await runManagement('install', request); setInstallOpen(false); }} onClose={() => setInstallOpen(false)} />}
    </div>
  );
}

function ToolDetailDialog({ language, tool, enabled, busy, onManage, onClose }: { language: AppLanguage; tool: RuntimeToolInventoryEntry; enabled: boolean; busy: boolean; onManage: (request: Parameters<typeof manageRuntimeTool>[0]) => Promise<void>; onClose: () => void }) {
  const [sourcePath, setSourcePath] = useState('');
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="skill-detail-dialog tool-detail-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>{tool.injection.core ? <ShieldCheck size={18} /> : <Wrench size={18} />}<strong>{tool.name}</strong><button type="button" onClick={onClose}><X size={16} /></button></header>
        <p>{tool.description || (language === 'zh' ? '暂无描述' : 'No description')}</p>
        <div className="skill-meta">
          <span>{enabled ? (language === 'zh' ? '已启用' : 'enabled') : (language === 'zh' ? '已禁用' : 'disabled')}</span>
          {tool.injection.core && <span>{language === 'zh' ? '核心保护' : 'protected core'}</span>}
          {tool.runtimeLoaded && <span>runtime loaded</span>}
          {tool.schemaAvailable && <span>input schema</span>}
        </div>
        <InfoRow label="package" value={tool.package || '-'} />
        <InfoRow label="category" value={tool.category || '-'} />
        <pre className="skill-content">{JSON.stringify({ input_schema: tool.inputSchema ?? {}, dispatch: tool.dispatch ?? {} }, null, 2)}</pre>
        {!tool.injection.core && (
          <footer className="tool-detail-actions">
            <input value={sourcePath} onChange={(event) => setSourcePath(event.currentTarget.value)} placeholder={language === 'zh' ? '更新包目录（可选）' : 'Update package directory (optional)'} />
            {sourcePath.trim() && <button className="secondary-button" type="button" disabled={busy} onClick={() => void onManage({ action: 'update', toolName: tool.name, sourcePath: sourcePath.trim() }).catch(() => undefined)}>{language === 'zh' ? '更新' : 'Update'}</button>}
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void onManage({ action: 'update_injection', toolName: tool.name, default: !tool.injection.default }).catch(() => undefined)}>{tool.injection.default ? (language === 'zh' ? '改为按需发现' : 'Make discoverable') : (language === 'zh' ? '设为默认可见' : 'Make default')}</button>
            <button className="danger-button" type="button" disabled={busy} onClick={() => void onManage({ action: 'uninstall', toolName: tool.name }).catch(() => undefined)}><Trash2 size={13} />{language === 'zh' ? '卸载' : 'Uninstall'}</button>
          </footer>
        )}
      </section>
    </div>
  );
}

function ToolInstallDialog({ language, busy, onInstall, onClose }: { language: AppLanguage; busy: boolean; onInstall: (request: Parameters<typeof manageRuntimeTool>[0]) => Promise<void>; onClose: () => void }) {
  const [action, setAction] = useState<'install' | 'install_from_seed' | 'register'>('install');
  const [value, setValue] = useState('');
  const [replace, setReplace] = useState(false);
  const actionOptions = [
    { value: 'install', label: language === 'zh' ? '本地工具包' : 'Local package' },
    { value: 'install_from_seed', label: language === 'zh' ? '内置种子' : 'Bundled seed' },
    { value: 'register', label: language === 'zh' ? '已有工具包' : 'Existing package' },
  ] as const;
  const needsPath = action === 'install';
  const ready = value.trim().length > 0;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="skill-detail-dialog tool-install-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><PackagePlus size={18} /><strong>{language === 'zh' ? '添加工具' : 'Add tool'}</strong><button type="button" onClick={onClose}><X size={16} /></button></header>
        <p>{language === 'zh' ? '安装本地工具包、从内置种子安装，或注册已经存在的工具包。声明为核心的工具包会被后端拒绝。' : 'Install a local package, install from bundled seeds, or register an existing package. Packages declaring themselves as core are rejected by the backend.'}</p>
        <div className="tool-install-form">
          <div className="tool-install-action-field">
            <span>{language === 'zh' ? '操作' : 'Action'}</span>
            <div className="tool-install-action-options" role="radiogroup" aria-label={language === 'zh' ? '工具安装方式' : 'Tool installation method'}>
              {actionOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={action === option.value}
                  className={action === option.value ? 'active' : ''}
                  onClick={() => setAction(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label><span>{needsPath ? (language === 'zh' ? '工具包目录或 tool.json 路径' : 'Package directory or tool.json path') : (language === 'zh' ? '工具名称' : 'Tool name')}</span><input value={value} onChange={(event) => setValue(event.currentTarget.value)} placeholder={needsPath ? 'C:\\path\\to\\tool-package' : 'tool_name'} /></label>
          {action !== 'register' && <label className="tool-install-check"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.currentTarget.checked)} /><span>{language === 'zh' ? '替换同名工具包' : 'Replace package with the same name'}</span></label>}
        </div>
        <footer className="tool-install-footer"><button className="secondary-button" type="button" onClick={onClose}>{language === 'zh' ? '取消' : 'Cancel'}</button><button className="primary-button" type="button" disabled={!ready || busy} onClick={() => void onInstall({ action, ...(needsPath ? { sourcePath: value.trim() } : { toolName: value.trim() }), replace }).catch(() => undefined)}>{busy ? <LoaderCircle className="spin" size={14} /> : <PackagePlus size={14} />}{language === 'zh' ? '执行' : 'Apply'}</button></footer>
      </section>
    </div>
  );
}

function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{language === 'zh' ? '正在加载...' : 'Loading...'}</span>
    </div>
  );
}

function SearchPanel({
  language,
  conversations,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  conversations: ConversationSummary[];
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      conversations.filter((conversation) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${conversation.title} ${conversation.preview}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [conversations, normalizedQuery],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={language === 'zh' ? '搜索标题或摘要' : 'Search titles or summaries'}
          />
        </div>
        <button className="primary-button" type="button" onClick={onCreateConversation}>
          <Edit3 size={16} />
          {language === 'zh' ? '新会话' : 'New chat'}
        </button>
      </div>
      <div className="result-stack">
        {results.map((conversation) => (
          <button
            className="result-card result-card-button"
            key={conversation.id}
            type="button"
            onClick={() => onOpenConversation(conversation.id)}
          >
            <h3>{conversation.title}</h3>
            <p>{conversation.preview}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

function SkillsPanel({
  language,
  items,
  disabledSkillNames,
  onToggleSkill,
  onReload,
  onLoadDetail,
}: {
  language: AppLanguage;
  items: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReload: () => Promise<SkillSummary[]>;
  onLoadDetail: (skillName: string) => Promise<SkillDetail>;
}) {
  const [query, setQuery] = useState('');
  const [localItems, setLocalItems] = useState(items);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      localItems
        .filter((skill) => {
          if (!normalizedQuery) {
            return true;
          }
          return `${skill.name} ${skill.description} ${skill.descriptionZh ?? ''} ${skill.path}`
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    [localItems, normalizedQuery],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loaded = await onReload();
      setLocalItems(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [onReload]);

  const openDetail = useCallback(
    async (skill: SkillSummary) => {
      setDetail(null);
      setDetailError('');
      setDetailLoading(true);
      try {
        const loaded = await onLoadDetail(skill.name);
        setDetail(loaded);
      } catch (caught) {
        setDetailError(caught instanceof Error ? caught.message : String(caught));
        setDetail({
          ...skill,
          packageDir: '',
          content: '',
          routingHidden: false,
          requires: [],
          conflictsWith: [],
          companionTools: [],
          blockedTools: [],
          requiredReads: [],
          conditionalReads: [],
          resourceQuickRefs: [],
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [onLoadDetail],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={language === 'zh' ? '搜索技能' : 'Search skills'}
          />
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新' : 'Refresh'}
        </button>
      </div>
      <p className="feature-hint">
        {loading
          ? language === 'zh'
            ? '正在从 BushServer 加载 skills...'
            : 'Loading skills from BushServer...'
          : language === 'zh'
            ? `共 ${localItems.length} 个 skills，点击详情查看 SKILL.md。`
            : `${localItems.length} skills. Open details to view SKILL.md.`}
      </p>
      {error && <p className="feature-error">{error}</p>}
      <div className="result-stack">
        {results.map((skill) => {
          const enabled = !disabledSkillNames.has(skill.name);
          return (
            <article
              className={`result-card skill skill-tile ${enabled ? '' : 'disabled'}`}
              key={skill.name}
            >
              <button
                className="skill-tile-main"
                type="button"
                onClick={() => void openDetail(skill)}
              >
                <Code2 size={18} />
                <div>
                  <h3>{skill.name}</h3>
                  <p>{language === 'zh' ? skill.descriptionZh : skill.description}</p>
                  <small>{skill.path}</small>
                </div>
                <span className="skill-detail-label">
                  {language === 'zh' ? '详情' : 'Details'}
                </span>
              </button>
              <button
                className={`skill-toggle ${enabled ? 'on' : ''}`}
                type="button"
                onClick={() => onToggleSkill(skill.name, !enabled)}
              >
                {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                {enabled
                  ? language === 'zh'
                    ? '已启用'
                    : 'Enabled'
                  : language === 'zh'
                    ? '已关闭'
                    : 'Disabled'}
              </button>
            </article>
          );
        })}
      </div>
      {detail && (
        <SkillDetailDialog
          language={language}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => {
            setDetail(null);
            setDetailError('');
          }}
        />
      )}
    </div>
  );
}

function SkillDetailDialog({
  language,
  detail,
  loading,
  error,
  onClose,
}: {
  language: AppLanguage;
  detail: SkillDetail;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="skill-detail-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <Puzzle size={18} />
          <strong>{detail.name}</strong>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {loading ? (
          <div className="skill-detail-loading">
            <LoaderCircle size={22} />
            {language === 'zh' ? '正在加载 Skill 详情...' : 'Loading skill detail...'}
          </div>
        ) : (
          <>
            <p>{(language === 'zh' ? detail.descriptionZh : detail.description) || detail.description || (language === 'zh' ? '暂无描述' : 'No description')}</p>
            <div className="skill-meta">
              {detail.version && <span>v{detail.version}</span>}
              {detail.routingHidden && <span>{language === 'zh' ? '隐藏路由' : 'hidden routing'}</span>}
              {detail.minServerVersion && <span>server &gt;= {detail.minServerVersion}</span>}
              {detail.requires.map((item) => (
                <span key={`requires-${item}`}>requires {item}</span>
              ))}
            </div>
            {detail.packageDir && <InfoRow label="package_dir" value={detail.packageDir} />}
            {detail.path && <InfoRow label="SKILL.md" value={detail.path} />}
            {error ? (
              <p className="feature-error">{error}</p>
            ) : (
              <pre className="skill-content">{detail.content || (language === 'zh' ? 'Skill 详情为空' : 'Skill detail is empty')}</pre>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}






