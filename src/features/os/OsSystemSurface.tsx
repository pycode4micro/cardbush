import {
  ArrowLeft,
  Check,
  Download,
  File,
  Folder,
  FolderPlus,
  LoaderCircle,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AppLanguage } from '../../types';

export type OsSystemSurfaceMode = 'apps' | 'files' | 'tasks';

type OsLocation = { id: string; name: string; path: string };
type OsFileItem = {
  id: string;
  name: string;
  path: string;
  kind: 'file' | 'directory';
  extension: string;
  size: number;
  modifiedAt: string;
  hidden: boolean;
};
type OsDirectory = {
  path: string;
  parentPath: string;
  truncated: boolean;
  items: OsFileItem[];
};
type OsWindow = {
  id: string;
  processId: number;
  handle: number;
  title: string;
  processName: string;
  minimized: boolean;
  maximized: boolean;
  icon: string;
};
export type OsApplication = {
  id: string;
  name: string;
  path: string;
  source: 'start_menu';
  icon: string;
};

export function OsSystemSurface({
  mode,
  language,
  onClose,
  onApplicationLaunched,
  pinnedApplicationIds,
  onToggleApplicationPinned,
  onAskAgent,
}: {
  mode: OsSystemSurfaceMode;
  language: AppLanguage;
  onClose: () => void;
  onApplicationLaunched?: (application: OsApplication) => void;
  pinnedApplicationIds?: ReadonlySet<string>;
  onToggleApplicationPinned?: (application: OsApplication) => void;
  onAskAgent?: (prompt: string) => void;
}) {
  return (
    <section className="os-system-surface" aria-label={mode === 'apps' ? 'Applications' : mode === 'tasks' ? 'Tasks' : 'Files'}>
      {mode === 'apps' ? (
        <OsApplications
          language={language}
          onClose={onClose}
          onApplicationLaunched={onApplicationLaunched}
          pinnedApplicationIds={pinnedApplicationIds}
          onToggleApplicationPinned={onToggleApplicationPinned}
          onAskAgent={onAskAgent}
        />
      ) : mode === 'tasks' ? (
        <OsTasks language={language} onClose={onClose} />
      ) : (
        <OsFiles language={language} onClose={onClose} />
      )}
    </section>
  );
}

function OsTasks({ language, onClose }: { language: AppLanguage; onClose: () => void }) {
  const [taskWindows, setTaskWindows] = useState<OsWindow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeAction, setActiveAction] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTaskWindows((await window.cardbushDesktop?.osListWindows?.()) ?? []);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const act = async (
    item: OsWindow,
    action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'close',
  ) => {
    if (action === 'close' && !window.confirm(
      language === 'zh'
        ? `关闭“${item.title}”？未保存的内容可能丢失。`
        : `Close “${item.title}”? Unsaved work may be lost.`,
    )) return;
    setActiveAction(`${item.id}:${action}`);
    setError('');
    try {
      await window.cardbushDesktop?.osWindowAction?.(item.id, action);
      if (action === 'focus' || action === 'restore') onClose();
      else window.setTimeout(() => void load(), 240);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setActiveAction('');
    }
  };

  return (
    <>
      <SurfaceHeader
        title={language === 'zh' ? '任务' : 'Tasks'}
        subtitle={language === 'zh' ? `${taskWindows.length} 个窗口正在运行` : `${taskWindows.length} windows running`}
        loading={loading}
        onRefresh={() => void load()}
        onClose={onClose}
      />
      {error && <div className="os-system-error">{error}</div>}
      <div className="os-task-grid">
        {taskWindows.map((item) => (
          <article className="os-task-item" key={item.id}>
            <button
              className="os-task-main"
              type="button"
              data-os-control="true"
              onClick={() => void act(item, 'focus')}
            >
              <span className="os-task-icon">
                {item.icon ? <img src={item.icon} alt="" /> : <b>{appInitial(item.processName)}</b>}
              </span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.processName}{item.minimized ? ` · ${language === 'zh' ? '已最小化' : 'Minimized'}` : ''}</small>
              </span>
              <MousePointer2 size={13} />
            </button>
            <div className="os-task-controls">
              <button type="button" data-os-control="true" title={language === 'zh' ? '最小化' : 'Minimize'} onClick={() => void act(item, 'minimize')}>
                <Minus size={14} />
              </button>
              <button type="button" data-os-control="true" title={item.maximized ? (language === 'zh' ? '还原' : 'Restore') : (language === 'zh' ? '最大化' : 'Maximize')} onClick={() => void act(item, item.maximized ? 'restore' : 'maximize')}>
                <Maximize2 size={13} />
              </button>
              <button className="danger" type="button" data-os-control="true" title={language === 'zh' ? '关闭' : 'Close'} onClick={() => void act(item, 'close')}>
                {activeAction === `${item.id}:close` ? <LoaderCircle className="spin" size={13} /> : <X size={14} />}
              </button>
            </div>
          </article>
        ))}
      </div>
      {!loading && taskWindows.length === 0 && (
        <div className="os-system-empty">{language === 'zh' ? '没有其他活动窗口' : 'No other active windows'}</div>
      )}
    </>
  );
}

