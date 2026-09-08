import { Suspense, lazy, useEffect, useState } from 'react';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { shouldUsePlainTextPreview, textPreviewErrorCode, textPreviewErrorMessage } from '../../shared/textPreview';
import { showUiError } from '../../shared/showUiError';
import type { AppLanguage } from '../../types';
import { parentDirectory } from './inspectorTargets';
import { FilePreviewFallback } from './FilePreviewFallback';

const SourceSyntaxLines = lazy(() => import('../tools/SourceSyntaxLines'));

export function MarkdownInspectorPreview({
  path,
  language,
  onLoadingChange,
}: {
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [encoding, setEncoding] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    onLoadingChange(true);
    setError('');
    setContent('');
    setTruncated(false);
    setEncoding('');
    const readTextPreview = window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(language === 'zh' ? '当前环境不支持本地 Markdown 预览。' : 'Local Markdown preview is unavailable.');
      onLoadingChange(false);
      return () => {
        disposed = true;
      };
    }
    void readTextPreview(path)
      .then((result) => {
        if (disposed) return;
        setContent(result.content);
        setTruncated(result.truncated);
        setEncoding(result.encoding ?? '');
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        const message = textPreviewErrorMessage(reason, language);
        const expected = textPreviewErrorCode(reason) !== undefined;
        setError(message);
        if (!expected) void showUiError(language === 'zh' ? '无法读取文件预览' : 'Unable to read preview', `${path}\n\n${message}`);
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path]);

  return (
    <article className="markdown-inspector-preview">
      <div className="markdown-inspector-document">
        {error ? (
          <FilePreviewFallback message={error} path={path} language={language} />
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice">
              {language === 'zh' ? '按 GB18030 编码预览，原文件未修改。' : 'Preview decoded as GB18030; original file unchanged.'}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice">
                {language === 'zh' ? '文件较大，仅显示前 2 MiB' : 'Large file · showing the first 2 MiB'}
              </div>
            )}
            {shouldUsePlainTextPreview(content) ? <Suspense fallback={null}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense> : <MessageFileReferenceScope workspaceRoot={parentDirectory(path)}>
              <MarkdownContent content={content} language={language} />
            </MessageFileReferenceScope>}
          </>
        )}
      </div>
    </article>
  );
}
export function SourceInspectorPreview({
  path,
  language,
  onLoadingChange,
}: {
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [encoding, setEncoding] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    onLoadingChange(true);
    setError('');
    setContent('');
    setTruncated(false);
    setEncoding('');
    const readTextPreview = window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(language === 'zh' ? '当前环境不支持本地源码预览。' : 'Local source preview is unavailable.');
      onLoadingChange(false);
      return () => {
        disposed = true;
      };
    }
    void readTextPreview(path)
      .then((result) => {
        if (disposed) return;
        setContent(result.content);
        setTruncated(result.truncated);
        setEncoding(result.encoding ?? '');
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        const message = textPreviewErrorMessage(reason, language);
        const expected = textPreviewErrorCode(reason) !== undefined;
        setError(message);
        if (!expected) void showUiError(language === 'zh' ? '无法读取文件预览' : 'Unable to read preview', `${path}\n\n${message}`);
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path]);

  return (
    <article className="source-inspector-preview">
      <div className="source-inspector-document">
        {error ? (
          <FilePreviewFallback message={error} path={path} language={language} />
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice source">
              {language === 'zh' ? '按 GB18030 编码预览，原文件未修改。' : 'Preview decoded as GB18030; original file unchanged.'}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice source">
                {language === 'zh' ? '文件较大，仅显示前 2 MiB' : 'Large file · showing the first 2 MiB'}
              </div>
            )}
            <Suspense fallback={null}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense>
          </>
        )}
      </div>
    </article>
  );
}
