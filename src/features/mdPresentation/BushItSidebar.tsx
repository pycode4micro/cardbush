import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, FilePlus2, FileText, Files, Folder, FolderOpen, Plus, RefreshCw, RotateCcw, Search, StickyNote, Trash2 } from 'lucide-react';
import { archiveBushItPage, bushItPageName, createBushItPage, isCreationDraftDirectory, selectBushItPage, selectCreationProject, useBushItPages } from './bushItPageStore';
import { CreationFileTree } from './CreationFileTree';
import { acceptCreationFile, fileName, markdownFile } from './creationFiles';
import './bush-it-sidebar.css';

export function BushItSidebar({ language, onBack, onSelect, softVisible = true }: { language: 'zh' | 'en'; onBack?: () => void; onSelect?: () => void; softVisible?: boolean }) {
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
  const t = (cn: string, en: string) => language === 'zh' ? cn : en, search = query.trim().toLowerCase();
  const pages = state.pages.filter(page => Boolean(page.archived) === trash && (!draftsOnly || page.temporary || !page.file) &&
    (!search || (bushItPageName(page, language) + ' ' + page.source).toLowerCase().includes(search))).sort((a, b) => b.updatedAt - a.updatedAt);
  const visiblePages = showAll || search || draftsOnly || trash ? pages : pages.slice(0, 7);
  const projects = state.projects.filter(path => !isCreationDraftDirectory(path));
  return <aside className={'sidebar bush-it-sidebar soft-panel-motion ' + (softVisible ? 'soft-panel-visible' : 'soft-panel-hidden')} aria-label={t('创作', 'Create')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
      <header className="creation-sidebar-heading"><h2>{t('创作', 'Create')}</h2>
        <button type="button" className="bush-sidebar-back" onClick={onBack} aria-label={t('返回对话', 'Back to chats')} title={t('返回对话', 'Back to chats')}><ArrowLeft size={16}/></button>
        <button type="button" aria-label={t('搜索文档', 'Search documents')} aria-expanded={searchOpen} onClick={() => setSearchOpen(value => !value)}><Search size={16}/></button>
      </header>
      <button type="button" className="bush-new-page" onClick={() => { createBushItPage(); setTrash(false); setDraftsOnly(false); setQuery(''); onSelect?.(); }}><FilePlus2 size={16}/>{t('新建页面', 'New page')}<kbd>Ctrl+N</kbd></button>
      <nav className="creation-library-nav" aria-label={t('文档分类', 'Document library')}>
        <button type="button" aria-current={!root && !trash && !draftsOnly ? 'page' : undefined} onClick={() => chooseProject('')}><Files size={16}/>{t('全部文档', 'All documents')}</button>
        <button type="button" aria-current={!root && !trash && draftsOnly ? 'page' : undefined} onClick={() => { chooseProject(''); setDraftsOnly(true); }}><StickyNote size={16}/>{t('临时文档', 'Untitled documents')}</button>
        <button type="button" onClick={() => void openProject()}><FolderOpen size={16}/>{t('打开文件夹', 'Open folder')}</button>
      </nav>
      {searchOpen && <label className="bush-page-search"><Search size={14}/><input ref={searchRef} aria-label={t(root ? '筛选文件名' : '搜索页面', root ? 'Filter filenames' : 'Search pages')} placeholder={t('搜索文档…', 'Search documents…')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}/></label>}
      {error && <p role="alert" className="md-error">{error}</p>}
      <div className="creation-sidebar-library">
        {root ? <section className="creation-folder-section">
          <div className="creation-section-heading"><span title={root}><Folder size={14}/>{fileName(root)}</span>
            <button type="button" aria-label={t('新建 Markdown', 'New Markdown')} onClick={() => setNewName('')}><Plus size={14}/></button>
            <button type="button" aria-label={t('刷新文件', 'Refresh files')} onClick={() => { setError(''); setRefresh(value => value + 1); }}><RefreshCw size={13}/></button></div>
          {newName !== undefined && <form className="creation-new-file" onSubmit={event => { event.preventDefault(); void createFile(); }}><input autoFocus placeholder={t('文件名.md', 'filename.md')} aria-label={t('新文件名', 'New filename')} value={newName} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setNewName(undefined); }}/><button disabled={busy || !newName.trim()}>{t('创建', 'Create')}</button></form>}
          <CreationFileTree key={root} root={root} language={language} selectedPath={state.pages.find(page => page.id === state.selectedId)?.file?.path} query={query} refresh={refresh} onSelect={onSelect} onError={setError}/>
        </section> : <section>
          <div className="creation-section-heading"><span>{trash ? t('回收站', 'Trash') : draftsOnly ? t('临时文档', 'Untitled documents') : t('最近更新', 'Recently updated')}</span></div>
          <div className="bush-page-list">{visiblePages.map(page => <div key={page.id} data-page-id={page.id} className={state.selectedId === page.id ? 'active' : ''}>
            <button type="button" disabled={trash} onClick={() => { selectBushItPage(page.id); onSelect?.(); }} title={page.temporary ? t('临时文档', 'Untitled document') : page.file?.path || bushItPageName(page, language)}><FileText size={15}/><span>{bushItPageName(page, language)}</span>{(page.temporary || !page.file) && <i className="creation-draft-dot" aria-label={t('临时文档', 'Untitled document')}/>}</button>
            <button type="button" aria-label={trash ? t('恢复页面', 'Restore page') : t('移至回收站', 'Move to trash')} onClick={() => archiveBushItPage(page.id, !trash)}>{trash ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button>
          </div>)}{!pages.length && <p>{t('暂无文档', 'No documents')}</p>}</div>
          {!showAll && !search && !draftsOnly && !trash && pages.length > visiblePages.length && <button type="button" className="creation-show-more" onClick={() => setShowAll(true)}><ChevronDown size={13}/>{t('展开显示', 'Show more')}</button>}
        </section>}
        <section className="creation-spaces"><div className="creation-section-heading"><span>{t('空间', 'Spaces')}</span><button type="button" onClick={() => void openProject()} aria-label={t('添加文件夹', 'Add folder')}><Plus size={14}/></button></div>
          {projects.map(path => <button type="button" key={path} aria-current={root === path ? 'page' : undefined} title={path} onClick={() => chooseProject(path)}><Folder size={15}/><span>{fileName(path)}</span></button>)}
          {!projects.length && <p>{t('打开文件夹，组织项目文档', 'Open a folder to organize your documents')}</p>}
        </section>
      </div>
      <button type="button" className="bush-trash-toggle" aria-pressed={trash} onClick={() => { if (root) chooseProject(''); setTrash(value => !value); setDraftsOnly(false); }}><Trash2 size={15}/>{trash ? t('返回页面', 'Back to pages') : t('回收站', 'Trash')}</button>
    </div>
  </aside>;
}
