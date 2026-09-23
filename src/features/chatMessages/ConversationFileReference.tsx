import { useContext, useState, type ReactNode } from 'react';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { basename, isAudioPath, isImagePath, isVideoPath } from '../../shared/localPaths';
import { InlineHtmlPreview, isHtmlPreviewPath } from './InlineHtmlPreview';
import { InlineAudio, InlineVideo } from './InlineMedia';
import type { AppLanguage } from '../../types';

/** Authored remote references use the same viewers, but never resolve on this computer. */
export function ConversationFileReference({ path, children, inline = false, language, fileVersion }: {
  path: string; children?: ReactNode; inline?: boolean; language: AppLanguage; fileVersion?: string;
}) {
  const host = useContext(ConversationHostContext);
  const [failed, setFailed] = useState('');
  const html = isHtmlPreviewPath(path);
  const media = inline && (isImagePath(path) || /\.svg$/i.test(path) || isVideoPath(path) || isAudioPath(path));
  const file = useConversationFileSource(path, Boolean(host && media), { revision: fileVersion });
  const label = children || basename(path);
  if (host && inline && html) return <InlineHtmlPreview path={path} title={typeof label === 'string' ? label : basename(path)} language={language} fileVersion={fileVersion} />;
  if (media && file.source && failed !== file.source) {
    const props = { src: file.source, onError: () => setFailed(file.source), 'aria-label': typeof label === 'string' ? label : basename(path) };
    if (isVideoPath(path)) return <InlineVideo {...props} />;
    if (isAudioPath(path)) return <InlineAudio {...props} />;
    return <img {...props} alt={props['aria-label']} role="button" tabIndex={0} onClick={() => host?.openFile(path)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); host?.openFile(path); } }} />;
  }
  return <span className="file-memo-reference">
    <button type="button" className="markdown-file-link" onClick={() => host?.openFile(path)}>{label}</button>
    {media && <small role="status">{file.error || failed ? (language === 'zh' ? ' · 预览不可用，点击文件重试' : ' · Preview unavailable; open the file to retry') : (language === 'zh' ? ' · 正在加载…' : ' · Loading…')}</small>}
  </span>;
}
