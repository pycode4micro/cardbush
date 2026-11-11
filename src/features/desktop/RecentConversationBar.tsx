import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AppLanguage } from '../../types';
import { AssistantStageButton } from './AssistantStageButton';
import { RecentConversationBarView, NotificationListView, type RecentTab } from './RecentConversationBarView';
import type { WorkspaceNotice } from './workspaceNotifications';
import './recentConversationBar.css';

const pageSize = 40;

export type RecentListOutlet = {
  element: HTMLElement; tab: Exclude<RecentTab, 'notifications'>; selectedId: string; limit: number; enter(id: string): void; more(): void;
};
type Props = {
  actions?: ReactNode;
  composerObscured?: boolean;
  language: AppLanguage; assistantName: string; selectedId: string;
  notices: WorkspaceNotice[]; openNotice(notice: WorkspaceNotice): void;
  open(id: string, returnToCall?: boolean): void; onRecentList(value: RecentListOutlet | null): void;
};

export function RecentConversationBar({ actions, composerObscured, language, assistantName, selectedId, open, onRecentList, notices, openNotice }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [present, setPresent] = useState(false);
  const toggleVersion = useRef(0);
  const [tab, setTab] = useState<RecentTab>('pinned');
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    if (!expanded) return;
    // The native popover handles clicks in this document. Guest pages and other
    // windows receive their own input, so also observe those focus changes.
    const dismiss = () => panel.current?.hidePopover();
    const offGuest = window.cardbushDesktop?.onInspectorGuestActivated?.(dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      offGuest?.();
      window.removeEventListener('blur', dismiss);
    };
  }, [expanded]);
  const enter = useCallback((id: string, returnToCall = false) => {
    panel.current?.hidePopover();
    open(id, returnToCall);
  }, [open]);
  const togglePanel = (open: boolean) => {
    const version = ++toggleVersion.current;
    setExpanded(open);
    if (open) { setTab(notices.length ? 'notifications' : 'pinned'); setPresent(true); return; }
    // Keep the current list visible until the native popover has slid out of the top layer.
    const finish = () => {
      if (version !== toggleVersion.current || !panel.current || panel.current.matches(':popover-open')) return;
      setPresent(false); setTab('pinned');
    };
    const animations = panel.current?.getAnimations();
    if (animations?.length) void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    else finish();
  };
  return <RecentConversationBarView actions={actions} language={language} panelId={id}
    panelRef={panel} expanded={expanded} unread={notices.length} tab={tab} onTab={setTab}
    assistant={<AssistantStageButton language={language} active={selectedId === PERSONAL_ASSISTANT_SESSION}
      composerObscured={composerObscured} onOpen={() => enter(PERSONAL_ASSISTANT_SESSION)} onReturnToCall={id => enter(id, true)}/>} onToggle={togglePanel}>
    {present && (tab === 'notifications' ? <NotificationListView notices={notices} language={language}
      open={notice => { panel.current?.hidePopover(); openNotice(notice); }}/>
      : <RecentSessions key={tab} tab={tab} selectedId={selectedId} register={onRecentList} enter={enter}>
          {tab === 'sessions' && selectedId === PERSONAL_ASSISTANT_SESSION && <button type="button" className="recent-assistant-session"
            data-recent-session={PERSONAL_ASSISTANT_SESSION} onClick={() => enter(PERSONAL_ASSISTANT_SESSION)}>{assistantName}</button>}
        </RecentSessions>)}
  </RecentConversationBarView>;
}

/** The same conversation rows own actions in the drawer, projects and pinned list. */
function RecentSessions({ register, tab, children, selectedId, enter }: { tab: RecentListOutlet['tab']; children: ReactNode; register: Props['onRecentList']; selectedId: string; enter(id: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(pageSize);
  useLayoutEffect(() => {
    register({ element: host.current!, tab, selectedId, enter, limit, more: () => setLimit(value => value + pageSize) });
    return () => register(null);
  }, [register, tab, selectedId, enter, limit]);
  return <div className="recent-turn-scroll">{children}<div ref={host}/></div>;
}
