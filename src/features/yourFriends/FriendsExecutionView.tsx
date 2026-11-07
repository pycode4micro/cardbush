import { useMemo } from 'react';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';

type PreviewNode = { type: string; value?: string; alt?: string | null; children?: PreviewNode[] };
function previewText(node: PreviewNode): string {
  if (node.type === 'html') return '';
  return node.value ?? node.alt ?? node.children?.map(previewText).join('') ?? '';
}
// A bounded excerpt, not another model-authored summary. Full Markdown and
// artifact links remain available in the event details.
function resultExcerpt(text: string): string {
  const blocks = fromMarkdown(text.slice(0, 4096)).children;
  const block = blocks.find(node => node.type === 'paragraph') ?? blocks[0];
  const characters = Array.from(block ? previewText(block).replace(/\s+/g, ' ').trim() : '');
  return characters.slice(0, 280).join('') + (characters.length > 280 ? '…' : '');
}

export function FriendsExecutionView({ event, snapshot, language, manage, onDetails, onRespond, onContinue }: {
  event?: FriendsWorkEvent; snapshot?: FriendsSnapshot; language: string;
  manage(action: 'pause' | 'resume', id: string): void;
  onDetails(id: string): void; onRespond(): void; onContinue(id: string): void;
}) {
  const t = uiText(language);
  const needsResponse = Boolean(snapshot?.permissions.length || snapshot?.solutions.length);
  const busy = event?.status === 'running' || event?.status === 'queued';
  const excerpt = useMemo(() => !busy && event?.result ? resultExcerpt(event.result.text) : '', [busy, event?.result?.text]);
  return <section className="friends-event-stage" data-status={needsResponse ? 'waiting_user' : event?.status ?? 'idle'}
    data-working={busy && !needsResponse} aria-live="polite">
    <div className="friends-execution-indicator" aria-hidden="true"><i/><i/><i/></div>
    {event && <p className="friends-execution-label">{event.origin === 'user' ? t('yourFriends.eventProgress') : event.title}</p>}
    <h1>{t(needsResponse ? 'yourFriends.awaitingResponse' : event ? `yourFriends.status.${event.status}` : 'yourFriends.runtimeReady')}</h1>
    {!event && <p className="friends-lead">{t('yourFriends.runtimeDescription')}</p>}
    {busy && !needsResponse && <p className="friends-lead">{t('yourFriends.workingDescription')}</p>}
    {excerpt && !needsResponse && <p className="friends-result-preview">{excerpt}</p>}
    {event?.error && <p className="your-friends-error" role="alert">{t(event.interruptedTurnId ? 'yourFriends.executionInterrupted' : 'yourFriends.executionFailed')}</p>}
    <div className="friends-event-actions">
      {event?.status === 'waiting_user' && !needsResponse && <button type="button" className="friends-primary" onClick={() => onContinue(event.id)}>{t('yourFriends.continue')}</button>}
      {needsResponse ? <button type="button" className="friends-primary friends-respond" onClick={onRespond}>{t('yourFriends.respond')}</button>
        : event && <button type="button" className="friends-text-button friends-view-details" onClick={() => onDetails(event.id)}>{t('yourFriends.viewDetails')}</button>}
      {event && (['queued', 'running', 'watching'].includes(event.status)
        ? <button type="button" className="friends-text-button" onClick={() => manage('pause', event.id)}>{t('yourFriends.pauseExecution')}</button>
        : ['paused', 'failed'].includes(event.status) && <button type="button" className="friends-text-button" onClick={() => manage('resume', event.id)}>{t('yourFriends.resumeExecution')}</button>)}
    </div>
  </section>;
}
