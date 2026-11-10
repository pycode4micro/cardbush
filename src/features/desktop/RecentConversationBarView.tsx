import { useId, useState, type ReactNode, type Ref } from 'react';
import { Bell, CircleAlert, CircleCheck, List, MessageCircleQuestion } from 'lucide-react';
import { EventReadButton } from '../automations/ConversationEventInbox';
import { sessionAttentionLabel } from '../sessionAttention';
import type { WorkspaceNotice } from './workspaceNotifications';
import type { AppLanguage, ConversationSummary } from '../../types';
import { uiText } from '../../i18n';

export type RecentTab = 'pinned' | 'sessions' | 'notifications';

export function RecentConversationBarView({ actions, language, assistant, panelId, panelRef, expanded, unread, tab, onTab, onToggle, children }: {
  language: AppLanguage; assistant: ReactNode; panelId: string; panelRef: Ref<HTMLElement>; expanded: boolean;
  actions?: ReactNode;
  unread: number;
  tab: RecentTab; onTab(tab: RecentTab): void; onToggle(value: boolean): void; children: ReactNode;
}) {
  const t = uiText(language), tabId = useId();
  const tabs = [{ id: 'pinned', label: t('chatSidebar.pinned') }, { id: 'sessions', label: t('recentBar.sessions') }, { id: 'notifications', label: t('recentBar.notifications') }] as const;
  const listLabel = unread ? t('recentBar.navigatorUnread', { count: unread }) : t('recentBar.navigator');
  return <div className="recent-bar window-drag">
    {assistant}
    <div className="recent-bar-actions">
      {actions}
      <button className="recent-bar-list no-drag" type="button" popoverTarget={panelId}
        data-unread={unread > 0 || undefined} aria-controls={panelId} aria-expanded={expanded} aria-label={listLabel} title={listLabel}>
        <List aria-hidden="true"/>{unread > 0 && <span className="recent-unread-dot" aria-hidden="true"/>}</button>
    </div>
    <aside className="recent-turn-drawer no-drag" ref={panelRef} id={panelId} popover="auto"
      aria-label={t('recentBar.navigator')} onToggle={event => onToggle(event.newState === 'open')}>
      <div className="recent-tabs" role="tablist" aria-label={t('recentBar.navigator')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = tabs.findIndex(item => item.id === tab);
        const next = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
          (index + tabs.length + (event.key === 'ArrowRight' ? 1 : -1)) % tabs.length].id;
        onTab(next); event.currentTarget.querySelector<HTMLElement>('[data-recent-tab="'+next+'"]')?.focus();
      }}>
        {tabs.map(item => <span key={item.id} id={tabId + item.id} role="tab" data-recent-tab={item.id}
          aria-controls={panelId + '-content'} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1}
          onPointerEnter={event => { if (event.pointerType === 'mouse' && tab !== item.id) onTab(item.id); }}
          onFocus={() => onTab(item.id)} onClick={() => onTab(item.id)}>{item.label}{item.id === 'notifications' && unread > 0 &&
            <span className="recent-unread-count">{new Intl.NumberFormat(language, { notation: 'compact' }).format(unread)}</span>}</span>)}
      </div>
      <section role="tabpanel" id={panelId + '-content'} aria-labelledby={tabId + tab}>
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

export function NotificationListView({ notices, language, open }: {
  notices: WorkspaceNotice[]; language: AppLanguage; open(notice: WorkspaceNotice): void;
}) {
  const t = uiText(language);
  const [limit, setLimit] = useState(40);
  return <div className="recent-turn-scroll recent-notifications">
    {!notices.length ? <p className="recent-notifications-empty" role="status"><Bell aria-hidden="true"/>{t('recentBar.noNotifications')}</p> :
      <ol>{notices.slice(0, limit).map(notice => {
        const event = notice.type === 'event';
        const Icon = event ? Bell : notice.item.kind === 'error' ? CircleAlert : notice.item.kind === 'interaction' ? MessageCircleQuestion : CircleCheck;
        const status = event ? t('recentBar.eventResult', { status: t(notice.item.status === 'awaiting_user_action' ? 'automationPanel.needsAttention' : `automationPanel.${notice.item.status}`) }) : sessionAttentionLabel(notice.item, language);
        return <li key={notice.key} className="recent-notification">
          <button type="button" className="recent-notification-open" onClick={() => open(notice)}>
            <Icon aria-hidden="true"/><span className="recent-notification-copy"><small>{status}</small><strong>{notice.item.title}</strong>
              <span>{event ? notice.item.summary : notice.item.body}</span></span><RowTime at={notice.at} language={language}/>
          </button>
          {event && <EventReadButton item={notice.item} language={language}/>}
        </li>;
      })}</ol>}
    {notices.length > limit && <button className="recent-turn-more" type="button" onClick={() => setLimit(value => value + 40)}>{t('recentBar.moreNotifications')}</button>}
  </div>;
}

export function ConversationRowContent({ title, conversation, language }: { title: string; conversation: ConversationSummary; language: AppLanguage }) {
  return <><strong className="recent-row-copy">{title}</strong>
    <RowTime at={conversation.updatedAt} language={language}/></>;
}
