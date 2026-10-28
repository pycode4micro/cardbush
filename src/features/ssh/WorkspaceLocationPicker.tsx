import { uiText } from '../../i18n';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, Check, ChevronRight, Folder, FolderOpen, LaptopMinimal, MessageSquare, Monitor, Search, Server, Settings, X } from 'lucide-react';
import { parseSshWorkspace, sshWorkspace } from '@cardbush/bush-protocol';
import type { AppLanguage, ProjectItem } from '../../types';
import { SshConnectionsPanel, sshChanged, useSshConnections } from './SshConnectionsPanel';
import { basename, samePath } from '../../shared/localPaths';

type Options = {
  language: AppLanguage;
  initialPath?: string;
  connectionId?: string;
  projects?: ProjectItem[];
  remote?: boolean;
  allowNone?: boolean;
  anchor?: HTMLElement;
  entry?: 'project' | 'location';
};

/** Shared by project creation, workspace selection and @ references. */
export function pickWorkspace(options: Options): Promise<string | null | undefined> {
  const previous = document.activeElement as HTMLElement | null;
  const container = document.createElement('div');
  const theme = document.querySelector('.app');
  if (theme) {
    const style = getComputedStyle(theme);
    for (const name of ['--surface', '--surface-strong', '--text', '--text-soft', '--text-mid', '--border',
      '--menu-surface', '--menu-border', '--menu-secondary', '--menu-hover', '--menu-separator', '--menu-shadow', '--menu-radius']) {
      container.style.setProperty(name, style.getPropertyValue(name));
    }
  }
  document.body.append(container);
  const root = createRoot(container);
  return new Promise(resolve => {
    const done = (path: string | null | undefined) => {
      root.unmount();
      container.remove();
      if (previous?.isConnected) previous.focus();
      resolve(path);
    };
    root.render(<WorkspaceLocationPicker {...options} onSelect={done} />);
  });
}