function SurfaceHeader({
  title,
  subtitle,
  loading,
  onRefresh,
  onClose,
}: {
  title: string;
  subtitle: string;
  loading: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <header className="os-system-header">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="os-system-header-actions">
        <button type="button" data-os-control="true" onClick={onRefresh} title="Refresh">
          {loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
        </button>
        <button type="button" data-os-control="true" onClick={onClose} title="Close">
          <X size={17} />
        </button>
      </div>
    </header>
  );
}

function OsApplications({
  language,
  onClose,
  onApplicationLaunched,
  pinnedApplicationIds,
  onToggleApplicationPinned,
  onAskAgent,
}: {
  language: AppLanguage;
  onClose: () => void;
  onApplicationLaunched?: (application: OsApplication) => void;
  pinnedApplicationIds?: ReadonlySet<string>;
  onToggleApplicationPinned?: (application: OsApplication) => void;
  onAskAgent?: (prompt: string) => void;
}) {
  const [apps, setApps] = useState<OsApplication[]>([]);
  const [view, setView] = useState<'installed' | 'discover'>('installed');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [launching, setLaunching] = useState('');
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<Array<{ name: string; id: string; version: string; source: string }>>([]);
  const [catalogSearching, setCatalogSearching] = useState(false);
  const [installing, setInstalling] = useState('');

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    try {
      setApps((await window.cardbushDesktop?.osListApplications?.(forceRefresh)) ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? apps.filter((item) => item.name.toLocaleLowerCase().includes(needle)) : apps;
  }, [apps, query]);

  const launch = async (item: OsApplication) => {
    setLaunching(item.id);
    setError('');
    try {
      await window.cardbushDesktop?.osLaunchApplication?.(item.id);
      onApplicationLaunched?.(item);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLaunching('');
    }
  };

  const searchCatalog = async () => {
    const needle = query.trim();
    if (needle.length < 2) return;
    setCatalogSearching(true);
    setError('');
    try {
      setCatalog((await window.cardbushDesktop?.osSearchAppCatalog?.(needle)) ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCatalogSearching(false);
    }
  };

  const install = async (item: { name: string; id: string }) => {
    const confirmed = window.confirm(
      language === 'zh'
        ? `从 Windows 应用目录安装“${item.name}”？\n\n包：${item.id}`
        : `Install “${item.name}” from the Windows app catalog?\n\nPackage: ${item.id}`,
    );
    if (!confirmed) return;
    setInstalling(item.id);
    setError('');
    try {
      await window.cardbushDesktop?.osInstallCatalogApplication?.(item.id);
      await load();
      setView('installed');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstalling('');
    }
  };

  return (
    <>
      <SurfaceHeader
        title={language === 'zh' ? '应用' : 'Applications'}
        subtitle={loading && apps.length === 0
          ? (language === 'zh' ? '正在整理 Windows 应用…' : 'Preparing Windows applications…')
          : (language === 'zh' ? `${apps.length} 个 Windows 应用` : `${apps.length} Windows applications`)}
        loading={loading}
        onRefresh={() => void load(true)}
        onClose={onClose}
      />
      <div className="os-system-search">
        <Search size={16} />
        <input
          value={query}
          data-os-control="true"
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && view === 'discover') void searchCatalog();
          }}
          placeholder={view === 'installed'
            ? (language === 'zh' ? '搜索已安装应用' : 'Search installed applications')
            : (language === 'zh' ? '搜索 Windows 应用目录' : 'Search the Windows app catalog')}
        />
        {view === 'discover' && (
          <button type="button" data-os-control="true" onClick={() => void searchCatalog()}>
            {catalogSearching ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />}
          </button>
        )}
      </div>
      <div className="os-app-view-switch" role="tablist">
        <button type="button" role="tab" data-os-control="true" aria-selected={view === 'installed'} onClick={() => setView('installed')}>
          {language === 'zh' ? '已安装' : 'Installed'}
        </button>
        <button type="button" role="tab" data-os-control="true" aria-selected={view === 'discover'} onClick={() => setView('discover')}>
          <Download size={13} />
          {language === 'zh' ? '发现应用' : 'Discover'}
        </button>
        {view === 'discover' && onAskAgent && (
          <button
            className="ask-agent"
            type="button"
            data-os-control="true"
            onClick={() => onAskAgent(language === 'zh'
              ? `帮我查找并比较适合“${query.trim() || '我的需求'}”的 Windows 应用，说明可信来源、安装方式和风险，等我确认后再安装。`
              : `Find and compare trustworthy Windows apps for “${query.trim() || 'my needs'}”. Explain sources, installation, and risks, then wait for my confirmation.`)}
          >
            <Sparkles size={13} />
            {language === 'zh' ? '询问 Agent' : 'Ask Agent'}
          </button>
        )}
      </div>
      {error && <div className="os-system-error">{error}</div>}
      {view === 'installed' && loading && apps.length === 0 && (
        <div className="os-app-loading" aria-label={language === 'zh' ? '正在加载应用' : 'Loading applications'}>
          {Array.from({ length: 5 }, (_, index) => <span key={index} />)}
        </div>
      )}
      {view === 'installed' ? <div className="os-app-grid">
        {filtered.map((item) => (
          <div className="os-app-item" key={item.id}>
            <button
              className="os-app-launch"
              type="button"
              data-os-control="true"
              title={item.name}
              onClick={() => void launch(item)}
            >
              <span className="os-app-icon">
                {item.icon ? <img src={item.icon} alt="" /> : <b>{appInitial(item.name)}</b>}
              </span>
              <span>{item.name}</span>
              {launching === item.id ? <LoaderCircle className="spin" size={13} /> : <Play size={12} />}
            </button>
            {onToggleApplicationPinned && (
              <button
                className={`os-app-pin${pinnedApplicationIds?.has(item.id) ? ' active' : ''}`}
                type="button"
                data-os-control="true"
                aria-label={pinnedApplicationIds?.has(item.id)
                  ? language === 'zh' ? `取消固定 ${item.name}` : `Unpin ${item.name}`
                  : language === 'zh' ? `固定 ${item.name}` : `Pin ${item.name}`}
                title={pinnedApplicationIds?.has(item.id)
                  ? language === 'zh' ? '取消固定' : 'Unpin'
                  : language === 'zh' ? '固定到任务栏' : 'Pin to taskbar'}
                onClick={() => onToggleApplicationPinned(item)}
              >
                {pinnedApplicationIds?.has(item.id) ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            )}
          </div>
        ))}
      </div> : <div className="os-catalog-list">
        {catalog.map((item) => (
          <div className="os-catalog-item" key={item.id}>
            <span className="os-app-icon"><b>{appInitial(item.name)}</b></span>
            <span><strong>{item.name}</strong><small>{item.id} · {item.version}</small></span>
            <button type="button" data-os-control="true" disabled={Boolean(installing)} onClick={() => void install(item)}>
              {installing === item.id ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
              {language === 'zh' ? '安装' : 'Install'}
            </button>
          </div>
        ))}
      </div>}
      {view === 'installed' && !loading && filtered.length === 0 && (
        <div className="os-system-empty">{language === 'zh' ? '没有找到应用' : 'No applications found'}</div>
      )}
      {view === 'discover' && !catalogSearching && catalog.length === 0 && (
        <div className="os-system-empty">
          {language === 'zh' ? '输入应用名称搜索，或让 Agent 先帮你比较方案。' : 'Search by app name, or ask the Agent to compare options first.'}
        </div>
      )}
    </>
  );
}

function OsFiles({ language, onClose }: { language: AppLanguage; onClose: () => void }) {
  const [locations, setLocations] = useState<OsLocation[]>([]);
  const [directory, setDirectory] = useState<OsDirectory | null>(null);
  const [selected, setSelected] = useState<OsFileItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<'create' | 'rename' | null>(null);
  const [editorValue, setEditorValue] = useState('');
  const [fileQuery, setFileQuery] = useState('');

  const visibleItems = useMemo(() => {
    const needle = fileQuery.trim().toLocaleLowerCase();
    if (!needle) return directory?.items ?? [];
    return (directory?.items ?? []).filter((item) =>
      item.name.toLocaleLowerCase().includes(needle));
  }, [directory?.items, fileQuery]);

  const loadDirectory = useCallback(async (targetPath?: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await window.cardbushDesktop?.osListDirectory?.(targetPath);
      if (result) {
        setDirectory(result);
        setSelected(null);
        setFileQuery('');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void window.cardbushDesktop
      ?.osFilesystemLocations?.()
      .then((items) => {
        setLocations(items);
        const desktop = items.find((item) => item.id === 'desktop') ?? items[0];
        return loadDirectory(desktop?.path);
      })
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        setLoading(false);
      });
  }, [loadDirectory]);

  const openItem = async (item: OsFileItem) => {
    if (item.kind === 'directory') {
      await loadDirectory(item.path);
      return;
    }
    const result = await window.cardbushDesktop?.openPath?.(item.path);
    if (result) {
      setError(result);
    }
  };

  const commitEditor = async () => {
    const value = editorValue.trim();
    if (!directory || !value || !editor) {
      return;
    }
    setError('');
    try {
      if (editor === 'create') {
        await window.cardbushDesktop?.osCreateDirectory?.(directory.path, value);
      } else if (selected) {
        await window.cardbushDesktop?.osRenamePath?.(selected.path, value);
      }
      setEditor(null);
      setEditorValue('');
      await loadDirectory(directory.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const trashSelected = async () => {
    if (!selected || !directory) {
      return;
    }
    const confirmed = window.confirm(
      language === 'zh' ? `将“${selected.name}”移到回收站？` : `Move “${selected.name}” to the recycle bin?`,
    );
    if (!confirmed) {
      return;
    }
    try {
      await window.cardbushDesktop?.osTrashPath?.(selected.path);
      await loadDirectory(directory.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <>
      <SurfaceHeader
        title={language === 'zh' ? 'AI 空间' : 'AI Space'}
        subtitle={language === 'zh' ? '连接到 Windows 文件系统' : 'Connected to the Windows file system'}
        loading={loading}
        onRefresh={() => void loadDirectory(directory?.path)}
        onClose={onClose}
      />
      <div className="os-files-layout">
        <nav className="os-location-list" aria-label="Locations">
          {locations.map((location) => (
            <button
              type="button"
              key={location.id}
              data-os-control="true"
              className={directory?.path === location.path ? 'active' : ''}
              onClick={() => void loadDirectory(location.path)}
            >
              <Folder size={15} />
              <span>{localizedLocationName(location.id, location.name, language)}</span>
            </button>
          ))}
        </nav>
        <div className="os-file-browser">
          <div className="os-file-toolbar">
            <button
              type="button"
              data-os-control="true"
              disabled={!directory?.parentPath}
              onClick={() => void loadDirectory(directory?.parentPath)}
              title={language === 'zh' ? '上一级' : 'Up'}
            >
              <ArrowLeft size={15} />
            </button>
            <code title={directory?.path}>{directory?.path}</code>
            <label className="os-file-search">
              <Search size={14} />
              <input
                value={fileQuery}
                data-os-control="true"
                onChange={(event) => setFileQuery(event.currentTarget.value)}
                placeholder={language === 'zh' ? '筛选' : 'Filter'}
                aria-label={language === 'zh' ? '筛选当前目录' : 'Filter current folder'}
              />
              {fileQuery && <small>{visibleItems.length}</small>}
            </label>
            <button
              type="button"
              data-os-control="true"
              onClick={() => {
                setEditor('create');
                setEditorValue('');
              }}
              title={language === 'zh' ? '新建文件夹' : 'New folder'}
            >
              <FolderPlus size={15} />
            </button>
            <button
              type="button"
              data-os-control="true"
              disabled={!selected}
              onClick={() => {
                if (selected) {
                  setEditor('rename');
                  setEditorValue(selected.name);
                }
              }}
              title={language === 'zh' ? '重命名' : 'Rename'}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              data-os-control="true"
              disabled={!selected}
              onClick={() => void trashSelected()}
              title={language === 'zh' ? '移到回收站' : 'Move to recycle bin'}
            >
              <Trash2 size={14} />
            </button>
          </div>
          {editor && (
            <div className="os-file-editor">
              <input
                autoFocus
                value={editorValue}
                onChange={(event) => setEditorValue(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitEditor();
                  if (event.key === 'Escape') setEditor(null);
                }}
                placeholder={language === 'zh' ? '名称' : 'Name'}
              />
              <button type="button" onClick={() => void commitEditor()}><Check size={15} /></button>
              <button type="button" onClick={() => setEditor(null)}><X size={15} /></button>
            </div>
          )}
          {error && <div className="os-system-error">{error}</div>}
          <div className="os-file-list" role="listbox" aria-label="Files">
            {visibleItems.map((item) => (
              <button
                type="button"
                role="option"
                aria-selected={selected?.id === item.id}
                key={item.id}
                data-os-control="true"
                className={selected?.id === item.id ? 'selected' : ''}
                onClick={() => setSelected(item)}
                onDoubleClick={() => void openItem(item)}
              >
                {item.kind === 'directory' ? <Folder size={17} /> : <File size={17} />}
                <span>{item.name}</span>
                <small>{item.kind === 'directory' ? '' : formatBytes(item.size)}</small>
                <time>{formatModifiedAt(item.modifiedAt, language)}</time>
              </button>
            ))}
          </div>
          {!loading && visibleItems.length === 0 && (
            <div className="os-system-empty">
              {fileQuery
                ? language === 'zh' ? '没有匹配的文件' : 'No matching files'
                : language === 'zh' ? '这个位置是空的' : 'This location is empty'}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function localizedLocationName(id: string, fallback: string, language: AppLanguage) {
  if (language !== 'zh') return fallback;
  return ({ home: '主目录', desktop: '桌面', documents: '文档', downloads: '下载', pictures: '图片', music: '音乐' } as Record<string, string>)[id] ?? fallback;
}

function appInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? 'A';
}

function formatBytes(value: number) {
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function formatModifiedAt(value: string, language: AppLanguage) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}
