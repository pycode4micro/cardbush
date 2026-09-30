import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { mediaResourceUrl } from '../../shared/localPaths';
import type { AppLanguage } from '../../types';

type VideoProps = ComponentPropsWithoutRef<'video'>;
type AudioProps = ComponentPropsWithoutRef<'audio'>;

/** Native controls live in a reserved viewport. Metadata and the reveal never
 * change its geometry, including portrait videos and late/failed loads. */
function InlineMedia({ kind, props, language }: { kind: 'video' | 'audio'; props: VideoProps | AudioProps; language: AppLanguage }) {
  const container = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const media = container.current?.querySelector('video, audio') as HTMLMediaElement | null;
    if (!media) return;
    const reveal = () => { window.clearTimeout(timer); setReady(true); };
    // Streaming/unsupported sources must still expose native retry/play controls.
    const timer = window.setTimeout(reveal, 15000);
    media.addEventListener('loadedmetadata', reveal);
    media.addEventListener('error', reveal);
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA || media.error) reveal();
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener('loadedmetadata', reveal);
      media.removeEventListener('error', reveal);
      media.pause();
    };
  }, []);
  const source = props.src ? mediaResourceUrl(props.src) : '';
  if (!source) return <span className="inline-media-unavailable" role="status">{language === 'zh' ? '媒体地址不可用' : 'Media address unavailable'}</span>;
  return <span ref={container} className={`inline-media-frame is-${kind}${ready ? ' is-ready' : ''}`} aria-busy={!ready}>
    {kind === 'video' ? <video controls playsInline preload="metadata" {...props as VideoProps} src={source} />
      : <audio controls preload="metadata" {...props as AudioProps} src={source} />}
    {!ready && <span className="inline-media-placeholder" aria-hidden="true" />}
  </span>;
}

export function InlineVideo({ language = 'zh', ...props }: VideoProps & { language?: AppLanguage }) {
  return <InlineMedia key={props.src} kind="video" props={props} language={language} />;
}

export function InlineAudio({ language = 'zh', ...props }: AudioProps & { language?: AppLanguage }) {
  return <InlineMedia key={props.src} kind="audio" props={props} language={language} />;
}
