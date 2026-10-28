import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, FilePlus2, FileText, Files, Folder, FolderOpen, Plus, RefreshCw, RotateCcw, Search, StickyNote, Trash2 } from 'lucide-react';
import { archiveBushItPage, bushItPageName, createBushItPage, isCreationDraftDirectory, selectBushItPage, selectCreationProject, useBushItPages } from './bushItPageStore';
import { CreationFileTree } from './CreationFileTree';
import { acceptCreationFile, fileName, markdownFile } from './creationFiles';
import './bush-it-sidebar.css';

export function BushItSidebar({ language, onBack, onSelect, softVisible = true }: { language: string; onBack?: () => void; onSelect?: () => void; softVisible?: boolean }) {
  const state = useBushItPages(), [query, setQuery] = useState(''), [trash, setTrash] = useState(false);
  const [draftsOnly, setDraftsOnly] = useState(false), [showAll, setShowAll] = useState(false), [searchOpen, setSearchOpen] = useState(false);
  const [error, setError] = useState(''), [newName, setNewName] = useState<string>(), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null), root = state.projectDir;
  useEffect(() => { if (!root) return; const timer = setInterval(() => { if (!document.hidden) setRefresh(value => value + 1); }, 4000); return () => clearInterval(timer); }, [root]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const chooseProject = (directory: string) => { selectCreationProject(directory); setTrash(false); setDraftsOnly(false); setQuery(''); setNewName(undefined); setError(''); };
  const openProject = async () => {
    try { const directory = await window.cardbushDesktop?.pickProjectDirectory(); if (directory) chooseProject(directory); }
    catch (error) { setError(String((error as Error).message)); }
  };
  const createFile = async () => {
    if (!newName?.trim() || busy) return; setBusy(true); setError('');
    try {
      const path = /\.(md|markdown)$/i.test(newName.trim()) ? newName.trim() : newName.trim() + '.md';
      const file = await markdownFile({ action: 'create', rootPath: root, path, text: '' });
      if (file) { acceptCreationFile(file, root); setNewName(undefined); setRefresh(value => value + 1); onSelect?.(); }
    } catch (error) { setError(String((error as Error).message)); } finally { setBusy(false); }
  };
  const search = query.trim().toLowerCase();
  const pages = state.pages.filter(page => Boolean(page.archived) === trash && (!draftsOnly || page.temporary || !page.file) &&
    (!search || (bushItPageName(page, language) + ' ' + page.source).toLowerCase().includes(search))).sort((a, b) => b.updatedAt - a.updatedAt);
  const visiblePages = showAll || search || draftsOnly || trash ? pages : pages.slice(0, 7);
  const projects = state.projects.filter(path => !isCreationDraftDirectory(path));
  return <aside className={'sidebar bush-it-sidebar soft-panel-motion ' + (softVisible ? 'soft-panel-visible' : 'soft-panel-hidden')} aria-label={uiText(language)('appCenterModel.create')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
      <header className="creation-sidebar-heading"><h2>{uiText(language)('appCenterModel.create')}</h2>
        <button type="button" className="bush-sidebar-back" onClick={onBack} aria-label={uiText(language)('canvasSidebar.backToChats')} title={uiText(language)('canvasSidebar.backToChats')}><ArrowLeft size={16}/></button>
        <button type="button" aria-label={uiText(language)('bushItSidebar.searchDocuments')} aria-expanded={searchOpen} onClick={() => setSearchOpen(value => !value)}><Search size={16}/></button>
      </header>
      <button type="button" className="bush-new-page" onClick={() => { createBushItPage(); setTrash(false); setDraftsOnly(false); setQuery(''); onSelect?.(); }}><FilePlus2 size={16}/>{uiText(language)('bushItSidebar.newPage')}<kbd>{uiText()('bushItSidebar.ctrl_n')}</kbd></button>
      <nav className="creation-library-nav" aria-label={uiText(language)('bushItSidebar.documentLibrary')}>
        <button type="button" aria-current={!root && !trash && !draftsOnly ? 'page' : undefined} onClick={() => chooseProject('')}><Files size={16}/>{uiText(language)('bushItSidebar.allDocuments')}</button>
        <button type="button" aria-current={!root && !trash && draftsOnly ? 'page' : undefined} onClick={() => { chooseProject(''); setDraftsOnly(true); }}><StickyNote size={16}/>{uiText(language)('bushItSidebar.untitledDocuments')}</button>
        <button type="button" onClick={() => void openProject()}><FolderOpen size={16}/>{uiText(language)('conversationSearchDialog.openFolder')}</button>
      </nav>
      {searchOpen && <label className="bush-page-search"><Search size={14}/><input ref={searchRef} aria-label={(root ? uiText(language)('bushItSidebar.filterFilenames') : uiText(language)('bushItSidebar.searchPages'))} placeholder={uiText(language)('bushItSidebar.searchDocuments_5a1770c')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}/></label>}
      {error && <p role="alert" className="md-error">{error}</p>}
      <div className="creation-sidebar-library">
        {root ? <section className="creation-folder-section">
          <div className="creation-section-heading"><span title={root}><Folder size={14}/>{fileName(root)}</span>
            <button type="button" aria-label={uiText(language)('bushItSidebar.newMarkdown')} onClick={() => setNewName('')}><Plus size={14}/></button>
            <button type="button" aria-label={uiText(language)('bushItSidebar.refreshFiles')} onClick={() => { setError(''); setRefresh(value => value + 1); }}><RefreshCw size={13}/></button></div>
          {newName !== undefined && <form className="creation-new-file" onSubmit={event => { event.preventDefault(); void createFile(); }}><input autoFocus placeholder={uiText(language)('bushItSidebar.filenameMd')} aria-label={uiText(language)('bushItSidebar.newFilename')} value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setNewName(undefined); }}/><button disabled={busy || !newName.trim()}>{uiText(language)('gitBranchMenu.create')}</button></form>}
          <CreationFileTree key={root} root={root} language={language} selectedPath={state.pages.find(page => page.id === state.selectedId)?.file?.path} query={query} refresh={refresh} onSelect={onSelect} onError={setError}/>
        </section> : <section>
          <div className="creation-section-heading"><span>{trash ? uiText(language)('canvasSidebar.trash') : draftsOnly ? uiText(language)('bushItSidebar.untitledDocuments') : uiText(language)('canvasSidebar.recentlyUpdated')}</span></div>
          <div className="bush-page-list">{visiblePages.map(page => <div key={page.id} data-page-id={page.id} className={state.selectedId === page.id ? 'active' : ''}>
            <button type="button" disabled={trash} onClick={() => { selectBushItPage(page.id); onSelect?.(); }} title={page.temporary ? uiText(language)('bushItSidebar.untitledDocument') : page.file?.path || bushItPageName(page, language)}><FileText size={15}/><span>{bushItPageName(page, language)}</span>{(page.temporary || !page.file) && <i className="creation-draft-dot" aria-label={uiText(language)('bushItSidebar.untitledDocument')}/>}</button>
            <button type="button" aria-label={trash ? uiText(language)('bushItSidebar.restorePage') : uiText(language)('canvasSidebar.moveToTrash')} onClick={() => archiveBushItPage(page.id, !trash)}>{trash ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button>
          </div>)}{!pages.length && <p>{uiText(language)('bushItSidebar.noDocuments')}</p>}</div>
          {!showAll && !search && !draftsOnly && !trash && pages.length > visiblePages.length && <button type="button" className="creation-show-more" onClick={() => setShowAll(true)}><ChevronDown size={13}/>{uiText(language)('bushItSidebar.showMore')}</button>}
        </section>}
        <section className="creation-spaces"><div className="creation-section-heading"><span>{uiText(language)('bushItSidebar.spaces')}</span><button type="button" onClick={() => void openProject()} aria-label={uiText(language)('bushItSidebar.addFolder')}><Plus size={14}/></button></div>
          {projects.map(path => <button type="button" key={path} aria-current={root === path ? 'page' : undefined} title={path} onClick={() => chooseProject(path)}><Folder size={15}/><span>{fileName(path)}</span></button>)}
          {!projects.length && <p>{uiText(language)('bushItSidebar.openAFolderToOrganizeYourDocuments')}</p>}
        </section>
      </div>
      <button type="button" className="bush-trash-toggle" aria-pressed={trash} onClick={() => { if (root) chooseProject(''); setTrash(value => !value); setDraftsOnly(false); }}><Trash2 size={15}/>{trash ? uiText(language)('bushItSidebar.backToPages') : uiText(language)('canvasSidebar.trash')}</button>
    </div>
  </aside>;
}
