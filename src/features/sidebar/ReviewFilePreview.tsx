import { uiText } from '../../i18n';
import { ConversationHostPreview } from '../inspector/ConversationHostPreview';
import { memo, useContext, useState } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { Code, Eye, RefreshCw } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { resolveFilePreview } from '../inspector/filePreviewRegistry';
import { InspectorWebview } from '../inspector/InspectorWebview';
import { inspectorSource } from '../inspector/inspectorTargets';
import { openInspector, type InspectorOpenDetail } from '../inspector/inspectorEvents';
import { SourceInspectorPreview } from '../inspector/TextInspectorPreview';
import { DeferredResizePreview } from '../inspector/DeferredResizePreview';

const openTarget = (detail: InspectorOpenDetail) => openInspector(detail.target, detail.title);
const ignoreLoading = () => {};

/** Use the same format registry and isolated guests as an ordinary file tab. */
export const ReviewFilePreview = memo(function ReviewFilePreview({ path, language, changed = false }: {
  path: string;
  language: AppLanguage;
  changed?: boolean;
}) {
  const [sourceMode, setSourceMode] = useState(false);
  const [revision, setRevision] = useState(0);
  const host = useContext(ConversationHostContext);
  const adapter = resolveFilePreview(path);
  const canShowSource = adapter?.id === 'html' || adapter?.id === 'markdown' || /\.svg$/i.test(path);

  return <div className="change-review-source-preview">
    <div className="change-review-preview-toolbar">
      <p className="change-review-source-note">{changed ? (uiText(language)('reviewFilePreview.currentFileContents'))
        : (uiText(language)('reviewFilePreview.unchangedInThisTurnCurrentContents'))}</p>
      {canShowSource && <div className="review-preview-modes" role="group" aria-label={uiText(language)('reviewFilePreview.fileView')}>
        <button type="button" aria-pressed={!sourceMode} title={uiText(language)('inlineHtmlPreview.preview')} onClick={() => setSourceMode(false)}><Eye size={13} /><span>{uiText(language)('inlineHtmlPreview.preview')}</span></button>
        <button type="button" aria-pressed={sourceMode} title={uiText(language)('reviewFilePreview.source')} onClick={() => setSourceMode(true)}><Code size={13} /><span>{uiText(language)('reviewFilePreview.source')}</span></button>
      </div>}
      <button className="review-preview-reload" type="button" title={uiText(language)('reviewFilePreview.reloadFilePreview')} aria-label={uiText(language)('reviewFilePreview.reloadFilePreview')} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} /></button>
    </div>
    {host ? <ConversationHostPreview key={`${path}:${revision}`} path={path} language={language} sourceMode={sourceMode}/> : sourceMode ? <DeferredResizePreview key={`source:${path}:${revision}`}>
      <SourceInspectorPreview path={path} language={language} onLoadingChange={ignoreLoading} />
    </DeferredResizePreview> : <InspectorWebview key={`${path}:${revision}`} identity={`review:${path}`}
      target={path} source={inspectorSource(path)} language={language}
      onNavigationStateChange={ignoreLoading} onOpenTarget={openTarget} />}
  </div>;
});
