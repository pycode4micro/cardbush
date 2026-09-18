import { useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef } from 'react';

type VideoProps = ComponentPropsWithoutRef<'video'>;
type AudioProps = ComponentPropsWithoutRef<'audio'>;

/** Native controls live in a reserved viewport. Metadata and the reveal never
 * change its geometry, including portrait videos and late/failed loads. */
function InlineMedia({ kind, props }: { kind: 'video' | 'audio'; props: VideoProps | AudioProps }) {
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
  return <span ref={container} className={`inline-media-frame is-${kind}${ready ? ' is-ready' : ''}`} aria-busy={!ready}>
    {kind === 'video' ? <video controls playsInline preload="metadata" {...props as VideoProps} />
      : <audio controls preload="metadata" {...props as AudioProps} />}
    {!ready && <span className="inline-media-placeholder" aria-hidden="true" />}
  </span>;
}

export function InlineVideo(props: VideoProps) {
  return <InlineMedia key={props.src} kind="video" props={props} />;
}

export function InlineAudio(props: AudioProps) {
  return <InlineMedia key={props.src} kind="audio" props={props} />;
}
