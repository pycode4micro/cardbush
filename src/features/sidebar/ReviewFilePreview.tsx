import { memo, useContext, useEffect, useState } from 'react';
import { ConversationHostContext, type ConversationHost } from '../conversationHost';
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
      {canShowSource && !host && <div className="review-preview-modes" role="group" aria-label={zh ? '文件显示方式' : 'File view'}>
        <button type="button" aria-pressed={!sourceMode} title={zh ? '预览' : 'Preview'} onClick={() => setSourceMode(false)}><Eye size={13} /><span>{zh ? '预览' : 'Preview'}</span></button>
        <button type="button" aria-pressed={sourceMode} title={zh ? '源码' : 'Source'} onClick={() => setSourceMode(true)}><Code size={13} /><span>{zh ? '源码' : 'Source'}</span></button>
      </div>}
      <button className="review-preview-reload" type="button" title={zh ? '刷新文件预览' : 'Reload file preview'} aria-label={zh ? '刷新文件预览' : 'Reload file preview'} onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} /></button>
    </div>
    {host ? <HostFilePreview key={`${path}:${revision}`} host={host} path={path} language={language}/> : sourceMode ? <DeferredResizePreview key={`source:${path}:${revision}`}>
      <SourceInspectorPreview path={path} language={language} onLoadingChange={ignoreLoading} />
    </DeferredResizePreview> : <InspectorWebview key={`${path}:${revision}`} identity={`review:${path}`}
      target={path} source={inspectorSource(path)} language={language}
      onNavigationStateChange={ignoreLoading} onOpenTarget={openTarget} />}
  </div>;
});

function HostFilePreview({ host, path, language }: { host: ConversationHost; path: string; language: AppLanguage }) {
  const [file, setFile] = useState<{ url: string; name: string; mime: string; text?: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let url = '';
    void (async () => {
      if (!host.readFile) throw new Error(language === 'zh' ? '请更新 Agent 服务以预览文件' : 'Update the Agent service to preview files');
      const { name, blob } = await host.readFile(path);
      const text = !/^(image|audio|video)\//.test(blob.type) && blob.size < 2 * 1024 * 1024 && /\.(txt|md|json|csv|log|[cm]?[jt]sx?|py|yaml|yml|toml|css|html|xml|sh|svg)$/i.test(name) ? await blob.text() : undefined;
      if (!alive) return;
      url = URL.createObjectURL(blob); setFile({ url, name, mime: blob.type, text });
    })().catch(error => { if (alive) setError(String(error.message ?? error)); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [host, path, language]);
  if (error) return <p role="alert">{error}</p>;
  if (!file) return <p role="status">{language === 'zh' ? '正在加载文件…' : 'Loading file…'}</p>;
  return <div className="agent-file-preview">{file.text !== undefined ? <pre>{file.text}</pre> : file.mime.startsWith('image/') ? <img src={file.url} alt={file.name}/> : file.mime.startsWith('video/') ? <video controls src={file.url}/> : file.mime.startsWith('audio/') ? <audio controls src={file.url}/> : null}<a href={file.url} download={file.name}>{language === 'zh' ? '下载' : 'Download'} {file.name}</a></div>;
}
