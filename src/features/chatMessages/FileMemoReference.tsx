import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { FileMemoResolution } from '@cardbush/bush-protocol';
import { fetchFileMemo } from '../../backend/fileMemo';
import { fileUrl, isImagePath, isVideoPath, isAudioPath } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { showUiError } from '../../shared/showUiError';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { mediaPresentationKey, PresentedMediaContext } from './mediaPresentation';

export function FileMemoReference({ reference, children, inline = false, language = 'zh', load = fetchFileMemo }: {
  reference: string; children?: ReactNode; inline?: boolean; language?: 'zh' | 'en';
  load?: typeof fetchFileMemo;
}) {
  const presentedMedia = useContext(PresentedMediaContext);
  const [state, setState] = useState<{ reference: string; result?: FileMemoResolution; error?: string }>();
  const [failedMedia, setFailedMedia] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void load(reference, controller.signal).then(result => {
        if (!controller.signal.aborted && current === revision) setState({ reference, result });
      }, error => {
        if (!controller.signal.aborted && current === revision) setState({ reference, error: String(error) });
      });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [reference, load]);
  const current = state?.reference === reference ? state : undefined;
  if (current?.error) return <button type="button" className="markdown-link-error"
    onClick={() => void showUiError(language === 'zh' ? '文件引用不可用' : 'File reference unavailable', current.error!)}>
    {children || (language === 'zh' ? '文件引用不可用' : 'File reference unavailable')}
  </button>;
  if (!current?.result) return <span aria-busy="true">{children || (language === 'zh' ? '正在读取文件…' : 'Loading file…')}</span>;
  const { memo, status } = current.result;
  const label = children || memo.file.name;
  const path = memo.file.path;
  if (status === 'unavailable') return <span className="local-file-reference-unavailable">
    {label} · {language === 'zh' ? '文件不可访问' : 'File unavailable'}
  </span>;
  const mediaKey = JSON.stringify([reference, memo.file.size, memo.file.mtimeMs]);
  const media = inline && status === 'available' && failedMedia !== mediaKey && !presentedMedia.has(mediaPresentationKey(path));
  const source = fileUrl(path);
  return <span className="file-memo-reference" title={`${language === 'zh' ? '模型备注' : 'Model note'}: ${memo.note.purpose}`}>
    {media && isImagePath(path) ? <img src={source} alt={typeof children === 'string' ? children : memo.file.name}
      onError={() => setFailedMedia(mediaKey)}
      onClick={() => openInspector(path, memo.file.name)}
      onContextMenu={event => openFileContextMenu(event, path, { image: true, language })} />
      : media && isVideoPath(path) ? <video src={source} controls preload="metadata" onError={() => setFailedMedia(mediaKey)} onContextMenu={event => openFileContextMenu(event, path, { language })} />
      : media && isAudioPath(path) ? <audio src={source} controls preload="metadata" onError={() => setFailedMedia(mediaKey)} onContextMenu={event => openFileContextMenu(event, path, { language })} />
      : <LocalFileReferenceLink path={path} knownFileName={memo.file.name}>{label}</LocalFileReferenceLink>}
    {status === 'changed' && <small role="status"> · {language === 'zh' ? '文件已变化，打开查看当前版本' : 'File changed; open the current version'}</small>}
    {status === 'available' && inline && failedMedia === mediaKey && <small role="status"> · {language === 'zh' ? '无法预览，打开文件查看' : 'Preview unavailable; open the file'}</small>}
  </span>;
}
