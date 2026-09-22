import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, Check, ChevronDown, ChevronRight, Folder, FolderOpen, MessageSquare, Monitor, Server, Settings, X } from 'lucide-react';
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
  language, initialPath, connectionId, projects = [], remote = false, allowNone = false, anchor, onSelect,
}: Options & { onSelect: (path: string | null | undefined) => void }) {
  const zh = language === 'zh';
  const connections = useSshConnections();
  const initial = parseSshWorkspace(initialPath);
  const [mode, setMode] = useState<'local' | 'ssh'>(remote || connectionId || initial ? 'ssh' : 'local');
  const [selected, setSelected] = useState(connectionId ?? initial?.connectionId ?? '');
  const [path, setPath] = useState(initial?.path ?? '');
  const [entries, setEntries] = useState<Array<{ name: string; path: string; kind: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manage, setManage] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const active = useRef(true);
  const visibleProjects = projects.filter(project => !project.archived && !project.missing);
  const localProjects = visibleProjects.filter(project => !project.rootPath.startsWith('ssh://'));
  const remoteProjects = visibleProjects.filter(project => parseSshWorkspace(project.rootPath)?.connectionId === selected);
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
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!anchor || !node) return;
    const position = () => {
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      node.style.maxHeight = Math.min(window.innerHeight - 16, Math.max(180, below, above), 600) + 'px';
      const top = below >= node.offsetHeight || below >= above ? rect.bottom + 6 : rect.top - node.offsetHeight - 6;
      node.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - node.offsetWidth - 8)) + 'px';
      node.style.top = Math.max(8, Math.min(top, window.innerHeight - node.offsetHeight - 8)) + 'px';
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(node);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
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
      <span className="workspace-picker-row-copy"><span>{project.title}</span><small title={remotePath ?? project.rootPath}>{remotePath ?? project.rootPath}</small></span>
      {samePath(initialPath ?? '', project.rootPath) && <Check className="workspace-picker-trailing" size={16} aria-label={zh ? '当前项目' : 'Current project'} />}
    </button>
  );

  return <div className={`ssh-dialog-backdrop${anchor ? ' workspace-picker-backdrop' : ''}`}
    onMouseDown={event => { if (event.target === event.currentTarget && !busy) onSelect(undefined); }}>
    <div className={`ssh-dialog workspace-picker${anchor ? ' workspace-picker-anchored' : ''}`} ref={dialog} tabIndex={-1}
      role="dialog" aria-modal="true" aria-label={zh ? '选择本地或远程项目' : 'Select local or remote project'}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onSelect(undefined); }
        if (event.key === 'Tab') {
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')];
          const first = elements[0], last = elements.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
        }
      }}>
      <div className="workspace-picker-heading"><span>{editingConnection ? (zh ? 'SSH 连接' : 'SSH connection') : (zh ? '选择项目' : 'Choose project')}</span>
        <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => onSelect(undefined)}><X size={16} /></button>
      </div>
      {!editingConnection && <div className="ssh-location-tabs" role="tablist" aria-label={zh ? '项目位置' : 'Project location'}>
        <button type="button" role="tab" disabled={busy} aria-selected={mode === 'local'} onClick={() => { setMode('local'); setError(''); }}><Monitor size={16} />{zh ? '本地' : 'Local'}</button>
        <button type="button" role="tab" disabled={busy} aria-selected={mode === 'ssh'} onClick={() => { setMode('ssh'); setError(''); }}><Server size={16} />SSH</button>
      </div>}
      {mode === 'local' ? <>
        {localProjects.length > 0 && <>
          <div className="workspace-picker-section-label">{zh ? '本地项目' : 'Local projects'}</div>
          <div className="ssh-project-list">{localProjects.map(project => projectRow(project))}</div>
          <div className="workspace-picker-separator" role="separator" />
        </>}
        <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void selectLocalFolder()}><FolderOpen size={16} />
          <span>{zh ? '选择本地文件夹' : 'Choose local folder'}</span><ChevronRight className="workspace-picker-trailing" size={16} />
        </button>
        {allowNone && <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => onSelect(null)} aria-current={!initialPath ? 'true' : undefined}>
          <MessageSquare size={16} /><span>{zh ? '本地会话，不关联项目' : 'Local session without a project'}</span>
          {!initialPath && <Check className="workspace-picker-trailing" size={16} />}
        </button>}
      </> : <>
        {!editingConnection && <><div className="workspace-picker-fields"><label>{zh ? 'SSH 连接' : 'SSH connection'}
          <select value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setPath(connections.find(item => item.id === event.target.value)?.defaultDirectory ?? '/'); setEntries([]); setError(''); }}>
            <option value="" disabled>{zh ? '选择连接' : 'Select connection'}</option>
            {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}</option>)}
          </select>
        </label></div>
        <button className="workspace-picker-row" type="button" disabled={busy} aria-expanded={manage} onClick={() => setManage(!manage)}>
          <Settings size={16} /><span>{zh ? '管理 SSH 连接' : 'Manage SSH connections'}</span><ChevronRight className={`workspace-picker-trailing${manage ? ' is-expanded' : ''}`} size={16} />
        </button>
        </>}
        {manage && <div className="workspace-picker-management"><SshConnectionsPanel language={language} projects={projects} compact onEditingChange={setEditingConnection} onConnected={connectionReady} /></div>}
        {connection && !manage && <>
          <div className="workspace-picker-separator" role="separator" />
          {remoteProjects.length > 0 && <><div className="workspace-picker-section-label">{zh ? '远程项目' : 'Remote projects'}</div>
            <div className="ssh-project-list">{remoteProjects.map(project => projectRow(project, parseSshWorkspace(project.rootPath)!.path))}</div>
            <div className="workspace-picker-separator" role="separator" /></>}
          <div className="workspace-picker-fields"><label>{zh ? '远程目录' : 'Remote directory'}
            <div className="ssh-input-action"><input aria-label={zh ? '远程目录' : 'Remote directory'} value={path} disabled={busy}
              onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void browse(); }} placeholder={connection.defaultDirectory} />
              <button type="button" disabled={busy} onClick={() => void browse()}>{busy ? (zh ? '连接中…' : 'Connecting…') : (zh ? '浏览' : 'Browse')}</button>
            </div>
          </label></div>
          <div className="ssh-directory-list">
            {path !== '/' && <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void browse(path.replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/')}><ArrowUp size={16} /><span>{zh ? '上级目录' : 'Parent directory'}</span></button>}
            {entries.filter(entry => entry.kind === 'folder').map(entry => <button className="workspace-picker-row" type="button" disabled={busy} key={entry.path}
              onClick={() => void browse(parseSshWorkspace(entry.path)!.path)}><Folder size={16} /><span>{entry.name}</span><ChevronRight className="workspace-picker-trailing" size={16} /></button>)}
          </div>
          <div className="workspace-picker-separator" role="separator" />
          <button className="workspace-picker-row" type="button" disabled={busy} onClick={() => void browse(path || connection.defaultDirectory, true)}><Check size={16} /><span>{zh ? '连接并使用此目录' : 'Connect and use this directory'}</span></button>
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
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
  const label = remote ? connections.find(item => item.id === remote.connectionId)?.name ?? 'SSH' : language === 'zh' ? '本地' : 'Local';
  return <div className="workspace-location-control">
    <button type="button" disabled={disabled || busy} aria-haspopup="dialog" aria-expanded={open} aria-label={language === 'zh' ? '选择本地或 SSH' : 'Select local or SSH'}
      onClick={event => {
        const anchor = event.currentTarget;
        setOpen(true);
        void (async () => {
          const selected = await pickWorkspace({ language, initialPath: root, projects, allowNone: true, anchor });
          setOpen(false);
          if (selected === undefined) return;
          setBusy(true); setError('');
          try { await onSelect(selected); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
        })();
      }}>
      {remote ? <Server size={14} /> : <Monitor size={14} />}<span>{label}</span>
      <span className="workspace-location-name">{root ? projects.find(item => item.rootPath === root)?.title ?? basename(remote?.path ?? root) : ''}</span>
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {error && <span className="ssh-error" role="alert">{error}</span>}
  </div>;
}
