import { uiText } from '../../i18n';
import { useContext, useState, type ReactNode } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { basename, isAudioPath, isImagePath, isVideoPath, resourceTargetKind } from '../../shared/localPaths';
import { InlineHtmlPreview, isHtmlPreviewPath } from './InlineHtmlPreview';
import { InlineAudio, InlineVideo } from './InlineMedia';
import type { AppLanguage } from '../../types';
import { MessageContentImage, useImageGalleryFallback } from './MessageImageGalleryFrame';
import { ImagePreviewDialog, type ImagePreviewSource } from './ImagePreviewDialog';

/** Authored remote references use the same viewers, but never resolve on this computer. */
export function ConversationFileReference({ path, children, inline = false, language, fileVersion }: {
  path: string; children?: ReactNode; inline?: boolean; language: AppLanguage; fileVersion?: string;
}) {
  const host = useContext(ConversationHostContext);
  const [failed, setFailed] = useState('');
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  const html = isHtmlPreviewPath(path);
  const media = inline && (isImagePath(path) || /\.svg$/i.test(path) || isVideoPath(path) || isAudioPath(path));
  const file = useConversationFileSource(path, Boolean(host && media), { revision: fileVersion });
  const label = children || basename(path);
  const kind = resourceTargetKind(path);
  useImageGalleryFallback(!inline || !(isImagePath(path) || /\.svg$/i.test(path)));
  if (kind !== 'local-file' && kind !== 'ssh-file') return <span>{label} · {uiText(language)('conversationFileReference.fileReferenceUnavailable')}</span>;
  if (host && inline && html) return <InlineHtmlPreview path={path} title={typeof label === 'string' ? label : basename(path)} language={language} fileVersion={fileVersion} />;
  if (media && file.source && failed !== file.source) {
    const props = { src: file.source, onError: () => setFailed(file.source), 'aria-label': typeof label === 'string' ? label : basename(path) };
    if (isVideoPath(path)) return <InlineVideo {...props} language={language} />;
    if (isAudioPath(path)) return <InlineAudio {...props} language={language} />;
    const open = () => setPreview({ src: file.source, path, name: props['aria-label'] });
    return <><MessageContentImage {...props} alt={props['aria-label']} role="button" tabIndex={0} onClick={open}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } }} />
      {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)}/>}</>;
  }
  return <span className="file-memo-reference">
    <button type="button" className="markdown-file-link" onClick={() => host?.openFile(path)}>{label}</button>
    {media && <small role="status">{file.error || failed ? (uiText(language)('conversationFileReference.previewUnavailableOpenTheFileToRetry')) : (uiText(language)('conversationFileReference.loading'))}</small>}
  </span>;
}
