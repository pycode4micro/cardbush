import { memo, useContext, useEffect, useState } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import type { AppLanguage, ChatToolArtifact } from '../../types';
import { isAbsoluteLocalPath } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { ImagePreviewDialog, type ImagePreviewSource } from '../chatMessages/ImagePreviewDialog';
import { LocalFileReferenceLink } from '../chatMessages/LocalFileReferenceLink';
import { InlineAudio, InlineVideo } from '../chatMessages/InlineMedia';
import { mediaPresentationKey } from '../chatMessages/mediaPresentation';

import './message-tool-outputs.css';

/** Only explicit file artifacts are promoted out of tool logs. Apps require authored links. */
export function MessageToolOutputs({ artifacts, language }: { artifacts: ChatToolArtifact[]; language: AppLanguage }) {
  if (!artifacts.length) return null;
  return <section className="message-tool-outputs" aria-label={language === 'zh' ? '工具输出' : 'Tool outputs'}>
    {artifacts.map(artifact => <MessageToolArtifact key={`${mediaPresentationKey(artifact.path)}:${artifact.id}`} artifact={artifact} language={language} />)}
  </section>;
}

export const MessageToolArtifact = memo(function MessageToolArtifact({ artifact, language }: { artifact: ChatToolArtifact; language: AppLanguage }) {
  const host = useContext(ConversationHostContext);
  const file = useConversationFileSource(artifact.path, artifact.display !== 'attachment' && ['image', 'video', 'audio'].includes(artifact.type));
  const [src, setSrc] = useState(file.source), [failed, setFailed] = useState(false);
  useEffect(() => { setSrc(file.source); setFailed(Boolean(file.error)); }, [file.source, file.error]);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  const local = isAbsoluteLocalPath(artifact.path) || /^file:/i.test(artifact.path);
  const loadFallback = async () => {
    if (!host && local && artifact.type === 'image' && !src.startsWith('data:') && window.cardbushDesktop?.readImageDataUrl) {
      try { const data = await window.cardbushDesktop.readImageDataUrl(artifact.path); if (data.startsWith('data:image/')) { setSrc(data); return; } } catch { /* Show the failed preview with its original file link. */ }
    }
    setFailed(true);
  };
  const link = host && local ? <button type="button" className="markdown-file-link" onClick={() => host.openFile(artifact.path)}>{artifact.name}</button>
    : local ? <LocalFileReferenceLink path={artifact.path} knownFileName={artifact.name}>{artifact.name}</LocalFileReferenceLink>
    : <a href={artifact.path} target="_blank" rel="noreferrer">{artifact.name}</a>;
  const hasMediaPreview = !failed && artifact.display !== 'attachment' && ['image', 'video', 'audio'].includes(artifact.type);
  return <figure className={`message-tool-artifact${hasMediaPreview ? ' is-media' : ''}`} onContextMenu={host ? undefined : event => openFileContextMenu(event, artifact.path, { language, image: artifact.type === 'image' })}>
    {hasMediaPreview && !src && <span role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</span>}
    {hasMediaPreview && src && (artifact.type === 'image'
      ? <button type="button" className="message-tool-artifact-preview" onClick={event => {
        const thumbnail = event.currentTarget.querySelector('img');
        setPreview({ src, name: artifact.name, path: artifact.path,
          naturalWidth: thumbnail?.naturalWidth, naturalHeight: thumbnail?.naturalHeight });
      }} aria-label={language === 'zh' ? `查看 ${artifact.name}` : `View ${artifact.name}`}><img src={src} alt={artifact.name} onError={() => void loadFallback()} /></button>
      : artifact.type === 'video' ? <InlineVideo src={src} onError={() => setFailed(true)} />
        : artifact.type === 'audio' ? <InlineAudio src={src} onError={() => setFailed(true)} /> : null)}
    {failed && <p role="status">{language === 'zh' ? '预览不可用，可打开原文件。' : 'Preview unavailable. Open the original file.'}</p>}
    {!hasMediaPreview && <figcaption>{link}{artifact.size !== undefined && <small>{formatSize(artifact.size)}</small>}</figcaption>}
    {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)} />}
  </figure>;
});

function formatSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
