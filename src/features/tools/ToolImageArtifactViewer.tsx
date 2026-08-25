import { Eye, FileImage, LoaderCircle } from 'lucide-react';
import { useCallback, useState } from 'react';

import { basename, fileUrl } from '../../shared/localPaths';
import type { AppLanguage, ChatToolArtifact } from '../../types';
import { ImagePreviewDialog } from '../chatMessages/ImagePreviewDialog';

type ToolImagePreview = {
  name: string;
  path: string;
  src: string;
};

export function ToolImageArtifactViewer({
  artifacts,
  language,
}: {
  artifacts: ChatToolArtifact[] | undefined;
  language: AppLanguage;
}) {
  const images = (artifacts ?? []).filter((artifact) => artifact.type === 'image');
  const [loadingPath, setLoadingPath] = useState('');
  const [preview, setPreview] = useState<ToolImagePreview | null>(null);
  const [failedPaths, setFailedPaths] = useState<Set<string>>(() => new Set());

  const openImage = useCallback(async (artifact: ChatToolArtifact) => {
    const pathValue = artifact.path.trim();
    if (!pathValue) return;
    const name = artifact.name || basename(pathValue);
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
  }, []);

  if (images.length === 0) return null;

  return (
    <>
      <div className="tool-image-artifacts">
        {images.map((artifact) => {
          const pathValue = artifact.path.trim();
          const loading = loadingPath === pathValue;
          const failed = failedPaths.has(pathValue);
          return (
            <button
              className="tool-image-artifact-button"
              type="button"
              key={artifact.id || pathValue}
              title={pathValue}
              disabled={!pathValue || loading}
              onClick={() => void openImage(artifact)}
            >
              <span className="tool-image-artifact-icon" aria-hidden="true">
                {loading ? <LoaderCircle size={14} /> : <FileImage size={14} />}
              </span>
              <span>
                <strong>
                  {failed
                    ? language === 'zh' ? '图片无法预览' : 'Preview unavailable'
                    : language === 'zh' ? '查看图像' : 'View image'}
                </strong>
                <small>{artifact.name || basename(pathValue)}</small>
              </span>
              <Eye size={14} aria-hidden="true" />
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
