import { File as FileIcon } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { basename, isLocalFileResource } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import type { AppLanguage } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { ImagePreviewDialog, type ImagePreviewSource } from './ImagePreviewDialog';
import { galleryImageKey } from './imageGallery';

export type MessageGalleryImage = { path: string; name?: string };

export function MessageImageGallery({ images, language, inline = false }: {
  images: MessageGalleryImage[];
  language: AppLanguage;
  inline?: boolean;
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
  const [selectedPath, setSelectedPath] = useState('');
  const [preview, setPreview] = useState<ImagePreviewSource | null>(null);
  const selected = uniqueImages.find(image => image.path === selectedPath) ?? uniqueImages[0];
  const thumbnailRefs = useRef<(HTMLButtonElement | null)[]>([]);
  if (!selected) return null;
  const multiple = uniqueImages.length > 1;
  const Container = inline ? 'span' : 'div';
  return <Container className={`message-image-gallery${multiple ? ' has-thumbnails' : ''}`}>
    <MessageGalleryImageButton key={selected.path} image={selected} language={language} onPreview={setPreview} />
    {multiple && <span className="message-image-thumbnails" role="group" aria-label={language === 'zh' ? '切换图片' : 'Choose image'}>
      {uniqueImages.map((image, index) => <MessageGalleryImageButton
        key={image.path} image={image} language={language} thumbnail
        selected={image === selected}
        buttonRef={element => { thumbnailRefs.current[index] = element; }}
        onSelect={() => setSelectedPath(image.path)}
        onNavigate={key => {
          const next = key === 'Home' ? 0 : key === 'End' ? uniqueImages.length - 1
            : (index + (key === 'ArrowUp' ? -1 : 1) + uniqueImages.length) % uniqueImages.length;
          setSelectedPath(uniqueImages[next].path);
          thumbnailRefs.current[next]?.focus();
        }}
      />)}
    </span>}
    {preview && <ImagePreviewDialog image={preview} language={language} onClose={() => setPreview(null)} />}
  </Container>;
}

function MessageGalleryImageButton({ image, language, thumbnail = false, selected, buttonRef,
  onPreview, onSelect, onNavigate }: {
  image: MessageGalleryImage;
  language: AppLanguage;
  thumbnail?: boolean;
  selected?: boolean;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  onPreview?: (image: ImagePreviewSource) => void;
  onSelect?: () => void;
  onNavigate?: (key: string) => void;
}) {
  const host = useContext(ConversationHostContext);
  const pathValue = image.path;
  const name = image.name || basename(pathValue);
  const source = useConversationFileSource(pathValue);
  const [fallbackSource, setFallbackSource] = useState('');
  const [failed, setFailed] = useState(false);
  const fallbackAttemptedRef = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    fallbackAttemptedRef.current = false;
    setFallbackSource('');
    setFailed(false);
    return () => { generation.current += 1; };
  }, [pathValue, source.source]);
  const recoverLocalImage = useCallback(async () => {
    if (host || fallbackAttemptedRef.current || !isLocalFileResource(pathValue) || !window.cardbushDesktop?.readImageDataUrl) {
      setFailed(true);
      return;
    }
    fallbackAttemptedRef.current = true;
    const current = generation.current;
    try {
      const dataUrl = await window.cardbushDesktop.readImageDataUrl(pathValue);
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
    ref={buttonRef}
    className={`${thumbnail ? 'message-image-thumbnail' : 'message-image-preview'}${unavailable ? ' is-failed' : ''}`}
    type="button" aria-label={name} aria-pressed={thumbnail ? selected : undefined}
    onContextMenu={host ? undefined : event => openFileContextMenu(event, pathValue, { image: true, language })}
    onClick={event => {
      if (thumbnail) { onSelect?.(); return; }
      const element = event.currentTarget.querySelector('img');
      if (!unavailable && src) onPreview?.({ src, name, path: pathValue,
        naturalWidth: element?.naturalWidth, naturalHeight: element?.naturalHeight });
    }}
    onKeyDown={thumbnail ? event => {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); onNavigate?.(event.key);
      }
    } : undefined}
  >
    {unavailable ? <span className="message-image-preview-fallback">
      <FileIcon size={20} />{!thumbnail && <span>{language === 'zh' ? '图片无法预览' : 'Preview unavailable'}</span>}
    </span> : !src ? <span className="message-image-loading" role="status">{language === 'zh' ? '正在加载…' : 'Loading…'}</span>
      : <img src={src} alt={name} loading="lazy" decoding="async" onError={() => void recoverLocalImage()} />}
  </button>;
}
