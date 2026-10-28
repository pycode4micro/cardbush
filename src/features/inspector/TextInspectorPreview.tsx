import { uiText } from '../../i18n';
import { ConversationHostContext } from '../conversationHost';
import { Suspense, useContext, useEffect, useState } from 'react';
import { MarkdownContent, MessageFileReferenceScope } from '../chatMessages';
import { shouldUsePlainTextPreview, textPreviewErrorCode, textPreviewErrorMessage } from '../../shared/textPreview';
import { showUiError } from '../../shared/showUiError';
import type { AppLanguage } from '../../types';
import { parentDirectory } from './inspectorTargets';
import { FilePreviewFallback } from './FilePreviewFallback';
import { DeferredModuleNotice, recoverableLazy } from '../../shared/recoverableLazy';
import { PlainSourceLines } from '../tools/PlainSourceLines';

const SourceSyntaxLines = recoverableLazy(
  'source-syntax',
  () => import('../tools/SourceSyntaxLines'),
  (props) => <>
    <DeferredModuleNotice language={props.language ?? 'en'} basicPreview />
    <PlainSourceLines content={props.content} />
  </>,
);

export function MarkdownInspectorPreview({
  path,
  language,
  onLoadingChange,
}: {
  path: string;
  language: AppLanguage;
  onLoadingChange: (loading: boolean) => void;
}) {
  const host = useContext(ConversationHostContext);
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
    const readTextPreview = host?.readFile ? async (path: string) => { const { blob } = await host.readFile!(path); return { content: await blob.slice(0, 2 * 1024 * 1024).text(), truncated: blob.size > 2 * 1024 * 1024, encoding: 'utf-8' }; } : window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(uiText(language)('textInspectorPreview.localMarkdownPreviewIsUnavailable'));
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
        if (!expected) void showUiError(uiText(language)('textInspectorPreview.unableToReadPreview'), `${path}\n\n${message}`);
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path, host?.readFile]);

  return (
    <article className="markdown-inspector-preview">
      <div className="markdown-inspector-document">
        {error ? (
          <FilePreviewFallback message={error} path={path} language={language} />
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice">
              {uiText(language)('textInspectorPreview.previewDecodedAsGb18030OriginalFileUnchanged')}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice">
                {uiText(language)('textInspectorPreview.largeFileShowingTheFirst2Mib')}
              </div>
            )}
            {shouldUsePlainTextPreview(content) ? <Suspense fallback={<PlainSourceLines content={content} />}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense> : <MessageFileReferenceScope workspaceRoot={parentDirectory(path)}>
              <MarkdownContent content={content} language={language} compactImages={false} />
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
  const host = useContext(ConversationHostContext);
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
    const readTextPreview = host?.readFile ? async (path: string) => { const { blob } = await host.readFile!(path); return { content: await blob.slice(0, 2 * 1024 * 1024).text(), truncated: blob.size > 2 * 1024 * 1024, encoding: 'utf-8' }; } : window.cardbushDesktop?.readTextPreview;
    if (!readTextPreview) {
      setError(uiText(language)('textInspectorPreview.localSourcePreviewIsUnavailable'));
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
        if (!expected) void showUiError(uiText(language)('textInspectorPreview.unableToReadPreview'), `${path}\n\n${message}`);
      })
      .finally(() => {
        if (!disposed) onLoadingChange(false);
      });
    return () => {
      disposed = true;
    };
  }, [language, onLoadingChange, path, host?.readFile]);

  return (
    <article className="source-inspector-preview">
      <div className="source-inspector-document">
        {error ? (
          <FilePreviewFallback message={error} path={path} language={language} />
        ) : (
          <>
            {encoding === 'gb18030' && <div className="inspector-preview-notice source">
              {uiText(language)('textInspectorPreview.previewDecodedAsGb18030OriginalFileUnchanged')}
            </div>}
            {truncated && (
              <div className="inspector-preview-notice source">
                {uiText(language)('textInspectorPreview.largeFileShowingTheFirst2Mib')}
              </div>
            )}
            <Suspense fallback={<PlainSourceLines content={content} />}>
              <SourceSyntaxLines content={content} path={path} language={language} />
            </Suspense>
          </>
        )}
      </div>
    </article>
  );
}
