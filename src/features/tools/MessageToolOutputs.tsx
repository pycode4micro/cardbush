import { memo, useEffect, useState } from 'react';
import { CircleAlert, PanelsTopLeft } from 'lucide-react';
import type { AppLanguage, ChatToolArtifact, ChatToolExecution } from '../../types';
import { fileUrl, isAbsoluteLocalPath } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { ImagePreviewDialog, type ImagePreviewSource } from '../chatMessages/ImagePreviewDialog';
import { LocalFileReferenceLink } from '../chatMessages/LocalFileReferenceLink';
import { mediaPresentationKey } from '../chatMessages/mediaPresentation';
import { McpAppPanel, mcpAppCommand } from './McpAppPanel';
import './message-tool-outputs.css';

type Interface = { sessionId: string; turnId: string; toolCallId: string; source: string; resourceUri: string; title?: string; serverTitle?: string; resultError?: { text: string; truncated: boolean } };
const interfaceKey = (view: Interface) => `${view.turnId}:${view.toolCallId}`;
const interfaceSourceKey = (view: Interface) => JSON.stringify([view.turnId, view.source, view.resourceUri]);
const sourceUrl = (path: string) => /^(?:https?:|data:|blob:)/i.test(path) ? path : fileUrl(path);

/** Only explicit artifacts and host-bound UI declarations are promoted out of tool logs. */
export function MessageToolOutputs({ sessionId, turnId, executions, artifacts, language }: {
  sessionId: string; turnId: string; executions: ChatToolExecution[]; artifacts: ChatToolArtifact[]; language: AppLanguage;
}) {
  const [interfaces, setInterfaces] = useState<Interface[]>([]), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const [selection, setSelection] = useState('');
  const zh = language === 'zh';
  const identities = JSON.stringify(executions.filter(execution => execution.state === 'completed' && (execution.name === 'mcp_call' || execution.name.startsWith('mcp__')))
    .map(execution => ({ turnId: execution.turnId ?? turnId, toolCallId: execution.id })));
  useEffect(() => {
    const ids = JSON.parse(identities) as Array<{ turnId: string; toolCallId: string }>;
    if (!sessionId || !ids.length) { setInterfaces([]); setError(''); return; }
    const controller = new AbortController();
    const groups = new Map<string, string[]>();
    for (const id of ids) if (id.turnId) groups.set(id.turnId, [...(groups.get(id.turnId) ?? []), id.toolCallId]);
    setError('');
    void Promise.all([...groups].map(async ([turnId, toolCallIds]) => {
      const result = await mcpAppCommand({ action: 'describe', sessionId, turnId, toolCallIds: [...new Set(toolCallIds)] }, controller.signal);
      return result.interfaces as Interface[];
    })).then(values => {
      if (controller.signal.aborted) return;
      const order = new Map(ids.map((id, index) => [`${id.turnId}:${id.toolCallId}`, index]));
      setInterfaces(values.flat().sort((a, b) => (order.get(interfaceKey(a)) ?? 0) - (order.get(interfaceKey(b)) ?? 0)));
    })
      .catch(cause => { if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => controller.abort();
  }, [sessionId, identities, retry]);
  // Failed attempts stay in the audit disclosure; they must not replace a
  // usable preview or keep a large error card mounted after a later success.
  const outputs = interfaces.filter(view => !view.resultError);
  const latestSuccess = new Map<string, number>();
  interfaces.forEach((view, index) => { if (!view.resultError) latestSuccess.set(interfaceSourceKey(view), index); });
  const failures = interfaces.flatMap((view, index) => view.resultError
    ? [{ view, followedBySuccess: (latestSuccess.get(interfaceSourceKey(view)) ?? -1) > index }] : []);
  const outstandingFailures = failures.filter(failure => !failure.followedBySuccess).length;
  const selected = outputs.find(view => interfaceKey(view) === selection) ?? outputs.at(-1);
  const label = (view: Interface) => view.title || view.serverTitle || (zh ? '插件界面' : 'Plugin interface');
  if (!artifacts.length && !interfaces.length && !error) return null;
  return <section className="message-tool-outputs" aria-label={language === 'zh' ? '工具输出' : 'Tool outputs'}>
    {artifacts.map(artifact => <MessageToolArtifact key={`${mediaPresentationKey(artifact.path)}:${artifact.id}`} artifact={artifact} language={language} />)}
    {selected && <section className="message-plugin-outputs" aria-label={zh ? '插件结果' : 'Plugin results'}>
      {outputs.length > 1 && <header className="message-plugin-outputs-heading">
        <span><PanelsTopLeft size={15} />{zh ? '插件结果' : 'Plugin results'}<small>{outputs.length}</small></span>
        <select aria-label={zh ? '选择插件结果' : 'Select plugin result'} value={outputs.some(view => interfaceKey(view) === selection) ? selection : ''} onChange={event => setSelection(event.target.value)}>
          <option value="">{zh ? '最新' : 'Latest'} · {label(outputs.at(-1)!)}</option>
          {outputs.map((view, index) => <option key={interfaceKey(view)} value={interfaceKey(view)}>{index + 1} · {label(view)}</option>)}
        </select>
      </header>}
      <McpAppPanel key={`${sessionId}:${interfaceKey(selected)}`} sessionId={sessionId} turnId={selected.turnId} toolCallId={selected.toolCallId} title={selected.title} serverTitle={selected.serverTitle} language={language} autoOpen />
    </section>}
    {!!failures.length && <details key={outstandingFailures ? 'outstanding' : 'history'} className="message-plugin-errors">
      <summary><CircleAlert size={14} /><span>{outstandingFailures
        ? (zh ? `${outstandingFailures} 次插件调用未成功` : `${outstandingFailures} unsuccessful plugin calls`)
        : (zh ? `${failures.length} 条先前失败记录` : `${failures.length} earlier failed attempts`)}</span></summary>
      {failures.map(({ view, followedBySuccess }) => <div className="mcp-app-tool-error" key={interfaceKey(view)}>
        <strong>{label(view)}</strong><small>{followedBySuccess
          ? (zh ? '同一工具后续调用已成功' : 'A later call to this tool succeeded')
          : (zh ? '本次调用未成功' : 'This call did not succeed')}</small>
        <pre>{view.resultError!.text || (zh ? '工具未提供错误详情。' : 'The tool did not provide error details.')}</pre>
        {view.resultError!.truncated && <small>{zh ? '完整返回可在工具详情中查看。' : 'The complete response is available in tool details.'}</small>}
      </div>)}
    </details>}
    {error && <div role="alert"><span>{language === 'zh' ? '无法读取插件界面信息' : 'Unable to read plugin interface information'}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{language === 'zh' ? '重试' : 'Retry'}</button><details><summary>{language === 'zh' ? '错误详情' : 'Details'}</summary>{error}</details></div>}
  </section>;
}

export const MessageToolArtifact = memo(function MessageToolArtifact({ artifact, language }: { artifact: ChatToolArtifact; language: AppLanguage }) {
  const [src, setSrc] = useState(() => sourceUrl(artifact.path)), [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  const local = isAbsoluteLocalPath(artifact.path) || /^file:/i.test(artifact.path);
  const loadFallback = async () => {
    if (local && artifact.type === 'image' && !src.startsWith('data:') && window.cardbushDesktop?.readImageDataUrl) {
      try { const data = await window.cardbushDesktop.readImageDataUrl(artifact.path); if (data.startsWith('data:image/')) { setSrc(data); return; } } catch { /* Show the failed preview with its original file link. */ }
    }
    setFailed(true);
  };
  const link = local ? <LocalFileReferenceLink path={artifact.path} knownFileName={artifact.name}>{artifact.name}</LocalFileReferenceLink>
    : <a href={artifact.path} target="_blank" rel="noreferrer">{artifact.name}</a>;
  const hasMediaPreview = !failed && artifact.display !== 'attachment' && ['image', 'video', 'audio'].includes(artifact.type);
  return <figure className={`message-tool-artifact${hasMediaPreview ? ' is-media' : ''}`} onContextMenu={event => openFileContextMenu(event, artifact.path, { language, image: artifact.type === 'image' })}>
    {hasMediaPreview && (artifact.type === 'image'
      ? <button type="button" className="message-tool-artifact-preview" onClick={event => {
        const thumbnail = event.currentTarget.querySelector('img');
        setPreview({ src, name: artifact.name, path: artifact.path,
          naturalWidth: thumbnail?.naturalWidth, naturalHeight: thumbnail?.naturalHeight });
      }} aria-label={language === 'zh' ? `查看 ${artifact.name}` : `View ${artifact.name}`}><img src={src} alt={artifact.name} onError={() => void loadFallback()} /></button>
      : artifact.type === 'video' ? <video controls preload="metadata" src={src} onError={() => setFailed(true)} />
        : artifact.type === 'audio' ? <audio controls preload="metadata" src={src} onError={() => setFailed(true)} /> : null)}
    {failed && <p role="status">{language === 'zh' ? '预览不可用，可打开原文件。' : 'Preview unavailable. Open the original file.'}</p>}
    {!hasMediaPreview && <figcaption>{link}{artifact.size !== undefined && <small>{formatSize(artifact.size)}</small>}</figcaption>}
    {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)} />}
  </figure>;
});

function formatSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
