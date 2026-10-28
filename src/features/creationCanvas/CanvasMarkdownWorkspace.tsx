import { uiText } from '../../i18n';
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
  snapshot: CanvasSnapshot; itemId: string; pageId: string; language: string; sessionId: string; root: string;
  team?: { id: string; revision: number }; onTeamSaved: (team: { id: string; revision: number }) => void;
  onSelect: (id: string) => void; onBack: () => void; onNewFile: (path: string) => void; onSelection: (selection: MarkdownSelection) => void;
  onKeepDraft: (source: string) => Promise<void>;
}) {
  const pages = useBushItPages(), page = pages.pages.find(item => item.id === pageId);

  return <div className="canvas-document-workspace">
    <nav className="canvas-document-tabs" aria-label={uiText(language)('canvasMarkdownWorkspace.canvasDocuments')}>
      <button type="button" onClick={onBack}><ArrowLeft size={15}/>{uiText(language)('canvasMarkdownWorkspace.canvas')}</button>
      {snapshot.document.items.filter(editableCanvasMarkdown).map(item => {
        const document = item.kind === 'file' ? pages.pages.find(page => page.file && sameFile(page.file.path, canvasFileTarget(item.source, snapshot.path))) : undefined;
        const title = document?.source.trim() ? bushItPageName(document, language) : item.title || (uiText(language)('canvasMarkdownWorkspace.untitledDocument'));
        return <button type="button" key={item.id} data-canvas-document-id={item.id} aria-current={item.id === itemId ? 'page' : undefined}
          title={title} onClick={() => onSelect(item.id)}><FileText size={14}/><span>{title}</span>{document?.file && document.source !== document.file.text && <span aria-label={uiText(language)('canvasMarkdownWorkspace.unsaved')}>·</span>}</button>;
      })}
    </nav>
    {pages.error && <p role="alert" className="md-error">{pages.error}</p>}
    <div className="canvas-document-editor"><Suspense fallback={<p role="status">{uiText(language)('canvasMarkdownWorkspace.openingDocument')}</p>}>
      {page && <DocumentPage key={page.id} page={page} language={language} root={root} sessionId={sessionId} embedded
        initialTeam={team} onTeamSaved={onTeamSaved} onNewFile={onNewFile} onSourceSelection={onSelection} onKeepDraft={onKeepDraft}
        onOpenTeam={id => {
          requestTeamDocument({ kind: 'select', id });
          window.dispatchEvent(new CustomEvent('cardbush-open-application', { detail: { id: 'builtin:team' } }));
        }}/>}
    </Suspense></div>
  </div>;
}
