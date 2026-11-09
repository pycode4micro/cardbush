import { Bell, Check, X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { uiText } from '../../i18n';
import type { AppLanguage } from '../../types';
import type { ConversationEventResult } from './conversationEventResults';
import './automations.css';

export function EventReadButton({ item, language }: { item: ConversationEventResult; language: AppLanguage }) {
  const t = uiText(language);
  const [saving, setSaving] = useState(false), [failed, setFailed] = useState(false);
  async function acknowledge() {
    setSaving(true); setFailed(false);
    try { await window.cardbushDesktop!.automationCommand({ action: 'mark_read', id: item.jobId, runIds: [item.runId] }); }
    catch { setFailed(true); }
    finally { setSaving(false); }
  }
  return <><button type="button" className="event-result-ack" disabled={saving} onClick={() => void acknowledge()}
    aria-label={t('automationPanel.markRead')} title={t('automationPanel.markRead')}><Check aria-hidden="true"/></button>
    {failed && <span className="event-read-error" role="alert">{t('conversationEvents.readFailed')}</span>}</>;
}

function ResultRow({ item, language }: { item: ConversationEventResult; language: AppLanguage }) {
  const t = uiText(language);
  const status = t(item.status === 'awaiting_user_action' ? 'automationPanel.needsAttention' : `automationPanel.${item.status}`);
  return <article className="conversation-event-result" tabIndex={-1} data-event-result={item.runId} aria-label={item.title}>
    <Bell aria-hidden="true"/>
    <div><strong>{item.title}</strong>
    <small>{status} · <time dateTime={item.finishedAt}>{new Date(item.finishedAt).toLocaleString(language, {dateStyle:'short',timeStyle:'short'})}</time></small>
    {item.summary && <p>{item.summary}</p>}
    </div>
    <EventReadButton item={item} language={language}/>
  </article>;
}

export const ConversationEventInbox = memo(function ConversationEventInbox({ items, sessionId, language, requestedRunId, onLocated }: {
  items: ConversationEventResult[]; sessionId: string; language: AppLanguage; requestedRunId?: string; onLocated?(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLElement>(null);
  const [first, ...rest] = items.filter(item => item.sourceId === sessionId);
  const showEarlier = !!requestedRunId && rest.some(item => item.runId === requestedRunId);
  useLayoutEffect(() => {
    if (!requestedRunId || !root.current) return;
    const row = root.current.querySelector<HTMLElement>(`[data-event-result="${CSS.escape(requestedRunId)}"]`);
    if (!row || root.current.closest('[inert], [hidden]')) return;
    if (showEarlier) setExpanded(true);
    const frame = requestAnimationFrame(() => {
      if (!row.checkVisibility()) return;
      row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      row.focus({ preventScroll: true });
      onLocated?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedRunId, showEarlier, onLocated, first?.runId]);
  if (!first) return null;
  const t = uiText(language);
  return <section ref={root} className="conversation-event-inbox" aria-label={t('conversationEvents.unreadResults')}>
    <ResultRow key={first.runId} item={first} language={language}/>
    {rest.length > 0 && <details open={expanded || showEarlier} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{t('conversationEvents.earlierUnread', { count: rest.length })}</summary>
      {(expanded || showEarlier) && rest.map(item => <ResultRow key={item.runId} item={item} language={language}/>)}
    </details>}
  </section>;
});

export function ConversationEventToast({ item, language, onOpen }: {
  item: ConversationEventResult; language: AppLanguage; onOpen(): void;
}) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(false), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  if (!visible) return null;
  const t = uiText(language);
  return <aside className="conversation-event-toast" aria-label={t('conversationEvents.unreadResults')}>
    <Bell aria-hidden="true"/>
    <button type="button" className="event-toast-body" onClick={() => { setVisible(false); onOpen(); }}>
      <strong>{item.title}</strong><span role="status">{item.summary || t(item.status === 'awaiting_user_action' ? 'automationPanel.needsAttention' : `automationPanel.${item.status}`)}</span>
    </button>
    <button type="button" className="event-result-ack" aria-label={t('chatStatusViews.dismissNotification')}
      onClick={() => setVisible(false)}><X aria-hidden="true"/></button>
  </aside>;
}
