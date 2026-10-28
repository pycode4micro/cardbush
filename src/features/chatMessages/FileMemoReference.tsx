import { useUiLanguage } from '../../i18n/react';
import { uiText } from '../../i18n';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { parseFileMemoReference, type FileMemoResolution } from '@cardbush/bush-protocol';
import { fetchFileMemo } from '../../backend/fileMemo';
import { fileUrl, isImagePath, isVideoPath, isAudioPath, resourceTargetKind } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { InlineHtmlPreview, isHtmlPreviewPath } from './InlineHtmlPreview';
import { InlineAudio, InlineVideo } from './InlineMedia';
import { mediaPresentationKey, PresentedMediaContext } from './mediaPresentation';
import { FileMemoScopeContext } from './FileMemoScope';
import { ConversationHostContext } from '../conversationHost';
import { ConversationFileReference } from './ConversationFileReference';
import { MessageContentImage, useImageGalleryFallback } from './MessageImageGalleryFrame';

export function FileMemoReference({ reference, children, inline = false, language: selectedLanguage, load = fetchFileMemo }: {
  reference: string; children?: ReactNode; inline?: boolean; language?: string;
  load?: typeof fetchFileMemo;
}) {
  const inheritedLanguage = useUiLanguage();
  const language = selectedLanguage ?? inheritedLanguage;
  const presentedMedia = useContext(PresentedMediaContext);
  const host = useContext(ConversationHostContext);
  const { sessionId, turnId } = useContext(FileMemoScopeContext);
  const identity = parseFileMemoReference(reference);
  const fileName = identity && !('number' in identity) && typeof children === 'string' && /^[^\\/\r\n]+\.[a-z0-9]{1,12}$/i.test(children.trim()) ? children.trim() : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([host?.id, reference, sessionId, turnId, fileName, attempt]);
  const [state, setState] = useState<{ key: string; result?: FileMemoResolution; failed?: boolean }>();
  const [failedMedia, setFailedMedia] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void load(reference, controller.signal, { sessionId, turnId, fileName }, host?.runtime).then(result => {
        if (!controller.signal.aborted && current === revision) setState({ key, result });
      }, () => {
        if (!controller.signal.aborted && current === revision) setState({ key, failed: true });
      });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [reference, load, sessionId, turnId, fileName, key, host?.runtime]);
  const current = state?.key === key ? state : undefined;
  const resolvedFile = current?.result && current.result.status !== 'unresolved' ? current.result.memo.file.path : undefined;
  useImageGalleryFallback(Boolean(resolvedFile && !isImagePath(resolvedFile)));
  if (current?.failed || current?.result?.status === 'unresolved') {
    const reason = current.result?.status === 'unresolved' ? current.result.reason : undefined;
    const detail = current.failed
      ? uiText(language)('fileMemoReference.unableToLoadThisFileReferenceRight')
      : reason === 'missing_context'
        ? uiText(language)('fileMemoReference.openThisFileInItsOriginalConversation')
        : reason === 'ambiguous_reference' || reason === 'reference_mismatch'
          ? uiText(language)('fileMemoReference.theTargetFileIsUncertainAskThe')
          : uiText(language)('fileMemoReference.noFileRecordMatchesThisLinkAsk');
    return <span className="file-memo-reference file-memo-reference-error">
      <span>{children || (uiText(language)('fileMemoReference.fileLink'))}</span>
      <small role="status">{detail}</small>
      <button type="button" className="file-memo-retry" onClick={() => setAttempt(value => value + 1)}>{uiText(language)('common.retry')}</button>
    </span>;
  }
  if (!current?.result) return <span aria-busy="true">{children || (uiText(language)('fileMemoReference.loadingFile'))}</span>;
  const { memo, status, currentVersion } = current.result;
  const label = children || memo.file.name;
  const path = memo.file.path;
  const targetKind = resourceTargetKind(path);
  if (status === 'unavailable' || (targetKind !== 'local-file' && targetKind !== 'ssh-file')) return <span className="local-file-reference-unavailable">
    {label} · {uiText(language)('fileMemoReference.fileUnavailable')}
    {' '}<button type="button" className="file-memo-retry" onClick={() => setAttempt(value => value + 1)}>{uiText(language)('common.retry')}</button>
  </span>;
  const mediaKey = JSON.stringify([reference, sessionId, memo.file.size, memo.file.mtimeMs]);
  const html = isHtmlPreviewPath(path);
  // HTML embeds present the current local document, including later edits.
  // Only a new disk version reloads the guest; focus refreshes retain its state.
  const htmlVersion = currentVersion ? [currentVersion.size, currentVersion.mtimeMs] : [status, memo.file.size, memo.file.mtimeMs];
  const media = inline && (status === 'available' || html) && failedMedia !== mediaKey && !presentedMedia.has(mediaPresentationKey(path));
  if (host) return <span>
    <ConversationFileReference path={path} inline={media} language={language} fileVersion={JSON.stringify(htmlVersion)}>{label}</ConversationFileReference>
    {status === 'changed' && !(media && html) && <small role="status"> · {uiText(language)('fileMemoReference.fileChangedOpenTheCurrentVersion')}</small>}
  </span>;
  const source = fileUrl(path);
  return <span className="file-memo-reference">
    {media && html ? <InlineHtmlPreview key={path} path={path} fileVersion={JSON.stringify(htmlVersion)} title={typeof label === 'string' ? label : memo.file.name} language={language} />
      : media && isImagePath(path) ? <MessageContentImage src={source} alt={typeof children === 'string' ? children : memo.file.name}
      role="button" tabIndex={0}
      onError={() => setFailedMedia(mediaKey)}
      onClick={() => openInspector(path, memo.file.name)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.currentTarget.click(); } }}
      onContextMenu={event => openFileContextMenu(event, path, { language })} />
      : media && isVideoPath(path) ? <InlineVideo src={source} language={language} onError={() => setFailedMedia(mediaKey)} onContextMenu={event => openFileContextMenu(event, path, { language })} />
      : media && isAudioPath(path) ? <InlineAudio src={source} language={language} onError={() => setFailedMedia(mediaKey)} onContextMenu={event => openFileContextMenu(event, path, { language })} />
      : <LocalFileReferenceLink path={path} knownFileName={memo.file.name}>{label}</LocalFileReferenceLink>}
    {status === 'changed' && !(media && html) && <small role="status"> · {uiText(language)('fileMemoReference.fileChangedOpenTheCurrentVersion')}</small>}
    {status === 'available' && inline && failedMedia === mediaKey && <small role="status"> · {uiText(language)('fileMemoReference.previewUnavailableOpenTheFile')}</small>}
  </span>;
}
