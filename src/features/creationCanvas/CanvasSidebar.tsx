import { WindowBackTarget } from '../navigation/WindowBackTarget';
import { uiText } from '../../i18n';
import { Archive, FolderOpen, Plus, RotateCcw, Search, Square } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { openCanvasFile, archiveCanvas, createCanvas, selectCanvas, useCanvases } from './canvasStore';
import { ProfileMenu } from '../profile/ProfileMenu';
import { canvasErrorMessage } from './canvasErrors';
import './canvasSidebar.css';
import './creationCanvas.css';

export function CanvasSidebar({ language, onSelect, softVisible = true, workspaceNavigation, assistantEntry }: { language: string; onSelect?: () => void; softVisible?: boolean; workspaceNavigation?: ReactNode; assistantEntry?: ReactNode }) {
  const state = useCanvases(), [query, setQuery] = useState(''), [search, setSearch] = useState(false), [archived, setArchived] = useState(false), [error, setError] = useState('');

  const open = async () => { try { if (await openCanvasFile()) { setArchived(false); onSelect?.(); } setError(''); } catch (error) { setError(String((error as Error).message)); } };
  return <aside className={`sidebar bush-it-sidebar canvas-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label={uiText(language)('appCenterModel.create')}>
    <div className="sidebar-panel-content bush-pages-sidebar-content">
      {workspaceNavigation}
      <header className="creation-sidebar-heading"><h2>{uiText(language)('appCenterModel.create')}</h2><button aria-label={uiText(language)('canvasSidebar.searchCanvases')} aria-expanded={search} onClick={() => setSearch(!search)}><Search size={16}/></button></header>
      <button className="bush-new-page" onClick={() => { createCanvas(); setArchived(false); setQuery(''); onSelect?.(); }}><Plus size={16}/>{uiText(language)('creationCanvasApp.newCanvas')}</button>
      {search && <label className="bush-page-search"><Search size={14}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={uiText(language)('canvasSidebar.searchCanvases_72ce883')} aria-label={uiText(language)('canvasSidebar.searchCanvases')}/></label>}
      {(error || state.error) && <p className="md-error" role="alert">{canvasErrorMessage(error || state.error, language)}</p>}
      <div className="creation-sidebar-library"><div className="creation-section-heading">{archived ? uiText(language)('canvasSidebar.archived') : uiText(language)('canvasSidebar.recentlyUpdated')}</div><div className="bush-page-list">
        {state.canvases.filter(item => !!item.archived === archived && item.title.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt - a.updatedAt).map(item => <div key={item.id} className={item.id === state.selectedId && !archived ? 'active' : ''}>
          <button disabled={archived} onClick={() => { selectCanvas(item.id); onSelect?.(); }}><Square size={15}/><span>{item.title || uiText(language)('canvasSidebar.untitledCanvas')}</span></button>
          <button onClick={() => archiveCanvas(item.id, !archived)} aria-label={archived ? uiText(language)('canvasSidebar.restoreCanvas') : uiText(language)('canvasSidebar.archive')}>{archived ? <RotateCcw size={13}/> : <Archive size={13}/>}</button>
        </div>)}
      </div></div>
      {archived && softVisible && <WindowBackTarget onBack={() => setArchived(false)}/>}
      <details className="canvas-sidebar-manage"><summary>{uiText(language)('canvasSidebar.more')}</summary>
        <button onClick={() => void open()}><FolderOpen size={16}/>{uiText(language)('canvasSidebar.openCanvas')}</button>
        {!archived && <button onClick={() => setArchived(true)}><Archive size={15}/>{uiText(language)('canvasSidebar.archived')}</button>}
      </details>
      <div className="sidebar-footer">{assistantEntry}<ProfileMenu language={language}/></div>
    </div>
  </aside>;
}
