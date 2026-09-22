import { ChevronDown, ChevronRight, Folder, FolderOpen, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ConversationHostContext } from '../conversationHost';
import type { WorkspaceDirectoryEntry } from '../../../electron/workspaceFiles';
import type { AppLanguage } from '../../types';
import { basename } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { FileTypeIcon } from '../chatMessages/FileTypeIcon';
import { reviewExternalRoots, reviewPathKey, reviewRelativePath } from './reviewModel';

type Directory = { entries: WorkspaceDirectoryEntry[]; nextOffset?: number; loading?: boolean; error?: string };
type Row = WorkspaceDirectoryEntry & { depth: number; virtual?: boolean; action?: 'more' | 'retry' | 'loading' };
const rowHeight = 30;

export function ReviewFileTree({ rootPath, selectedPath, changedPaths, language, revision, onSelect }: {
  rootPath: string; selectedPath: string; changedPaths: string[]; language: AppLanguage; revision?: string;
  onSelect: (path: string) => void;
}) {
  const zh = language === 'zh';
  const host = useContext(ConversationHostContext);
  const [directories, setDirectories] = useState<Map<string, Directory>>(() => new Map());
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [focusedPath, setFocusedPath] = useState('');
  const viewport = useRef<HTMLDivElement>(null);
  const treeId = useId();
  const pendingReveal = useRef('');
  const generation = useRef(0);
  const loading = useRef(new Set<string>());
  const outsideRoots = useMemo(() => reviewExternalRoots(rootPath, changedPaths), [rootPath, changedPaths]);
  const load = useCallback(async (path: string, offset = 0) => {
    const key = reviewPathKey(path), request = `${key}:${offset}`;
    if (loading.current.has(request)) return;
    const version = generation.current;
    loading.current.add(request);
    setDirectories(previous => new Map(previous).set(key, { entries: previous.get(key)?.entries ?? [], loading: true }));
    try {
      const reader = host ? host.readDirectory : window.cardbushDesktop?.readWorkspaceDirectory;
      if (!reader) throw new Error(zh ? '文件目录服务不可用' : 'Directory service unavailable');
      const page = host ? await host.readDirectory!({ directoryPath: path, offset }) : await window.cardbushDesktop!.readWorkspaceDirectory!({ rootPath, directoryPath: path, offset });
      if (version !== generation.current) return;
      setDirectories(previous => new Map(previous).set(key, {
        entries: offset ? [...(previous.get(key)?.entries ?? []), ...page.entries] : page.entries,
        nextOffset: page.nextOffset,
      }));
    } catch (error) {
      if (version === generation.current) setDirectories(previous => new Map(previous).set(key, {
        entries: previous.get(key)?.entries ?? [], error: String((error as Error).message),
      }));
    } finally { if (version === generation.current) loading.current.delete(request); }
  }, [rootPath, zh, host]);
  const refresh = useCallback(() => {
    generation.current++;
    loading.current.clear();
    if (rootPath) void load(rootPath);
    // Reload only folders the user has already expanded.
    for (const path of expanded) if (reviewRelativePath(rootPath, path) !== null) void load(path);
  }, [rootPath, expanded, load]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    setDirectories(new Map());
    setExpanded(new Set());
    setScrollTop(0);
    refreshRef.current();
    return () => { generation.current++; loading.current.clear(); };
  }, [rootPath, load]);
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current === revision) return;
    const timer = window.setTimeout(() => { previousRevision.current = revision; refreshRef.current(); }, 300);
    return () => window.clearTimeout(timer);
  }, [revision]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const relative = reviewRelativePath(rootPath, selectedPath);
    const externalRoot = relative === null
      ? outsideRoots.find(root => reviewRelativePath(root.path, selectedPath) !== null)?.path : undefined;
    const base = externalRoot || rootPath;
    const local = relative ?? (externalRoot ? reviewRelativePath(externalRoot, selectedPath) : null);
    if (!local) return;
    pendingReveal.current = reviewPathKey(selectedPath);
    const folders = local.split('/').slice(0, -1);
    let parent = base.replaceAll('\\', '/').replace(/\/+$/, '');
    const paths = [...(externalRoot ? [externalRoot] : []), ...folders.map(folder => parent += '/' + folder)];
    setExpanded(previous => new Set([...previous, ...paths.map(reviewPathKey)]));
    if (!externalRoot) for (const path of paths) if (!directoriesRef.current.has(reviewPathKey(path))) void load(path);
  }, [selectedPath, rootPath, outsideRoots, load]);
  const changed = useMemo(() => {
    const paths = new Set<string>();
    for (let path of changedPaths.map(reviewPathKey)) {
      paths.add(path);
      while (path.lastIndexOf('/') > 0) { path = path.slice(0, path.lastIndexOf('/')); paths.add(path); }
    }
    return paths;
  }, [changedPaths]);
  const rows = useMemo(() => {
    const result: Row[] = [];
    const append = (parent: string, depth: number, virtual = false) => {
      const directory = virtual ? undefined : directories.get(reviewPathKey(parent));
      const entries = new Map((directory?.entries ?? []).map(entry => [reviewPathKey(entry.path), entry]));
      for (const path of changedPaths) {
        // External branches contain only reported outside edits, even when their
        // containing folder happens to be an ancestor of the task directory.
        if (virtual && reviewRelativePath(rootPath, path) !== null) continue;
        const relative = reviewRelativePath(parent, path);
        if (!relative) continue;
        const [name, ...children] = relative.split('/');
        const childPath = parent.replace(/[\\/]+$/, '') + '/' + name;
        const key = reviewPathKey(childPath);
        if (!entries.has(key)) entries.set(key, { name, path: childPath, kind: children.length ? 'folder' : 'file' });
      }
      for (const entry of [...entries.values()].sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true }))) {
        result.push({ ...entry, depth, virtual });
        if (entry.kind === 'folder' && expanded.has(reviewPathKey(entry.path))) append(entry.path, depth + 1, virtual);
      }
      if (directory?.loading) result.push({ name: zh ? '正在读取…' : 'Loading…', path: parent, kind: 'file', depth, action: 'loading' });
      else if (directory?.error) result.push({ name: zh ? '读取失败，重试' : 'Unable to read. Retry', path: parent, kind: 'file', depth, action: 'retry' });
      else if (directory?.nextOffset !== undefined) result.push({ name: zh ? '加载更多文件' : 'Load more files', path: parent, kind: 'file', depth, action: 'more' });
    };
    if (rootPath) append(rootPath, 0);
    for (const { path, name } of outsideRoots) {
      result.push({ name: `${name} · ${zh ? '其他位置' : 'Other location'}`, path, kind: 'folder', depth: 0, virtual: true });
      if (expanded.has(reviewPathKey(path))) append(path, 1, true);
    }
    return result;
  }, [directories, changedPaths, expanded, rootPath, outsideRoots, zh]);
  useEffect(() => {
    if (!pendingReveal.current || !viewport.current) return;
    const index = rows.findIndex(row => reviewPathKey(row.path) === pendingReveal.current);
    if (index < 0) return;
    const element = viewport.current;
    if (index * rowHeight < element.scrollTop || (index + 1) * rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, index * rowHeight - element.clientHeight / 2);
    pendingReveal.current = '';
  }, [rows]);
  const activate = (row: Row) => {
    if (row.action === 'loading') return;
    if (row.action) { void load(row.path, row.action === 'more' ? directories.get(reviewPathKey(row.path))?.nextOffset : 0); return; }
    setFocusedPath(reviewPathKey(row.path));
    if (row.kind === 'file') { onSelect(row.path); return; }
    const key = reviewPathKey(row.path), open = !expanded.has(key);
    setExpanded(previous => { const next = new Set(previous); if (open) next.add(key); else next.delete(key); return next; });
    if (open && !row.virtual && !directories.has(key)) void load(row.path);
  };
  const start = Math.max(0, Math.min(Math.max(0, rows.length - Math.ceil(height / rowHeight)), Math.floor(scrollTop / rowHeight) - 8));
  const end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 16);
  const focusedIndex = rows.findIndex(row => reviewPathKey(row.path) === focusedPath);
  return <>
    <div className="change-review-tree-root">
      <span title={rootPath} onContextMenu={host ? undefined : event => rootPath && openFileContextMenu(event, rootPath, { language })}>
        <FolderOpen size={14} /><strong>{basename(rootPath) || (zh ? '会话文件' : 'Task files')}</strong><span>/</span>
      </span>
      <button type="button" aria-label={zh ? '刷新文件目录' : 'Refresh directory'} title={zh ? '刷新文件目录' : 'Refresh directory'} onClick={refresh}><RefreshCw size={13} /></button>
    </div>
    <div ref={viewport} className="change-review-files" role="tree" tabIndex={0} aria-label={zh ? '工作目录文件' : 'Workspace files'}
      aria-activedescendant={focusedIndex >= start && focusedIndex < end ? `${treeId}-${focusedIndex}` : undefined}
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={event => {
        const index = Math.max(0, rows.findIndex(row => reviewPathKey(row.path) === (focusedPath || reviewPathKey(selectedPath))));
        const row = rows[index];
        if (!row) return;
        let next = index;
        if (event.key === 'ArrowDown') next = Math.min(rows.length - 1, index + 1);
        else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = rows.length - 1;
        else if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowRight' && row.kind === 'folder' && !expanded.has(reviewPathKey(row.path))) || (event.key === 'ArrowLeft' && expanded.has(reviewPathKey(row.path)))) { event.preventDefault(); activate(row); return; }
        else return;
        event.preventDefault();
        setFocusedPath(reviewPathKey(rows[next].path));
        const element = viewport.current!;
        if (next * rowHeight < element.scrollTop) element.scrollTop = next * rowHeight;
        else if ((next + 1) * rowHeight > element.scrollTop + height) element.scrollTop = (next + 1) * rowHeight - height;
      }}>
      <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
        {rows.slice(start, end).map((row, offset) => {
          const key = reviewPathKey(row.path), active = row.kind === 'file' && !row.action && key === reviewPathKey(selectedPath);
          return <button key={key + (row.action ?? '')} type="button" role="treeitem" tabIndex={-1}
            id={`${treeId}-${start + offset}`}
            aria-level={row.depth + 1} aria-selected={active} aria-expanded={row.kind === 'folder' ? expanded.has(key) : undefined}
            className={`change-review-file-item${active ? ' active' : ''}${focusedPath === key ? ' keyboard-focused' : ''}`}
            title={directories.get(key)?.error || row.path} data-path={row.path}
            style={{ position: 'absolute', top: (start + offset) * rowHeight, height: rowHeight, paddingLeft: 6 + row.depth * 14 }}
            onContextMenu={host ? undefined : event => !row.action && openFileContextMenu(event, row.path, { language })}
            onClick={() => { activate(row); viewport.current?.focus({ preventScroll: true }); }}>
            {row.action === 'loading' ? <LoaderCircle size={13} /> : row.kind === 'folder' ? (expanded.has(key) ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}
            {row.kind === 'folder' ? <Folder size={14} /> : <FileTypeIcon path={row.path} />}
            <strong>{row.name}</strong>
            {changed.has(key) && !row.action && <span className="change-review-file-marker" title={zh ? '所选轮次有修改' : 'Changed in selected turn'} />}
          </button>;
        })}
      </div>
      {rows.length === 0 && <p className="change-review-tree-empty">{zh ? '此文件夹为空' : 'This folder is empty'}</p>}
    </div>
  </>;
}
