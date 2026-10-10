import { useState } from 'react';
import { ArrowLeft, FilePlus2, FileText, RotateCcw, Search, Trash2 } from 'lucide-react';
import { archiveBushItPage, bushItPageName, createBushItPage, selectBushItPage, useBushItPages } from './bushItPageStore';
import './bush-it-sidebar.css';

export function BushItSidebar({ language, onBack, onSelect, softVisible = true }: { language: 'zh' | 'en'; onBack?: () => void; onSelect?: () => void; softVisible?: boolean }) {
  const state = useBushItPages(), [query, setQuery] = useState(''), [trash, setTrash] = useState(false);
  const t = (cn: string, en: string) => language === 'zh' ? cn : en;
  const search = query.trim().toLowerCase();
  const pages = state.pages.filter(page => Boolean(page.archived) === trash && (!search || `${bushItPageName(page, language)} ${page.source}`.toLowerCase().includes(search))).sort((a, b) => b.updatedAt - a.updatedAt);
  return <aside className={`sidebar bush-it-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label={t('bush-it 页面', 'bush-it pages')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
    <button type="button" className="bush-sidebar-back" onClick={onBack}><ArrowLeft size={16}/>{t('返回对话', 'Back to chats')}</button>
    <h2>bush-it</h2><button type="button" className="bush-new-page" onClick={() => { createBushItPage(); setTrash(false); setQuery(''); onSelect?.(); }}><FilePlus2 size={17}/>{t('新建页面', 'New page')}</button>
    <label className="bush-page-search"><Search size={15}/><input aria-label={t('搜索页面', 'Search pages')} placeholder={t('搜索页面', 'Search pages')} value={query} onChange={event => setQuery(event.target.value)}/></label>
    <small>{trash ? t('回收站', 'Trash') : t('页面', 'Pages')}</small>
    <div className="bush-page-list">{pages.map(page => <div key={page.id} data-page-id={page.id} className={state.selectedId === page.id ? 'active' : ''}>
      <button type="button" disabled={trash} onClick={() => { selectBushItPage(page.id); onSelect?.(); }}><FileText size={16}/><span>{bushItPageName(page, language)}</span></button>
      <button type="button" aria-label={trash ? t('恢复页面', 'Restore page') : t('移至回收站', 'Move to trash')} onClick={() => archiveBushItPage(page.id, !trash)}>{trash ? <RotateCcw size={14}/> : <Trash2 size={14}/>}</button>
    </div>)}{!pages.length && <p>{t('暂无页面', 'No pages')}</p>}</div>
    <button type="button" className="bush-trash-toggle" aria-pressed={trash} onClick={() => setTrash(value => !value)}><Trash2 size={16}/>{trash ? t('返回页面', 'Back to pages') : t('回收站', 'Trash')}</button>
    </div>
  </aside>;
}
