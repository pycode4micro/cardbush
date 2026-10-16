import { File as FileIcon } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { basename, isLocalFileResource } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { localImageUnavailable, recoverLocalImage as recoverImage, retryLocalImage } from '../../shared/localImageRecovery';
import type { AppLanguage } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { ImagePreviewDialog, type ImagePreviewSource } from './ImagePreviewDialog';
import { galleryImageKey } from './imageGallery';
import { MessageContentImage, MessageImageGalleryFrame } from './MessageImageGalleryFrame';

export type MessageGalleryImage = { path: string; name?: string };

export function MessageImageGallery({ images, language }: {
  images: MessageGalleryImage[];
  language: AppLanguage;
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
  return <>
    <MessageImageGalleryFrame language={language}>
      {uniqueImages.map(image => <MessageGalleryImageButton key={image.path} image={image} language={language} onPreview={setPreview} />)}
    </MessageImageGalleryFrame>
    {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)} />}
  </>;
}

function MessageGalleryImageButton({ image, language, onPreview }: {
  image: MessageGalleryImage;
  language: AppLanguage;
  onPreview: (image: ImagePreviewSource) => void;
}) {
  const host = useContext(ConversationHostContext);
  const pathValue = image.path;
  const name = image.name || basename(pathValue);
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
    className={`message-image-preview${unavailable ? ' is-failed' : ''}`}
    type="button" aria-label={name}
    onContextMenu={host ? undefined : event => openFileContextMenu(event, pathValue, { language })}
    onClick={event => {
      if (unavailable && !host) {
        retryLocalImage(pathValue); fallbackAttemptedRef.current = false; setFallbackSource(''); setFailed(false); return;
      }
      const element = event.currentTarget.querySelector('img');
      if (!unavailable && src) onPreview({ src, name, path: pathValue,
        naturalWidth: element?.naturalWidth, naturalHeight: element?.naturalHeight });
    }}
  >
    {unavailable ? <span className="message-image-preview-fallback">
      <FileIcon size={20} /><span>{host
        ? language === 'zh' ? '图片无法预览' : 'Preview unavailable'
        : language === 'zh' ? '图片不可用，点击重试' : 'Image unavailable. Retry'}</span>
    </span> : !src ? <span className="message-image-loading" role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</span>
      : <MessageContentImage src={src} alt={name} loading="lazy" decoding="async" onError={() => void recoverLocalImage()} />}
  </button>;
}
