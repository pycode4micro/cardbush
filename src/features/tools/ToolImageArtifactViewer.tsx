import { Eye, FileImage, LoaderCircle } from 'lucide-react';
import { useCallback, useContext, useEffect, useState } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import type { AppLanguage, ChatToolArtifact } from '../../types';
import { ImagePreviewDialog } from '../chatMessages/ImagePreviewDialog';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';

type ToolImagePreview = {
  name: string;
  path: string;
  src: string;
};

export function ToolImageArtifactViewer({
  artifacts,
  language,
  variant = 'card',
}: {
  artifacts: ChatToolArtifact[] | undefined;
  language: AppLanguage;
  variant?: 'card' | 'thumbnail';
}) {
  const images = (artifacts ?? []).filter((artifact) => artifact.type === 'image');
  const host = useContext(ConversationHostContext);
  const [loadingPath, setLoadingPath] = useState('');
  const [preview, setPreview] = useState<ToolImagePreview | null>(null);
  const [failedPaths, setFailedPaths] = useState<Set<string>>(() => new Set());

  const openImage = useCallback(async (artifact: ChatToolArtifact) => {
    const pathValue = artifact.path.trim();
    if (!pathValue) return;
    const name = artifact.name || basename(pathValue);
    if (host) {
      // The shared dialog reads the selected host and owns the remote blob lifetime.
      setPreview({ name, path: pathValue, src: '' });
      return;
    }
    setLoadingPath(pathValue);
    try {
      let src = mediaSource(pathValue);
      if (
        !/^(?:https?:|data:|blob:)/i.test(pathValue) &&
        window.cardbushDesktop?.readImageDataUrl
      ) {
        const dataUrl = await window.cardbushDesktop.readImageDataUrl(pathValue);
        if (dataUrl.startsWith('data:image/')) src = dataUrl;
      }
      setFailedPaths((current) => {
        if (!current.has(pathValue)) return current;
        const next = new Set(current);
        next.delete(pathValue);
        return next;
      });
      setPreview({ name, path: pathValue, src });
    } catch (error) {
      console.warn('Unable to open tool image artifact', pathValue, error);
      setFailedPaths((current) => new Set(current).add(pathValue));
    } finally {
      setLoadingPath('');
    }
  }, [host]);

  if (images.length === 0) return null;

  return (
    <>
      <div className={`tool-image-artifacts${variant === 'thumbnail' ? ' tool-image-thumbnails' : ''}`}>
        {images.map((artifact) => {
          const pathValue = artifact.path.trim();
          const loading = loadingPath === pathValue;
          const failed = failedPaths.has(pathValue);
          const name = artifact.name || basename(pathValue);
          return (
            <button
              className={`${variant === 'thumbnail' ? 'tool-image-thumbnail' : 'tool-preview-card'} tool-image-artifact-button`}
              type="button"
              key={`${artifact.id}:${pathValue}`}
              title={/^(?:data:|blob:)/i.test(pathValue) ? name : `${name}\n${pathValue}`}
              aria-label={`${language === 'zh' ? '查看图像' : 'View image'}: ${name}${failed ? (language === 'zh' ? '（预览失败，点击重试）' : ' (preview failed, retry)') : ''}`}
              aria-busy={loading || undefined}
              disabled={!pathValue || loading}
              onClick={() => void openImage(artifact)}
              onContextMenu={event => openFileContextMenu(event, host ? '' : pathValue, { language, image: true })}
            >
              {variant === 'thumbnail' ? <>
                <ToolImageThumbnail key={pathValue} path={pathValue} name={name} language={language} />
                {(loading || failed) && <span className="tool-image-thumbnail-overlay" aria-hidden="true">
                  {loading ? <LoaderCircle size={16} className="spin" /> : <span>{language === 'zh' ? '点击重试' : 'Retry'}</span>}
                </span>}
              </> : <><span className="tool-preview-icon" aria-hidden="true">
                {loading ? <LoaderCircle size={14} /> : <FileImage size={14} />}
              </span>
              <span className="tool-preview-content">
                <strong>
                  {failed
                    ? language === 'zh' ? '图片无法预览' : 'Preview unavailable'
                    : language === 'zh' ? '查看图像' : 'View image'}
                </strong>
                <small>{name}</small>
              </span>
              <Eye size={14} aria-hidden="true" /></>}
            </button>
          );
        })}
      </div>
      {preview && (
        <ImagePreviewDialog
          image={preview}
          language={language}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function mediaSource(pathValue: string) {
  return /^(?:https?:|data:|blob:)/i.test(pathValue.trim())
    ? pathValue.trim()
    : fileUrl(pathValue);
}

function ToolImageThumbnail({ path, name, language }: { path: string; name: string; language: AppLanguage }) {
  const host = useContext(ConversationHostContext);
  const { source, error } = useConversationFileSource(path);
  const [failed, setFailed] = useState(false);
  const [fallback, setFallback] = useState('');
  const [fallbackFailed, setFallbackFailed] = useState(false);
  useEffect(() => {
    const read = window.cardbushDesktop?.readImageDataUrl;
    if (host || !failed || /^(?:https?:|data:|blob:)/i.test(path) || !read) return;
    let disposed = false;
    // Use the file protocol first; only request a data URL if it cannot load.
    void read(path).then(source => {
      if (!disposed && source.startsWith('data:image/')) setFallback(source);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [host, failed, path]);
  if (host && !source && !error) return <span className="tool-image-thumbnail-fallback" aria-hidden="true"><LoaderCircle size={20} className="spin" /></span>;
  if (error || fallbackFailed || (failed && !fallback)) return <span className="tool-image-thumbnail-fallback" aria-hidden="true">
    <FileImage size={20} /><span>{name}</span><small>{language === 'zh' ? '点击查看' : 'View image'}</small>
  </span>;
  return <img src={fallback || source} alt="" loading="lazy" decoding="async" draggable={false}
    onError={() => fallback ? setFallbackFailed(true) : setFailed(true)} />;
}
