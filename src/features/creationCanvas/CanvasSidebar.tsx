import { uiText } from '../../i18n';
import { ArrowLeft, FolderOpen, Plus, RotateCcw, Search, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { acceptCanvas, archiveCanvas, createCanvas, selectCanvas, useCanvases } from './canvasStore';
import { AppCenterDock } from '../appCenter/AppCenter';
import { canvasErrorMessage } from './canvasErrors';
import '../mdPresentation/bush-it-sidebar.css';
import './creationCanvas.css';

export function CanvasSidebar({ language, onBack, onSelect, softVisible = true }: { language: string; onBack: () => void; onSelect?: () => void; softVisible?: boolean }) {
  const state = useCanvases(), [query, setQuery] = useState(''), [search, setSearch] = useState(false), [trash, setTrash] = useState(false), [error, setError] = useState('');

  const open = async () => { try { const result = await window.cardbushDesktop?.creationCanvas({ action: 'open' }); if (result && 'document' in result) { acceptCanvas(result); setTrash(false); onSelect?.(); } setError(''); } catch (error) { setError(String((error as Error).message)); } };
  return <aside className={`sidebar bush-it-sidebar canvas-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label={uiText(language)('appCenterModel.create')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
      <header className="creation-sidebar-heading"><h2>{uiText(language)('appCenterModel.create')}</h2><button onClick={onBack} aria-label={uiText(language)('canvasSidebar.backToChats')}><ArrowLeft size={16}/></button><button aria-label={uiText(language)('canvasSidebar.searchCanvases')} aria-expanded={search} onClick={() => setSearch(!search)}><Search size={16}/></button></header>
      <button className="bush-new-page" onClick={() => { createCanvas(); setTrash(false); setQuery(''); onSelect?.(); }}><Plus size={16}/>{uiText(language)('creationCanvasApp.newCanvas')}</button>
      {search && <label className="bush-page-search"><Search size={14}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={uiText(language)('canvasSidebar.searchCanvases_72ce883')} aria-label={uiText(language)('canvasSidebar.searchCanvases')}/></label>}
      {(error || state.error) && <p className="md-error" role="alert">{canvasErrorMessage(error || state.error, language)}</p>}
      <div className="creation-sidebar-library"><div className="creation-section-heading">{trash ? uiText(language)('canvasSidebar.trash') : uiText(language)('canvasSidebar.recentlyUpdated')}</div><div className="bush-page-list">
        {state.canvases.filter(item => !!item.archived === trash && item.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).map(item => <div key={item.id} className={item.id === state.selectedId && !trash ? 'active' : ''}>
          <button disabled={trash} onClick={() => { selectCanvas(item.id); onSelect?.(); }}><Square size={15}/><span>{item.title || uiText(language)('canvasSidebar.untitledCanvas')}</span></button>
          <button onClick={() => archiveCanvas(item.id, !trash)} aria-label={trash ? uiText(language)('canvasSidebar.restoreCanvas') : uiText(language)('canvasSidebar.moveToTrash')}>{trash ? <RotateCcw size={13}/> : <Trash2 size={13}/>}</button>
        </div>)}
      </div></div>
      <details className="canvas-sidebar-manage"><summary>{uiText(language)('canvasSidebar.more')}</summary>
        <button onClick={() => void open()}><FolderOpen size={16}/>{uiText(language)('canvasSidebar.openCanvas')}</button>
        <button aria-pressed={trash} onClick={() => setTrash(!trash)}><Trash2 size={15}/>{trash ? uiText(language)('canvasSidebar.backToCanvases') : uiText(language)('canvasSidebar.trash')}</button>
      </details>
      <div className="sidebar-footer"><AppCenterDock language={language}/></div>
    </div>
  </aside>;
}
