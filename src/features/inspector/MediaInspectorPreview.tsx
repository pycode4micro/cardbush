import { useEffect, useRef, useState } from 'react';
import { basename } from '../../shared/localPaths';
import type { AppLanguage } from '../../types';

export function MediaInspectorPreview({ kind, source, path, language, onLoadingChange }: {
  kind: 'image' | 'video' | 'audio';
  source: string;
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<'load' | 'timeout' | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const media = containerRef.current?.querySelector('img, video, audio') as HTMLImageElement | HTMLMediaElement | null;
    if (!media) return;
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
  }, [source, revision, onLoadingChange]);

  const name = basename(path);
  return (
    <div className="inspector-media-preview" ref={containerRef}>
      {kind === 'image' ? (
        <img key={revision} src={source} alt={name} />
      ) : kind === 'video' ? (
        <video key={revision} src={source} controls playsInline preload="metadata" aria-label={name} />
      ) : (
        <audio key={revision} src={source} controls preload="metadata" aria-label={name} />
      )}
      {error && (
        <div className="inspector-media-error" role="alert">
          <p>{language === 'zh'
            ? error === 'timeout' ? '媒体加载超时，请重试。' : '无法预览媒体，请检查文件是否存在、是否损坏或编码是否受支持。'
            : error === 'timeout' ? 'Media loading timed out. Please retry.' : 'Unable to preview media. Check that the file exists and uses a supported encoding.'}</p>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            {language === 'zh' ? '重试' : 'Retry'}
          </button>
        </div>
      )}
    </div>
  );
}
