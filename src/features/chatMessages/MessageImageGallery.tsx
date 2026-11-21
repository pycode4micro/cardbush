import { File as FileIcon } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { basename, isLocalFileResource, mediaResourceUrl } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { localImageUnavailable, recoverLocalImage as recoverImage, retryLocalImage } from '../../shared/localImageRecovery';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { ImagePreviewDialog, type ImagePreviewSource } from './ImagePreviewDialog';
import { galleryImageKey } from './imageGallery';
import { MessageContentImage, MessageImageGalleryFrame } from './MessageImageGalleryFrame';

export type MessageGalleryImage = { path: string; name?: string; id?: string };

export function MessageImageGallery({ images, language, thumbnails = false }: {
  images: MessageGalleryImage[];
  language: AppLanguage;
  thumbnails?: boolean;
}) {
  const uniqueImages = useMemo(() => {
    const seen = new Set<string>();
    return images.filter(image => {
      const key = galleryImageKey({ src: image.path, path: image.path, name: image.name ?? '' });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [images]);
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  if (!uniqueImages.length) return null;
  const buttons = uniqueImages.map(image => <MessageGalleryImageButton key={image.id ?? image.path}
    image={image} language={language} compact={thumbnails} draggable onPreview={setPreview} />);
  return <>
    {thumbnails
      ? <div className="message-image-thumbnails" role="group" aria-label={uiText(language)('image.gallery')}>{buttons}</div>
      : <MessageImageGalleryFrame language={language}>{buttons}</MessageImageGalleryFrame>}
    {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)} />}
  </>;
}

export function MessageGalleryImageButton({ image, language, onPreview, compact = false, draggable = !compact }: {
  image: MessageGalleryImage;
  language: AppLanguage;
  onPreview: (image: ImagePreviewSource) => void;
  compact?: boolean;
  draggable?: boolean;
}) {
  const host = useContext(ConversationHostContext);
  const t = uiText(language);
  const name = image.name || basename(image.path);
  const [paintedPath, setPaintedPath] = useState(image.path);
  const keepLocalPreview = Boolean(image.id && !host && isLocalFileResource(image.path) && isLocalFileResource(paintedPath));
  const pathValue = keepLocalPreview ? paintedPath : image.path;
  useEffect(() => {
    if (!keepLocalPreview || paintedPath === image.path) return;
    // The journal can move an attachment to a retained copy. Keep displaying
    // the old pixels until the replacement has decoded in this renderer.
    let disposed = false;
    const replacement = new Image();
    replacement.src = mediaResourceUrl(image.path);
    const replace = () => { if (!disposed) setPaintedPath(image.path); };
    void replacement.decode().then(replace, replace);
    return () => { disposed = true; };
  }, [image.path, keepLocalPreview, paintedPath]);
  const source = useConversationFileSource(pathValue);
  const [fallbackSource, setFallbackSource] = useState('');
  const [failed, setFailed] = useState(() => !host && localImageUnavailable(pathValue));
  const fallbackAttemptedRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    fallbackAttemptedRef.current = false;
    setFallbackSource('');
    setFailed(!host && localImageUnavailable(pathValue));
    return () => { generation.current += 1; };
  }, [host, pathValue, source.source]);
  const recoverLocalImage = useCallback(async () => {
    if (host || fallbackAttemptedRef.current || !isLocalFileResource(pathValue) || !window.cardbushDesktop?.readImageDataUrl) {
      setFailed(true);
      return;
    }
    fallbackAttemptedRef.current = true;
    const current = generation.current;
    try {
      const dataUrl = await recoverImage(pathValue, window.cardbushDesktop.readImageDataUrl);
      if (generation.current !== current) return;
      if (dataUrl.startsWith('data:image/')) setFallbackSource(dataUrl);
      else setFailed(true);
    } catch {
      if (generation.current === current) setFailed(true);
    }
  }, [host, pathValue]);
  const src = fallbackSource || source.source;
  const unavailable = failed || Boolean(source.error);
  return <button
    className={['message-image-preview', compact && 'is-thumbnail', unavailable && 'is-failed'].filter(Boolean).join(' ')}
    type="button" aria-label={name}
    title={unavailable ? t('image.unavailableTitle', { name }) : name}
    onContextMenu={host ? undefined : event => openFileContextMenu(event, image.path, { language })}
    onClick={event => {
      if (unavailable && !host) {
        retryLocalImage(pathValue); fallbackAttemptedRef.current = false; setFallbackSource(''); setFailed(false); return;
      }
      const element = event.currentTarget.querySelector('img');
      if (!unavailable && src) onPreview({ src, name, path: image.path,
        naturalWidth: element?.naturalWidth, naturalHeight: element?.naturalHeight });
    }}
  >
    {unavailable ? <span className="message-image-preview-fallback">
      <FileIcon className="message-image-fallback-icon" /><span>{t(host ? 'image.unavailable' : 'image.retry')}</span>
    </span> : !src ? <span className="message-image-loading" role="status" aria-label={t('common.loading')}>
      <span className="message-image-loading-label" aria-hidden="true">{t('common.loading')}</span>
      <span className="message-image-loading-compact" aria-hidden="true">{t('common.loadingCompact')}</span></span>
      : <MessageContentImage src={src} alt={name} loading="lazy" decoding="async" draggable={draggable} onError={() => void recoverLocalImage()} />}
  </button>;
}
