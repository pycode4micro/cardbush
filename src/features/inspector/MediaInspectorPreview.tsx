import { uiText } from '../../i18n';
import { useContext, useEffect, useRef, useState } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { basename, mediaResourceUrl } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import type { AppLanguage } from '../../types';
import { ImagePreviewDialog, type ImagePreviewSource } from '../chatMessages/ImagePreviewDialog';

export function MediaInspectorPreview({ kind, source: rawSource, path, name: displayName, language, onLoadingChange }: {
  kind: 'image' | 'video' | 'audio';
  source: string;
  path: string;
  name?: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const source = mediaResourceUrl(rawSource);
  const host = useContext(ConversationHostContext);
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<'load' | 'timeout' | null>(null);
  const [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  useEffect(() => setPreview(null), [path]);

  useEffect(() => {
    const media = containerRef.current?.querySelector('img, video, audio') as HTMLImageElement | HTMLMediaElement | null;
    if (!media) { onLoadingChange(false); return; }
    setError(null);
    onLoadingChange(true);
    const ready = () => {
      window.clearTimeout(timer);
      setError(null);
      onLoadingChange(false);
    };
    const fail = () => {
      window.clearTimeout(timer);
      setError('load');
      onLoadingChange(false);
    };
    // A missing readiness event must not leave the entire inspector behind a skeleton.
    const timer = window.setTimeout(() => {
      setError('timeout');
      onLoadingChange(false);
    }, 15000);
    media.addEventListener('load', ready);
    media.addEventListener('loadedmetadata', ready);
    media.addEventListener('error', fail);
    if (media instanceof HTMLImageElement) {
      if (media.complete) {
        if (media.naturalWidth > 0) ready();
        else fail();
      }
    } else if (media.error) fail();
    else if (media.readyState >= HTMLMediaElement.HAVE_METADATA) ready();
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener('load', ready);
      media.removeEventListener('loadedmetadata', ready);
      media.removeEventListener('error', fail);
      if (media instanceof HTMLMediaElement) media.pause();
    };
  }, [source, kind, revision, onLoadingChange]);

  const name = displayName || basename(path);
  return (
    <div className="inspector-media-preview" ref={containerRef}
      onContextMenu={host ? undefined : event => openFileContextMenu(event, path, { language })}>
      {!source ? <p role="status">{uiText(language)('inlineMedia.mediaAddressUnavailable')}</p> : kind === 'image' ? (
        <button type="button" className="inspector-image-open" aria-label={uiText(language)('mediaInspectorPreview.view', { name })}
          onClick={event => {
            const image = event.currentTarget.querySelector('img');
            setPreview({ src: source, path, name, naturalWidth: image?.naturalWidth, naturalHeight: image?.naturalHeight });
          }}><img key={revision} src={source} alt={name} decoding="async" /></button>
      ) : kind === 'video' ? (
        <video key={revision} src={source} controls playsInline preload="metadata" aria-label={name} />
      ) : (
        <audio key={revision} src={source} controls preload="metadata" aria-label={name} />
      )}
      {error && (
        <div className="inspector-media-error" role="alert">
          <p>{(error === 'timeout' ? uiText(language)('mediaInspectorPreview.mediaLoadingTimedOutPleaseRetry') : uiText(language)('mediaInspectorPreview.unableToPreviewMediaCheckThatThe'))}</p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            {uiText(language)('common.retry')}
          </button>
        </div>
      )}
      {preview && <ImagePreviewDialog image={preview} language={language} initialScope="directory" onClose={() => setPreview(null)} />}
    </div>
  );
}