export function WorkspaceLocationPicker({
  language, initialPath, connectionId, projects = [], remote = false, allowNone = false, anchor, entry, onSelect,
}: Options & { onSelect: (path: string | null | undefined) => void }) {
  const t = uiText(language);
  const connections = useSshConnections();
  const initial = parseSshWorkspace(initialPath);
  const [mode, setMode] = useState<'local' | 'ssh'>(remote || connectionId || initial ? 'ssh' : 'local');
  const [selected, setSelected] = useState(connectionId ?? initial?.connectionId ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; kind: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [locationView, setLocationView] = useState(entry === 'location');
  const [manage, setManage] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const active = useRef(true);
  const projectView = !locationView && !manage && !editingConnection;
  const projectCandidates = projects.filter(project => !project.archived && !project.missing &&
    (mode === 'local' ? !project.rootPath.startsWith('ssh://') : parseSshWorkspace(project.rootPath)?.connectionId === selected));
  const showSearch = projectCandidates.length > 5 || query.length > 0;
  const searchScope = mode === 'local' ? 'local' : `ssh:${selected}`;
  const visibleProjects = projectCandidates.filter(project =>
    `${project.title} ${project.rootPath}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const connection = connections.find(item => item.id === selected);

  useEffect(() => {
    active.current = true;
    dialog.current?.focus();
    return () => { active.current = false; request.current++; };
  }, []);
  useEffect(() => {
    if (!selected && connections[0]) {
      setSelected(connections[0].id);
      setPath(connections[0].defaultDirectory);
    }
  }, [connections, selected]);
  useEffect(() => { setQuery(''); }, [searchScope]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!anchor || !node) return;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      node.style.maxHeight = Math.min(window.innerHeight - 16, Math.max(180, below, above), 600) + 'px';
      const top = above >= node.offsetHeight && above > below ? rect.top - node.offsetHeight - 6 : rect.bottom + 6;
      node.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8)) + 'px';
      node.style.top = Math.max(8, Math.min(top, window.innerHeight - node.offsetHeight - 8)) + 'px';
    };
    position();
    let frame = 0;
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); };
    const observer = new ResizeObserver(schedule);
    observer.observe(node);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [anchor]);

  async function browse(value = path || connection?.defaultDirectory || '/', finish = false, targetConnectionId = selected) {
    const generation = ++request.current;
    setBusy(true); setError('');
    try {
      const result = await window.cardbushDesktop!.sshConnections.directory(sshWorkspace(targetConnectionId, value));
      if (!active.current || generation !== request.current) return;
      setPath(result.path); setEntries(result.entries);
      if (connections.find(item => item.id === targetConnectionId)?.status !== 'connected') sshChanged();
      if (finish) onSelect(result.uri);
    } catch (error) {
      if (active.current && generation === request.current) setError((error as Error).message);
    } finally {
      if (active.current && generation === request.current) setBusy(false);
    }
  }
  function connectionReady(id: string, directory: string) {
    if (!active.current) return;
    setSelected(id);
    setManage(false);
    setEditingConnection(false);
    setPath(directory);
    setEntries([]);
    // The selected state still refers to the previous host in this event.
    void browse(directory, false, id);
  }
  async function selectLocalFolder() {
    setBusy(true); setError('');
    try {
      const folder = await window.cardbushDesktop?.pickProjectDirectory();
      if (active.current && folder) onSelect(folder);
    } catch (error) {
      if (active.current) setError((error as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const projectRow = (project: ProjectItem, remotePath?: string) => (
    <button className="workspace-picker-row" type="button" key={project.id} disabled={busy}
      aria-current={samePath(initialPath ?? '', project.rootPath) ? 'true' : undefined}
      onClick={() => remotePath ? void browse(remotePath, true) : onSelect(project.rootPath)}>
      <Folder size={16} />
      <span className="workspace-picker-row-copy" title={remotePath ?? project.rootPath}><span>{project.title}</span></span>
      {samePath(initialPath ?? '', project.rootPath) && <Check className="workspace-picker-trailing" size={16} aria-label={t('workspace.currentProject')} />}
    </button>
  );

  return <div className={`ssh-dialog-backdrop${anchor ? ' workspace-picker-backdrop' : ''}`}
    onMouseDown={event => { if (event.target === event.currentTarget && !busy) onSelect(undefined); }}>
    <div className={`ssh-dialog workspace-picker${projectView ? ' workspace-picker-project' : ''}${anchor ? ' workspace-picker-anchored' : ''}`} ref={dialog} tabIndex={-1}
      role="dialog" aria-modal="true" aria-label={locationView ? t('workspace.location') : t('workspace.selectProject')}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onSelect(undefined); }
        if (event.key === 'Tab') {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      {!projectView && <div className="workspace-picker-heading"><span>{locationView ? (t('workspace.location')) : (t('workspace.connection'))}</span>
        <button type="button" aria-label={t('common.close')} onClick={() => onSelect(undefined)}><X size={16} /></button>
      </div>}
      {locationView ? <>
        <button className="workspace-picker-row" type="button" disabled={busy} aria-current={!initial ? 'true' : undefined} onClick={() => onSelect(initial ? null : undefined)}>
          <LaptopMinimal size={16}/><span>{t('workspace.computer')}</span>{!initial && <Check className="workspace-picker-trailing" size={16}/>}
        </button>
        {connections.map(item => <button className="workspace-picker-row" type="button" key={item.id} disabled={busy} aria-current={initial?.connectionId === item.id ? 'true' : undefined}
          onClick={() => { if (initial?.connectionId === item.id) onSelect(undefined); else void browse(item.defaultDirectory, true, item.id); }}>
          <Server size={16}/><span>{item.name}</span>{initial?.connectionId === item.id && <Check className="workspace-picker-trailing" size={16}/>}
        </button>)}
        <div className="workspace-picker-separator" role="separator"/>
        <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => { setLocationView(false); setMode('ssh'); setManage(true); }}>
          <Settings size={16}/><span>{t('workspace.manageConnections')}</span>
        </button>
      </> : <>
      {projectView && showSearch && <label className="workspace-picker-search"><Search size={14} aria-hidden="true"/>
        <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('workspace.search')} aria-label={t('workspace.search')}/>
      </label>}
      {!editingConnection && !entry && <div className="ssh-location-tabs" role="tablist" aria-label={t('workspace.projectLocation')}>
        <button type="button" role="tab" disabled={busy} aria-selected={mode === 'local'} onClick={() => { setMode('local'); setError(''); }}><Monitor size={16} />{t('workspace.local')}</button>
        <button type="button" role="tab" disabled={busy} aria-selected={mode === 'ssh'} onClick={() => { setMode('ssh'); setError(''); }}><Server size={16} />{uiText(language)('agentConnectionForm.ssh')}</button>
      </div>}
      {mode === 'local' ? <>
        {query && !visibleProjects.length && <p className="workspace-picker-empty">{t('workspace.noMatches')}</p>}
        {visibleProjects.length > 0 && <>
          <div className="workspace-picker-section-label">{t('workspace.localProjects')}</div>
          <div className="ssh-project-list">{visibleProjects.map(project => projectRow(project))}</div>
          <div className="workspace-picker-separator" role="separator" />
        </>}
        <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void selectLocalFolder()}><FolderOpen size={16} />
          <span>{t('workspace.chooseFolder')}</span><ChevronRight className="workspace-picker-trailing" size={16} />
        </button>
        {allowNone && <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => onSelect(null)} aria-current={!initialPath ? 'true' : undefined}>
          <MessageSquare size={16} /><span>{t('workspace.noProject')}</span>
          {!initialPath && <Check className="workspace-picker-trailing" size={16} />}
        </button>}
      </> : <>
        {!editingConnection && <><div className="workspace-picker-fields"><label>{t('workspace.connection')}
          <select value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setPath(connections.find(item => item.id === event.target.value)?.defaultDirectory ?? '/'); setEntries([]); setError(''); }}>
            <option value="" disabled>{t('workspace.selectConnection')}</option>
            {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}</option>)}
          </select>
        </label></div>
        <button className="workspace-picker-row" type="button" disabled={busy} aria-expanded={manage} onClick={() => setManage(!manage)}>
          <Settings size={16} /><span>{t('workspace.manageConnections')}</span><ChevronRight className={`workspace-picker-trailing${manage ? ' is-expanded' : ''}`} size={16} />
        </button>
        </>}
        {manage && <div className="workspace-picker-management"><SshConnectionsPanel language={language} projects={projects} compact onEditingChange={setEditingConnection} onConnected={connectionReady} /></div>}
        {connection && !manage && <>
          <div className="workspace-picker-separator" role="separator" />
          {visibleProjects.length > 0 && <><div className="workspace-picker-section-label">{t('workspace.remoteProjects')}</div>
            <div className="ssh-project-list">{visibleProjects.map(project => projectRow(project, parseSshWorkspace(project.rootPath)!.path))}</div>
            <div className="workspace-picker-separator" role="separator" /></>}
          <div className="workspace-picker-fields"><label>{t('workspace.remoteDirectory')}
            <div className="ssh-input-action"><input aria-label={t('workspace.remoteDirectory')} value={path} disabled={busy}
              onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void browse(); }} placeholder={connection.defaultDirectory} />
              <button type="button" disabled={busy} onClick={() => void browse()}>{busy ? (t('workspace.connecting')) : (t('workspace.browse'))}</button>
            </div>
          </label></div>
          <div className="ssh-directory-list">
            {path !== '/' && <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void browse(path.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/')}><ArrowUp size={16} /><span>{t('workspace.parentDirectory')}</span></button>}
            {entries.filter(entry => entry.kind === 'folder').map(entry => <button className="workspace-picker-row" type="button" disabled={busy} key={entry.path}
              onClick={() => void browse(parseSshWorkspace(entry.path)!.path)}><Folder size={16} /><span>{entry.name}</span><ChevronRight className="workspace-picker-trailing" size={16} /></button>)}
          </div>
          <div className="workspace-picker-separator" role="separator" />
          <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void browse(path || connection.defaultDirectory, true)}><Check size={16} /><span>{t('workspace.useDirectory')}</span></button>
        </>}
      </>}
      </>}
      {error && <p className="ssh-error workspace-picker-error" role="alert">{error}</p>}
    </div>
  </div>;
}

export function WorkspaceLocationButton({ language, root, projects, onSelect, disabled = false }: {
  language: AppLanguage; root: string; projects: ProjectItem[]; onSelect: (path: string | null) => Promise<void>; disabled?: boolean;
}) {
  const connections = useSshConnections(), remote = parseSshWorkspace(root);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState<'project' | 'location' | null>(null);
  const t = uiText(language);
  const label = remote ? connections.find(item => item.id === remote.connectionId)?.name ?? 'SSH' : t('workspace.computer');
  const projectName = root ? projects.find(item => samePath(item.rootPath, root))?.title ?? basename(remote?.path ?? root) : t('workspace.chooseProject');
  async function choose(anchor: HTMLElement, control: 'project' | 'location') {
    setOpen(control);
    try {
      const selected = await pickWorkspace({ language, initialPath: root, projects, allowNone: true, anchor, entry: control });
      if (selected === undefined) return;
      setBusy(true); setError('');
      await onSelect(selected);
    } catch (error) { setError((error as Error).message); }
    finally { setOpen(null); setBusy(false); }
  }
  return <div className="workspace-location-control">
    <button type="button" className="workspace-project-chip" disabled={disabled || busy} aria-haspopup="dialog" aria-expanded={open === 'project'} aria-label={t('workspace.chooseProject')}
      onClick={event => void choose(event.currentTarget, 'project')} title={root || projectName}>
      <Folder size={14} strokeWidth={1.7}/><span className="workspace-location-name">{projectName}</span>
    </button>
    <button type="button" disabled={disabled || busy} aria-haspopup="dialog" aria-expanded={open === 'location'} aria-label={t('workspace.chooseLocation')}
      onClick={event => void choose(event.currentTarget, 'location')}>
      {remote ? <Server size={14} strokeWidth={1.7}/> : <LaptopMinimal size={15} strokeWidth={1.7}/>}<span>{label}</span>
    </button>
    {error && <span className="ssh-error" role="alert">{error}</span>}
  </div>;
}
