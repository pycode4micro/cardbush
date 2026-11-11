import { ChevronDown, FilePlus2, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { uiText } from '../../i18n';
import { basename } from '../../shared/localPaths';
import type { CanvasEntry } from './canvasStore';

export function CanvasLibraryView({ language, canvases, error, onNew, onOpen, onSelect }: {
  language: string; canvases: CanvasEntry[]; error: string; onNew: () => void; onOpen: () => void; onSelect: (id: string) => void;
}) {
  const t = uiText(language);
  const recent = canvases.filter(item => !item.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  return <div className="creation-canvas-app"><section className="canvas-library">
    <div className="canvas-library-actions">
      <button onClick={onNew}><Plus/>{t('creationCanvasApp.newCanvas')}</button>
      <button onClick={onOpen}><FolderOpen/>{t('canvasSidebar.openCanvas')}</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {recent.length > 0 && <section aria-label={t('canvasSidebar.recentlyUpdated')}>
      <h2>{t('canvasSidebar.recentlyUpdated')}</h2>
      {recent.map(item => <button className="canvas-library-entry" key={item.id} title={item.path}
        onClick={() => onSelect(item.id)}>{item.title || t('canvasSidebar.untitledCanvas')}</button>)}
    </section>}
  </section></div>;
}

export function CanvasFileMenu({ language, open, setOpen, busy, path, onNew, onOpen, onClose, onDelete, children }: {
  language: string; open: boolean; setOpen: (open: boolean) => void; busy: boolean; path?: string;
  onNew: () => void; onOpen: () => void; onClose: () => void; onDelete: () => void; children: ReactNode;
}) {
  const t = uiText(language);
  return <div className="canvas-menu-wrap" onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.stopPropagation(); setOpen(false); event.currentTarget.querySelector('button')?.focus();
    }
  }}>
    <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{t('canvasFiles.menu')}<ChevronDown/></button>
    {open && <>
      <button className="canvas-menu-dismiss" aria-label={t('creationCanvasApp.closeMenu')} onClick={() => setOpen(false)}/>
      <div className="canvas-menu" role="menu" aria-label={t('canvasFiles.menu')}>
        {path && <small className="canvas-menu-filename" title={path}>{basename(path)}</small>}
        <button role="menuitem" disabled={busy} onClick={onNew}><FilePlus2/>{t('creationCanvasApp.newCanvas')}</button>
        <button role="menuitem" disabled={busy} onClick={onOpen}><FolderOpen/>{t('canvasSidebar.openCanvas')}</button>
        <button role="menuitem" disabled={busy} onClick={onClose}><X/>{t('canvasFiles.close')}</button>
        <button role="menuitem" disabled={busy || !path} onClick={onDelete}><Trash2/>{t('canvasFiles.delete')}</button>
        <hr/>
        {children}
      </div>
    </>}
  </div>;
}
