import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder } from 'lucide-react';
import type { WorkspaceDirectoryPage } from '../../../electron/workspaceFiles';
import { acceptCreationFile, markdownFile, sameFile } from './creationFiles';
import { getBushItPages } from './bushItPageStore';

export function CreationFileTree({ root, directory = root, language, selectedPath, query, refresh, onSelect, onError, depth = 0 }: {
  root: string; directory?: string; language: string; selectedPath?: string; query: string; refresh: number;
  onSelect?: () => void; onError: (error: string) => void; depth?: number;
}) {
  const [page, setPage] = useState<WorkspaceDirectoryPage>({ entries: [] }), [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const loadedPages = useRef(1);
  useEffect(() => {
    let active = true;
    void (async () => {
      if (!window.cardbushDesktop?.readWorkspaceDirectory) return;
      let value = await window.cardbushDesktop.readWorkspaceDirectory({ rootPath: root, directoryPath: directory });
      for (let count = 1; active && count < loadedPages.current && value.nextOffset !== undefined; count++) {
        const next = await window.cardbushDesktop.readWorkspaceDirectory({ rootPath: root, directoryPath: directory, offset: value.nextOffset });
        value = { entries: [...value.entries, ...next.entries], nextOffset: next.nextOffset };
      }
      if (active) setPage(current => JSON.stringify(current) === JSON.stringify(value) ? current : value);
      const workspace = getBushItPages();
      if (active && workspace.projectDir === root && !workspace.selectedId) {
        const candidates = value.entries.filter(entry => entry.kind === 'file' && /\.(md|markdown)$/i.test(entry.name));
        const first = candidates.find(entry => /^readme\.md$/i.test(entry.name)) ?? candidates[0];
        if (first) {
          const file = await markdownFile({ action: 'open', rootPath: root, path: first.path });
          // Also displays the first document created by the Agent in an empty project.
          if (active && file && getBushItPages().projectDir === root && !getBushItPages().selectedId) acceptCreationFile(file, root);
        }
      }
    })().catch(error => { if (active) onError(String(error.message ?? error)); });
    return () => { active = false; };
  }, [root, directory, refresh]);
  const more = async () => {
    if (busy || page.nextOffset === undefined) return; setBusy(true);
    try {
      const next = await window.cardbushDesktop!.readWorkspaceDirectory({ rootPath: root, directoryPath: directory, offset: page.nextOffset });
      loadedPages.current++;
      setPage(current => ({ entries: [...new Map([...current.entries, ...next.entries].map(entry => [entry.path, entry])).values()], nextOffset: next.nextOffset }));
    } catch (error) { onError(String((error as Error).message)); } finally { setBusy(false); }
  };
  const open = async (path: string) => {
    try { const file = await markdownFile({ action: 'open', path, rootPath: root }); if (file) { acceptCreationFile(file, root); onSelect?.(); } }
    catch (error) { onError(String((error as Error).message)); }
  };
  const entries = page.entries.filter(entry => entry.kind === 'folder' || /\.(md|markdown)$/i.test(entry.name) && entry.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="creation-file-tree" role="group">{entries.map(entry => <div key={entry.path}>
    <button type="button" style={{ paddingLeft: 10 + depth * 14 }} title={entry.path} className={selectedPath && sameFile(selectedPath, entry.path) ? 'active' : ''}
      aria-expanded={entry.kind === 'folder' ? expanded.has(entry.path) : undefined} onClick={() => entry.kind === 'file' ? void open(entry.path) : setExpanded(current => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })}>
      {entry.kind === 'folder' ? <>{expanded.has(entry.path) ? <ChevronDown size={12}/> : <ChevronRight size={12}/>}<Folder size={15}/></> : <FileText size={15}/>}<span>{entry.name}</span>
    </button>
    {entry.kind === 'folder' && expanded.has(entry.path) && <CreationFileTree root={root} directory={entry.path} depth={depth + 1} language={language} selectedPath={selectedPath} query={query} refresh={refresh} onSelect={onSelect} onError={onError}/>}
  </div>)}{page.nextOffset !== undefined && <button disabled={busy} onClick={() => void more()}>{uiText(language)('image.loadMore')}</button>}
    {!entries.length && !depth && <small>{uiText(language)('creationFileTree.noMarkdownFiles')}</small>}
  </div>;
}
