import { ArrowLeft, FolderOpen, Plus, RotateCcw, Search, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { acceptCanvas, archiveCanvas, createCanvas, selectCanvas, useCanvases } from './canvasStore';
import '../mdPresentation/bush-it-sidebar.css';
import './creationCanvas.css';

export function CanvasSidebar({ language, onBack, onSelect, softVisible = true }: { language: 'zh' | 'en'; onBack: () => void; onSelect?: () => void; softVisible?: boolean }) {
  const state = useCanvases(), [query, setQuery] = useState(''), [search, setSearch] = useState(false), [trash, setTrash] = useState(false), [error, setError] = useState('');
  const t = (zh: string, en: string) => language === 'zh' ? zh : en;
  const open = async () => { try { const result = await window.cardbushDesktop?.creationCanvas({ action: 'open' }); if (result && 'document' in result) { acceptCanvas(result); setTrash(false); onSelect?.(); } setError(''); } catch (error) { setError(String((error as Error).message)); } };
  return <aside className={`sidebar bush-it-sidebar canvas-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label={t('创作', 'Create')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
      <header className="creation-sidebar-heading"><h2>{t('创作', 'Create')}</h2><button onClick={onBack} aria-label={t('返回对话', 'Back to chats')}><ArrowLeft size={16}/></button><button aria-label={t('搜索画板', 'Search canvases')} aria-expanded={search} onClick={() => setSearch(!search)}><Search size={16}/></button></header>
      <button className="bush-new-page" onClick={() => { createCanvas(); setTrash(false); setQuery(''); onSelect?.(); }}><Plus size={16}/>{t('新建画板', 'New canvas')}</button>
      <button className="bush-new-page" onClick={() => void open()}><FolderOpen size={16}/>{t('打开画板', 'Open canvas')}</button>
      {search && <label className="bush-page-search"><Search size={14}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索画板…', 'Search canvases…')} aria-label={t('搜索画板', 'Search canvases')}/></label>}
      {(error || state.error) && <p className="md-error" role="alert">{error || state.error}</p>}
      <div className="creation-sidebar-library"><div className="creation-section-heading">{trash ? t('回收站', 'Trash') : t('你的空间', 'Your spaces')}</div><div className="bush-page-list">
        {state.canvases.filter(item => !!item.archived === trash && item.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).map(item => <div key={item.id} className={item.id === state.selectedId && !trash ? 'active' : ''}>
          <button disabled={trash} onClick={() => { selectCanvas(item.id); onSelect?.(); }}><Square size={15}/><span>{item.title || t('无标题画板', 'Untitled canvas')}</span></button>
          <button onClick={() => archiveCanvas(item.id, !trash)} aria-label={trash ? t('恢复画板', 'Restore canvas') : t('移至回收站', 'Move to trash')}>{trash ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button>
        </div>)}
      </div></div>
      <button className="bush-trash-toggle" aria-pressed={trash} onClick={() => setTrash(!trash)}><Trash2 size={15}/>{trash ? t('返回画板', 'Back to canvases') : t('回收站', 'Trash')}</button>
    </div>
  </aside>;
}
