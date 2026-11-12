import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { AutomationRun } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import './automations.css';
import { useDisclosureState } from '../navigation/useDisclosureState';

// History may outlive its source conversation. Read only the saved result,
// by its exact receipt, without loading or promoting the execution session.
export type ResultContentView = ComponentType<{ content: string; language: string }>;
export function EventResultDisclosure({ jobId, runId, summary, language, children, ResultContent, expanded }: {
  jobId: string; runId: string; summary?: string; language: string; children: ReactNode;
  ResultContent: ResultContentView; expanded?: Set<string>;
}) {
  const disclosure = useDisclosureState(JSON.stringify(['run', jobId, runId]), expanded);
  const {open} = disclosure;
  const [result, setResult] = useState<string>();
  const [failed, setFailed] = useState(false);
  const t = uiText(language);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setFailed(false);
    void (async () => {
      const page = await window.cardbushDesktop!.automationCommand({ action: 'results', id: jobId, runIds: [runId] }) as
        { results: Array<AutomationRun & { jobId: string }> };
      const run = page.results.find(item => item.id === runId && item.jobId === jobId);
      if (current) setResult(run?.result || run?.summary || run?.error || '');
    })().catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [open, jobId, runId]);
  return <details className="event-result-disclosure" {...disclosure}>
    <summary>{children}</summary>
    {open && (result || summary ? <ResultContent content={result || summary!} language={language}/> :
      <p role="status">{t(failed || result === '' ? 'conversationEvents.resultUnavailable' : 'common.loading')}</p>)}
  </details>;
}
