import { lazy, Suspense } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import type { CanvasSnapshot } from '@cardbush/bush-protocol';
import { bushItPageName, useBushItPages } from '../mdPresentation/bushItPageStore';
import { sameFile } from '../mdPresentation/creationFiles';
import type { MarkdownSelection } from '../mdPresentation/MarkdownSourceEditor';
import { canvasFileTarget, editableCanvasMarkdown } from './canvasModel';
import { requestTeamDocument } from '../team/teamWorkspaceNavigation';

const DocumentPage = lazy(() => import('../mdPresentation/MdPresentationApp').then(module => ({ default: module.BushItDocumentPage })));

/** File editing keeps the existing drafts, autosave, conflict handling and source editor. */
export function CanvasMarkdownWorkspace({ snapshot, itemId, pageId, language, sessionId, root, team, onTeamSaved, onSelect, onBack, onNewFile, onSelection, onKeepDraft }: {
  snapshot: CanvasSnapshot; itemId: string; pageId: string; language: 'zh' | 'en'; sessionId: string; root: string;
  team?: { id: string; revision: number }; onTeamSaved: (team: { id: string; revision: number }) => void;
  onSelect: (id: string) => void; onBack: () => void; onNewFile: (path: string) => void; onSelection: (selection: MarkdownSelection) => void;
  onKeepDraft: (source: string) => Promise<void>;
}) {
  const pages = useBushItPages(), page = pages.pages.find(item => item.id === pageId);
  const zh = language === 'zh';
  return <div className="canvas-document-workspace">
    <nav className="canvas-document-tabs" aria-label={zh ? '画板文档' : 'Canvas documents'}>
      <button type="button" onClick={onBack}><ArrowLeft size={15}/>{zh ? '画板' : 'Canvas'}</button>
      {snapshot.document.items.filter(editableCanvasMarkdown).map(item => {
        const document = item.kind === 'file' ? pages.pages.find(page => page.file && sameFile(page.file.path, canvasFileTarget(item.source, snapshot.path))) : undefined;
        const title = document?.source.trim() ? bushItPageName(document, language) : item.title || (zh ? '未命名文档' : 'Untitled document');
        return <button type="button" key={item.id} data-canvas-document-id={item.id} aria-current={item.id === itemId ? 'page' : undefined}
          title={title} onClick={() => onSelect(item.id)}><FileText size={14}/><span>{title}</span>{document?.file && document.source !== document.file.text && <span aria-label={zh ? '待保存' : 'Unsaved'}>·</span>}</button>;
      })}
    </nav>
    {pages.error && <p role="alert" className="md-error">{pages.error}</p>}
    <div className="canvas-document-editor"><Suspense fallback={<p role="status">{zh ? '正在打开文档…' : 'Opening document…'}</p>}>
      {page && <DocumentPage key={page.id} page={page} language={language} root={root} sessionId={sessionId} embedded
        initialTeam={team} onTeamSaved={onTeamSaved} onNewFile={onNewFile} onSourceSelection={onSelection} onKeepDraft={onKeepDraft}
        onOpenTeam={id => {
          requestTeamDocument({ kind: 'select', id });
          window.dispatchEvent(new CustomEvent('cardbush-open-application', { detail: { id: 'builtin:team' } }));
        }}/>}
    </Suspense></div>
  </div>;
}
