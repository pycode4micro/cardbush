import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { FileMemoResolution } from '@cardbush/bush-protocol';
import { fetchFileMemo } from '../../backend/fileMemo';
import { fileUrl, isImagePath, isVideoPath, isAudioPath } from '../../shared/localPaths';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { openInspector } from '../inspector/inspectorEvents';
import { LocalFileReferenceLink } from './LocalFileReferenceLink';
import { mediaPresentationKey, PresentedMediaContext } from './mediaPresentation';
import { FileMemoScopeContext } from './FileMemoScope';

export function FileMemoReference({ reference, children, inline = false, language = 'zh', load = fetchFileMemo }: {
  reference: string; children?: ReactNode; inline?: boolean; language?: 'zh' | 'en';
  load?: typeof fetchFileMemo;
}) {
  const presentedMedia = useContext(PresentedMediaContext);
  const { sessionId, turnId } = useContext(FileMemoScopeContext);
  const fileName = typeof children === 'string' && /^[^\\/\r\n]+\.[a-z0-9]{1,12}$/i.test(children.trim()) ? children.trim() : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([reference, sessionId, turnId, fileName, attempt]);
  const [state, setState] = useState<{ key: string; result?: FileMemoResolution; failed?: boolean }>();
  const [failedMedia, setFailedMedia] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void load(reference, controller.signal, { sessionId, turnId, fileName }).then(result => {
        if (!controller.signal.aborted && current === revision) setState({ key, result });
      }, () => {
        if (!controller.signal.aborted && current === revision) setState({ key, failed: true });
      });
    };
    refresh(); window.addEventListener('focus', refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); };
  }, [reference, load, sessionId, turnId, fileName, key]);
  const current = state?.key === key ? state : undefined;
  if (current?.failed || current?.result?.status === 'unresolved') {
    const reason = current.result?.status === 'unresolved' ? current.result.reason : undefined;
    const detail = current.failed
      ? language === 'zh' ? '暂时无法读取文件引用，请重试。' : 'Unable to load this file reference right now. Please retry.'
      : reason === 'missing_context'
        ? language === 'zh' ? '请在此文件所属的原会话中打开。' : 'Open this file in its original conversation.'
        : reason === 'ambiguous_reference' || reason === 'reference_mismatch'
          ? language === 'zh' ? '无法确认对应文件，请让助手重新提供链接。' : 'The target file is uncertain. Ask the assistant for a new link.'
          : language === 'zh' ? '链接未找到对应文件记录，请让助手重新提供链接。' : 'No file record matches this link. Ask the assistant for a new link.';
    return <span className="file-memo-reference file-memo-reference-error">
      <span>{children || (language === 'zh' ? '文件链接' : 'File link')}</span>
      <small role="status">{detail}</small>
      <button type="button" className="file-memo-retry" onClick={() => setAttempt(value => value + 1)}>{language === 'zh' ? '重试' : 'Retry'}</button>
    </span>;
  }
  if (!current?.result) return <span aria-busy="true">{children || (language === 'zh' ? '正在读取文件…' : 'Loading file…')}</span>;
  const { memo, status } = current.result;
  const label = children || memo.file.name;
  const path = memo.file.path;
  if (status === 'unavailable') return <span className="local-file-reference-unavailable">
    {label} · {language === 'zh' ? '文件不可访问' : 'File unavailable'}
    {' '}<button type="button" className="file-memo-retry" onClick={() => setAttempt(value => value + 1)}>{language === 'zh' ? '重试' : 'Retry'}</button>
  </span>;
  const mediaKey = JSON.stringify([reference, sessionId, memo.file.size, memo.file.mtimeMs]);
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
