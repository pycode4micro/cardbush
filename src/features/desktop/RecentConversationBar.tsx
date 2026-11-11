import { PERSONAL_ASSISTANT_SESSION } from '@cardbush/bush-protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AppLanguage, ConversationSummary } from '../../types';
import { recentVisibleConversations } from '../sidebar/conversationArchives';
import { RecentConversationBarView, NotificationListView, type RecentTab } from './RecentConversationBarView';
import type { WorkspaceNotice } from './workspaceNotifications';
import './recentConversationBar.css';

const pageSize = 40;

export type RecentListOutlet = {
  element: HTMLElement; selectedId: string; limit: number; enter(id: string): void; more(): void;
};
type Props = {
  actions?: ReactNode;
  language: AppLanguage; assistantName: string; selectedId: string; conversations: ConversationSummary[];
  notices: WorkspaceNotice[]; openNotice(notice: WorkspaceNotice): void;
  open(id: string): void; onRecentList(value: RecentListOutlet | null): void;
};

export function RecentConversationBar({ actions, language, assistantName, selectedId, conversations, open, onRecentList, notices, openNotice }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [present, setPresent] = useState(false);
  const toggleVersion = useRef(0);
  const [tab, setTab] = useState<RecentTab>('sessions');
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    // The native popover handles clicks in this document. Guest pages and other
    // windows receive their own input, so also observe those focus changes.
    const drawer = panel.current;
    const dismiss = () => drawer?.hidePopover();
    const openWorkspaceTool = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('.window-chat-actions button')) dismiss();
    };
    // Portal actions can move or unmount during their own click handler.
    drawer?.addEventListener('click', openWorkspaceTool, true);
    const offGuest = window.cardbushDesktop?.onInspectorGuestActivated?.(dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      offGuest?.();
      drawer?.removeEventListener('click', openWorkspaceTool, true);
      window.removeEventListener('blur', dismiss);
    };
  }, []);
  const enter = useCallback((id: string) => {
    panel.current?.hidePopover();
    open(id);
  }, [open]);
  const togglePanel = (open: boolean) => {
    const version = ++toggleVersion.current;
    setExpanded(open);
    if (open) { setTab(notices.length ? 'notifications' : 'sessions'); setPresent(true); return; }
    // Keep the current list visible until the native popover has slid out of the top layer.
    const finish = () => {
      if (version !== toggleVersion.current || !panel.current || panel.current.matches(':popover-open')) return;
      setPresent(false);
    };
    const animations = panel.current?.getAnimations();
    if (animations?.length) void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    else finish();
  };
  return <RecentConversationBarView actions={actions} language={language} panelId={id}
    panelRef={panel} expanded={expanded} unread={notices.length} tab={tab} onTab={setTab}
    onBrowse={() => {
      panel.current?.showPopover();
      requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus());
    }}
    onActivate={() => {
      const latest = recentVisibleConversations(conversations)[0];
      if (latest) enter(latest.id);
      else panel.current?.showPopover();
    }} onToggle={togglePanel}>
    {present && (tab === 'notifications' ? <NotificationListView notices={notices} language={language}
      open={notice => { panel.current?.hidePopover(); openNotice(notice); }}/>
      : <RecentSessions selectedId={selectedId} register={onRecentList} enter={enter}>
          {selectedId === PERSONAL_ASSISTANT_SESSION && <button type="button" className="recent-assistant-session"
            data-recent-session={PERSONAL_ASSISTANT_SESSION} onClick={() => enter(PERSONAL_ASSISTANT_SESSION)}>{assistantName}</button>}
        </RecentSessions>)}
  </RecentConversationBarView>;
}

/** The same conversation rows own actions in the drawer, projects and pinned list. */
function RecentSessions({ register, children, selectedId, enter }: { children: ReactNode; register: Props['onRecentList']; selectedId: string; enter(id: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(pageSize);
  useLayoutEffect(() => {
    register({ element: host.current!, selectedId, enter, limit, more: () => setLimit(value => value + pageSize) });
    return () => register(null);
  }, [register, selectedId, enter, limit]);
  return <div className="recent-turn-scroll">{children}<div ref={host}/></div>;
}
