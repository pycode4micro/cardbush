import { Children, createContext, isValidElement, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ImgHTMLAttributes, type ReactNode } from 'react';
import type { AppLanguage } from '../../types';
import './message-image-gallery.css';

type GalleryImageSource = { src: string; alt: string };
type GallerySlot = { image: (value: GalleryImageSource | null) => void; fallback: (value: boolean) => void };
const GallerySlotContext = createContext<GallerySlot | null>(null);

/** The existing reference renderer owns resolution, permissions and the original viewer.
 * The gallery only shares its resolved image URL with the thumbnail. */
export function MessageContentImage({ src, alt = '', className, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const slot = useContext(GallerySlotContext);
  useLayoutEffect(() => {
    slot?.image(src ? { src, alt } : null);
    return () => slot?.image(null);
  }, [slot, src, alt]);
  return <img {...props} src={src} alt={alt} decoding="async" className={['message-content-image', className].filter(Boolean).join(' ')} />;
}

/** A memo can resolve to a document/player instead of an image. Keep that content in order. */
export function useImageGalleryFallback(value: boolean) {
  const slot = useContext(GallerySlotContext);
  useLayoutEffect(() => {
    slot?.fallback(value);
    return () => slot?.fallback(false);
  }, [slot, value]);
}

function ImageSlot({ index, children, active, onImage, onFallback }: {
  index: number; children: ReactNode; active: boolean;
  onImage: (index: number, value: GalleryImageSource | null) => void;
  onFallback: (index: number, value: boolean) => void;
}) {
  const slot = useMemo(() => ({ image: (value: GalleryImageSource | null) => onImage(index, value),
    fallback: (value: boolean) => onFallback(index, value) }), [index, onImage, onFallback]);
  return <GallerySlotContext.Provider value={slot}>
    <div className="message-image-gallery-item" hidden={!active}>{children}</div>
  </GallerySlotContext.Provider>;
}

export function MessageImageGalleryFrame({ children, language }: { children: ReactNode; language: AppLanguage }) {
  const items = Children.toArray(children).filter(isValidElement);
  const [selected, setSelected] = useState(0);
  const [images, setImages] = useState<Record<number, GalleryImageSource | null>>({});
  const [fallbacks, setFallbacks] = useState<Record<number, boolean>>({});
  const rail = useRef<HTMLDivElement>(null);
  const active = Math.min(selected, Math.max(0, items.length - 1));
  const grouped = items.length > 1 && !items.some((_, index) => fallbacks[index]);
  const onImage = useCallback((index: number, value: GalleryImageSource | null) => {
    setImages(previous => previous[index]?.src === value?.src && previous[index]?.alt === value?.alt
      ? previous : { ...previous, [index]: value });
  }, []);
  const onFallback = useCallback((index: number, value: boolean) => {
    setFallbacks(previous => Boolean(previous[index]) === value ? previous : { ...previous, [index]: value });
  }, []);
  useLayoutEffect(() => {
    const list = rail.current;
    const button = list?.children[active] as HTMLElement | undefined;
    if (!list || !button) return;
    // Scroll only the rail; scrollIntoView would also move the conversation.
    const top = button.offsetTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + button.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + button.offsetHeight - list.clientHeight;
  }, [active, grouped]);
  return <div className={`message-image-gallery${grouped ? '' : ' is-ungrouped'}`} role="group"
    aria-label={language === 'zh' ? '图片组' : 'Image gallery'}>
    <div className="message-image-gallery-stage">
      {items.map((child, index) => <ImageSlot key={child.key ?? index} index={index} active={!grouped || active === index}
        onImage={onImage} onFallback={onFallback}>{child}</ImageSlot>)}
    </div>
    {grouped && <div className="message-image-gallery-rail" ref={rail}>
      {items.map((child, index) => <button key={child.key ?? index} type="button" className="message-image-gallery-thumbnail"
        aria-label={language === 'zh' ? `查看第 ${index + 1} 张图片` : `Show image ${index + 1}`}
        title={images[index]?.alt || `${index + 1} / ${items.length}`} aria-pressed={active === index}
        onClick={() => setSelected(index)} onKeyDown={event => {
          const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? Math.min(items.length - 1, index + 1)
            : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? Math.max(0, index - 1)
              : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); setSelected(next);
          (rail.current?.children[next] as HTMLButtonElement | undefined)?.focus({ preventScroll: true });
        }}>
        {images[index]?.src ? <img src={images[index].src} alt="" loading="lazy" decoding="async" /> : <span>{index + 1}</span>}
      </button>)}
    </div>}
  </div>;
}
