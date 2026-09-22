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
  const zh = language === 'zh';
  return <div className="change-review-source-preview">
    <div className="change-review-preview-toolbar">
      <p className="change-review-source-note">{changed ? (zh ? '当前文件内容' : 'Current file contents')
        : (zh ? '所选轮次未修改此文件 · 当前内容' : 'Unchanged in this turn · Current contents')}</p>
      {canShowSource && <div className="review-preview-modes" role="group" aria-label={zh ? '文件显示方式' : 'File view'}>
        <button type="button" aria-pressed={!sourceMode} title={zh ? '预览' : 'Preview'} onClick={() => setSourceMode(false)}><Eye size={13} /><span>{zh ? '预览' : 'Preview'}</span></button>
        <button type="button" aria-pressed={sourceMode} title={zh ? '源码' : 'Source'} onClick={() => setSourceMode(true)}><Code size={13} /><span>{zh ? '源码' : 'Source'}</span></button>
      </div>}
      <button className="review-preview-reload" type="button" title={zh ? '刷新文件预览' : 'Reload file preview'} aria-label={zh ? '刷新文件预览' : 'Reload file preview'} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} /></button>
    </div>
    {host ? <ConversationHostPreview key={`${path}:${revision}`} path={path} language={language} sourceMode={sourceMode}/> : sourceMode ? <DeferredResizePreview key={`source:${path}:${revision}`}>
      <SourceInspectorPreview path={path} language={language} onLoadingChange={ignoreLoading} />
    </DeferredResizePreview> : <InspectorWebview key={`${path}:${revision}`} identity={`review:${path}`}
      target={path} source={inspectorSource(path)} language={language}
      onNavigationStateChange={ignoreLoading} onOpenTarget={openTarget} />}
  </div>;
});
