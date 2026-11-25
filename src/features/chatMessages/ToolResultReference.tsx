import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { READ_RUNTIME_TOOL_RESULT_REFERENCE_COMMAND, toolResultReferencePageSchema } from '@cardbush/bush-protocol';
import { conversationRuntime } from '../../backend/conversationRuntime';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import { ConversationHostContext } from '../conversationHost';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';
import { FileMemoScopeContext } from './FileMemoScope';

export function ToolResultReference({ locator, language, children }: { locator: string; language: AppLanguage; children?: ReactNode }) {
  const host = useContext(ConversationHostContext);
  const { sessionId } = useContext(FileMemoScopeContext);
  const [dialog, setDialog] = useState<{ container: HTMLElement; scope: string }>();
  const [page, setPage] = useState<{ text: string; nextOffset: number | null }>();
  const [failure, setFailure] = useState(false);
  const [loading, setLoading] = useState(false);
  const pending = useRef<AbortController | undefined>(undefined);
  const t = uiText(language);
  const scope = JSON.stringify([host?.id, sessionId, locator]);
  const container = dialog?.scope === scope ? dialog.container : null;
  useEffect(() => () => pending.current?.abort(), [locator, sessionId, host?.runtime]);

  const read = (offset: number) => {
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setFailure(false);
    const runtime = conversationRuntime(host?.runtime);
    void runtime.client.command({ kind: READ_RUNTIME_TOOL_RESULT_REFERENCE_COMMAND, payload: { sessionId, locator, offset } },
      result => toolResultReferencePageSchema.parse(result), AbortSignal.any([request.signal, AbortSignal.timeout(10000)]))
      .then(result => {
        if (!request.signal.aborted) setPage(current => ({ ...result, text: offset && current ? current.text + result.text : result.text }));
      }, () => { if (!request.signal.aborted) setFailure(true); })
      .finally(() => { runtime.dispose(); if (!request.signal.aborted) setLoading(false); });
  };
  const close = () => { pending.current?.abort(); setDialog(undefined); setPage(undefined); };
  if (!sessionId) return <span className="markdown-reference-unavailable" title={t('markdownReference.referenceUnavailable')}>{children}</span>;
  return <>
    <button type="button" className="markdown-file-link" onClick={event => {
      setPage(undefined);
      setDialog({ container: event.currentTarget.closest<HTMLElement>('.source-memo-card') ?? document.body, scope });
      read(0);
    }}>{children || t('toolExecutionBlock.toolOutput')}</button>
    {container && createPortal(<SettingsFormDialog className="tool-result-reference-dialog" title={t('toolExecutionBlock.toolOutput')}
      language={language} onCancel={close} onSubmit={() => read(page?.nextOffset ?? 0)} footer={<>
        {(failure || page?.nextOffset != null) && <button className="secondary-button" type="submit" disabled={loading}>
          {t(failure ? 'common.retry' : 'image.loadMore')}</button>}
        <button className="secondary-button" type="button" onClick={close}>{t('common.close')}</button>
      </>}>
      {page && <pre className="tool-result-reference-output" tabIndex={0}>{page.text}</pre>}
      {(failure || loading) && <p role="status">{t(failure ? 'markdownReference.referenceUnavailable' : 'common.loading')}</p>}
    </SettingsFormDialog>, container)}
  </>;
}
