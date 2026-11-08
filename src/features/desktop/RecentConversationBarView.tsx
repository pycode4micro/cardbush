import { useId, useState, type ReactNode, type Ref } from 'react';
import { List, MessageSquare } from 'lucide-react';
import type { AppLanguage, ChatMessage, ConversationSummary } from '../../types';
import { uiText } from '../../i18n';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { fileUrl } from '../../shared/localPaths';

export type RecentTab = 'turns' | 'sessions';

export function RecentConversationBarView({ actions, language, title, selectedTitle, panelId, panelRef, expanded, tab, onTab, onToggle, onOpen, children }: {
  language: AppLanguage; title: string; selectedTitle: string; panelId: string; panelRef: Ref<HTMLElement>; expanded: boolean;
  actions?: ReactNode;
  tab: RecentTab; onTab(tab: RecentTab): void; onToggle(value: boolean): void; onOpen?: () => void; children: ReactNode;
}) {
  const t = uiText(language), tabId = useId();
  const tabs = [{ id: 'turns', label: t('recentBar.turns') }, { id: 'sessions', label: t('recentBar.sessions') }] as const;
  return <div className="recent-bar window-drag">
    <button className="recent-bar-chat no-drag" type="button" disabled={!onOpen} onClick={onOpen} aria-label={onOpen ? t('recentBar.open', { title }) : t('recentBar.sessions')} title={onOpen ? t('recentBar.open', { title }) : undefined}>
      <span className="recent-chat-copy"><strong>{title}</strong></span>
    </button>
    <div className="recent-bar-actions">
      {actions}
      <button className="recent-bar-list no-drag" type="button" disabled={!onOpen} popoverTarget={panelId}
        aria-controls={panelId} aria-expanded={expanded} aria-label={t('recentBar.navigator')} title={t('recentBar.navigator')}><List/></button>
    </div>
    <aside className="recent-turn-drawer no-drag" ref={panelRef} id={panelId} popover="auto"
      aria-label={t('recentBar.navigator')} onToggle={event => onToggle(event.newState === 'open')}>
      <div className="recent-tabs" role="tablist" aria-label={t('recentBar.navigator')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 'turns' : event.key === 'End' ? 'sessions' : tab === 'turns' ? 'sessions' : 'turns';
        onTab(next); event.currentTarget.querySelector<HTMLButtonElement>('[data-recent-tab="'+next+'"]')?.focus();
      }}>
        {tabs.map(item => <button key={item.id} id={tabId + item.id} type="button" role="tab" data-recent-tab={item.id}
          aria-controls={panelId + '-content'} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
          onClick={() => onTab(item.id)}>{item.label}</button>)}
      </div>
      <section role="tabpanel" id={panelId + '-content'} aria-labelledby={tabId + tab}>
        {tab === 'turns' && <h2>{selectedTitle}</h2>}
        {children}
      </section>
    </aside>
  </div>;
}

function RowTime({ at, language }: { at?: string; language: AppLanguage }) {
  if (!at) return null;
  const value = new Date(at);
  if (!Number.isFinite(+value)) return null;
  const today = new Date().toDateString() === value.toDateString();
  return <time dateTime={at} title={value.toLocaleString(language)}>{today
    ? value.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : value.toLocaleDateString(language, { month: 'short', day: 'numeric' })}</time>;
}

function Tile({ source, number, label }: { source?: string; number?: number; label?: string }) {
  const [failed, setFailed] = useState('');
  return <span className="recent-tile" aria-label={label}>
    {source && failed !== source ? <img src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(source)}/>
      : number != null ? number : <MessageSquare aria-hidden="true"/>}
  </span>;
}

export function ConversationRowContent({ title, conversation, language }: { title: string; conversation: ConversationSummary; language: AppLanguage }) {
  return <><Tile/><span className="recent-row-copy"><strong>{title}</strong><small>{conversationDisplayTitle(conversation.preview.slice(0, 360))}</small></span>
    <RowTime at={conversation.updatedAt} language={language}/></>;
}

export function TurnListView({ language, turns, select, loading, failed, loadingOlder, hasMore, more }: {
  language: AppLanguage; turns: { message: ChatMessage; reply?: ChatMessage }[]; select(message: ChatMessage): void; loading: boolean; failed: boolean;
  loadingOlder: boolean; hasMore: boolean; more(): void;
}) {
  const t = uiText(language);
  return <div className="recent-turn-scroll" aria-busy={loading || loadingOlder}>
    {loading ? <p role="status">{t('common.loading')}</p> : !turns.length && !failed && <p>{t('recentBar.empty')}</p>}
    {turns.length > 0 && <ol>{turns.map(({message, reply}) => {
      const title = conversationDisplayTitle(message.content.slice(0, 1000)) || message.attachments?.[0]?.name || t('quickContextRail.conversationTurn');
      const image = message.attachments?.find(item => item.type === 'image' && item.path)?.path;
      const number = message.turnSequence;
      return <li key={message.id}><button type="button" data-turn-message={message.id} onClick={() => select(message)}>
        <Tile source={image ? fileUrl(image) : undefined} number={number} label={number != null ? t('recentBar.number', {number}) : undefined}/>
        <span className="recent-row-copy"><strong className="recent-turn-text">{title}</strong>
          <small>{conversationDisplayTitle(reply?.content.slice(0, 360) ?? '') || t('quickContextRail.noReplyYet')}</small></span>
        <RowTime at={message.createdAt} language={language}/>
      </button></li>;
    })}</ol>}
    {failed && <p role="alert">{t('recentBar.loadFailed')}</p>}
    {(hasMore || failed) && <button type="button" className="recent-turn-more" disabled={loadingOlder} onClick={more}>
      {t(loadingOlder ? 'common.loading' : failed ? 'common.retry' : 'recentBar.earlier')}
    </button>}
  </div>;
}
