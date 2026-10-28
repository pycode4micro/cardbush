import { uiText } from '../../i18n';
import { useCallback, useContext, useEffect, useState } from 'react';
import { ConversationHostContext } from '../conversationHost';
import type { AppLanguage } from '../../types';
import { resolveFilePreview } from './filePreviewRegistry';
import { inspectorFilePreviewRenderers } from './inspectorFilePreviewRenderers';
import { SourceInspectorPreview } from './TextInspectorPreview';
import { InlineHtmlPreview } from '../chatMessages/InlineHtmlPreview';

/** The ordinary preview renderers receive bytes from the selected host. */
export function ConversationHostPreview({ path, language, sourceMode = false }: { path: string; language: AppLanguage; sourceMode?: boolean }) {
  const host = useContext(ConversationHostContext);
  const [file, setFile] = useState<{ name: string; source: string }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const ignoreLoading = useCallback(() => {}, []);
  const adapter = resolveFilePreview(path);
  const html = adapter?.id === 'html' && !sourceMode;
  useEffect(() => {
    let alive = true; let source = '';
    setFile(undefined); setError('');
    if (html) return;
    if (host?.readFile) void host.readFile(path).then(({ name, blob }) => {
      if (!alive) return;
      source = URL.createObjectURL(blob); setFile({ name, source });
    }).catch(error => { if (alive) setError(String(error.message ?? error)); });
    return () => { alive = false; if (source) URL.revokeObjectURL(source); };
  }, [host?.readFile, path, html, attempt]);
  if (html) return <div className="conversation-host-preview">
    <InlineHtmlPreview key={path} path={path} language={language}/>
    <button type="button" className="conversation-file-download" onClick={async () => {
      try {
        if (!host?.readFile) return;
        const { name, blob } = await host.readFile(path);
        const source = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = source; link.download = name; link.click();
        window.setTimeout(() => URL.revokeObjectURL(source), 1000);
        setError('');
      } catch (error) { setError(String(error)); }
    }}>{uiText(language)('conversationHostPreview.downloadHtml')}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
  if (error) return <p role="alert">{error} <button type="button" onClick={() => setAttempt(value => value + 1)}>{uiText(language)('common.retry')}</button></p>;
  if (!file) return <p role="status">{uiText(language)('conversationHostPreview.loadingFile')}</p>;
  const Renderer = sourceMode ? SourceInspectorPreview : adapter && adapter.renderer !== 'webview' ? inspectorFilePreviewRenderers[adapter.renderer] : null;
  return <div className="conversation-host-preview">
    {Renderer ? <Renderer path={path} source={file.source} language={language} onLoadingChange={ignoreLoading}/>
      : adapter?.id === 'pdf' ? <iframe title={file.name} src={file.source} className="inspector-pdf-preview"/>
      : <p>{uiText(language)('conversationHostPreview.downloadThisFileToViewIt')}</p>}
    <a href={file.source} download={file.name}>{uiText(language)('turnArtifactsMenu.download')} {file.name}</a>
  </div>;
}
