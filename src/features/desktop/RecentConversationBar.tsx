import { compactConversationTitle } from '@cardbush/bush-protocol';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { uiText } from '../../i18n';
import type { AppLanguage, ChatMessage, ConversationSummary } from '../../types';
import { useConversationArchives } from '../sidebar/conversationArchives';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { normalizeChatMessagesForDisplay } from '../chatMessages/transcript/messageProjection';
import { isContextGuidance } from '../chat/quickContextIndex';
import { RecentConversationBarView, TurnListView, type RecentTab } from './RecentConversationBarView';
import './recentConversationBar.css';

const lastVisitKey = 'cardbush_last_opened_conversation';
const pageSize = 40;

export function useRecentConversation(conversations: ConversationSummary[], visibleChatId: string) {
  const archived = useConversationArchives();
  const [lastVisit, setLastVisit] = useState(() => localStorage.getItem(lastVisitKey) ?? '');
  const available = useMemo(() => conversations.filter(item => !item.metadata?.hidden && !archived.has(item.id)), [conversations, archived]);
  const visited = useMemo(() => available.find(item => item.id === visibleChatId), [available, visibleChatId]);
  useEffect(() => {
    if (!visited || visited.id === lastVisit) return;
    localStorage.setItem(lastVisitKey, visited.id);
    setLastVisit(visited.id);
  }, [visited, lastVisit]);
  return useMemo(() => visited ?? available.find(item => item.id === lastVisit) ??
    available.reduce<ConversationSummary | undefined>((latest, item) => !latest || item.updatedAt > latest.updatedAt ? item : latest, undefined),
    [available, lastVisit, visited]);
}

export type RecentListOutlet = {
  element: HTMLElement; selectedId: string; limit: number; select(id: string): void; enter(id: string): void; more(): void;
};
type Page = { hasMore: boolean; loadingOlder: boolean; historyError: string };
type HistoryActions = { read(id: string): Promise<unknown>; earlier(id: string): Promise<void> };
type Props = HistoryActions & {
  actions?: ReactNode;
  language: AppLanguage; conversation?: ConversationSummary; conversations: ConversationSummary[];
  transcripts: Record<string, ChatMessage[]>; pageFor(id: string): Page;
  open(id: string, message?: ChatMessage): void; onRecentList(value: RecentListOutlet | null): void;
};

export function RecentConversationBar({ actions, language, conversation, conversations, transcripts, pageFor, read, earlier, open, onRecentList }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [present, setPresent] = useState(false);
  const toggleVersion = useRef(0);
  const [tab, setTab] = useState<RecentTab>('turns');
  const [selectedId, setSelectedId] = useState('');
  const panel = useRef<HTMLElement>(null);
  const id = useId(), archived = useConversationArchives();
  useLayoutEffect(() => {
    const node = panel.current!;
    const docked = window.matchMedia('(min-width: 1050px)');
    const syncMode = () => {
      const open = node.matches(':popover-open');
      node.popover = docked.matches ? 'manual' : 'auto';
      if (open && !node.matches(':popover-open')) node.showPopover();
    };
    // A docked list stays available while browsing the adjacent shelf.
    // Narrow overlays retain the browser's light-dismiss and Escape handling.
    const dismissDocked = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !docked.matches || !node.matches(':popover-open')) return;
      if (document.querySelector('dialog:modal, [popover]:popover-open:not(.recent-turn-drawer)') ||
        Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(dialog => dialog.checkVisibility())) return;
      const wasFocused = node.contains(document.activeElement);
      node.hidePopover();
      if (wasFocused) node.parentElement?.querySelector<HTMLButtonElement>('.recent-bar-list')?.focus();
      event.preventDefault();
    };
    syncMode();
    docked.addEventListener('change', syncMode);
    window.addEventListener('keydown', dismissDocked);
    return () => {
      docked.removeEventListener('change', syncMode);
      window.removeEventListener('keydown', dismissDocked);
    };
  }, []);
  useLayoutEffect(() => {
    panel.current?.hidePopover();
    setSelectedId('');
  }, [conversation?.id]);
  const selected = conversations.find(item => item.id === selectedId && !archived.has(item.id) && !item.metadata?.hidden) ?? conversation;
  const name = (item: ConversationSummary) => conversationDisplayTitle(item.title) || uiText(language)('composer.newConversation');
  const enter = useCallback((id: string, message?: ChatMessage) => {
    panel.current?.hidePopover();
    open(id, message);
  }, [open]);
  const browse = useCallback((id: string) => {
    setSelectedId(id); setTab('turns');
    panel.current?.querySelector<HTMLButtonElement>('[data-recent-tab="turns"]')?.focus({ preventScroll: true });
  }, []);
  const togglePanel = (open: boolean) => {
    const version = ++toggleVersion.current;
    setExpanded(open);
    if (open) { setPresent(true); return; }
    // Keep the current list visible until the native popover has slid out of the top layer.
    const finish = () => {
      if (version !== toggleVersion.current || !panel.current || panel.current.matches(':popover-open')) return;
      setPresent(false); setTab('turns'); setSelectedId('');
    };
    const animations = panel.current?.getAnimations();
    if (animations?.length) void Promise.allSettled(animations.map(animation => animation.finished)).then(finish);
    else finish();
  };
  return <RecentConversationBarView actions={actions} language={language} title={conversation ? compactConversationTitle(name(conversation)) : ''} selectedTitle={selected ? name(selected) : ''} panelId={id}
    panelRef={panel} expanded={expanded} tab={tab} onTab={setTab} onOpen={conversation ? () => enter(conversation.id) : undefined}
    onToggle={togglePanel}>
    {present && selected && (tab === 'sessions'
      ? <RecentSessions selectedId={selected.id} register={onRecentList} select={browse} enter={enter}/>
      : <TurnList key={selected.id} language={language} sessionId={selected.id} messages={transcripts[selected.id]}
          page={pageFor(selected.id)} read={read} earlier={earlier} select={message => enter(selected.id, message)}/>)}
  </RecentConversationBarView>;
}

/** The same conversation rows own actions in the drawer, projects and pinned list. */
function RecentSessions({ register, selectedId, select, enter }: { register: Props['onRecentList']; selectedId: string; select(id: string): void; enter(id: string): void }) {
  const host = useRef<HTMLDivElement>(null);
  const [limit, setLimit] = useState(pageSize);
  useLayoutEffect(() => {
    register({ element: host.current!, selectedId, select, enter, limit, more: () => setLimit(value => value + pageSize) });
    return () => register(null);
  }, [register, selectedId, select, enter, limit]);
  return <div className="recent-turn-scroll" ref={host}/>;
}

function TurnList({ language, sessionId, read, messages, page, earlier, select }: HistoryActions & {
  language: AppLanguage; sessionId: string; messages?: ChatMessage[]; page: Page; select(message: ChatMessage): void;
}) {
  const [limit, setLimit] = useState(pageSize);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const loaded = messages !== undefined;
  useEffect(() => {
    if (loaded) return;
    let active = true;
    setFailed(false);
    void read(sessionId).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [sessionId, loaded, read, retry]);

  const turns = useMemo(() => {
    const seen = new Set<string>();
    return normalizeChatMessagesForDisplay(messages ?? []).filter(message => {
      if (message.role !== 'user' || isContextGuidance(message)) return false;
      const key = message.turnId || message.id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).reverse();
  }, [messages]);
  const more = async () => {
    if (failed) { setRetry(value => value + 1); return; }
    if (turns.length <= limit && page.hasMore) await earlier(sessionId);
    setLimit(value => value + pageSize);
  };
  return <TurnListView language={language} turns={turns.slice(0, limit)} select={select}
    loading={!loaded && !failed} failed={failed || Boolean(page.historyError)} loadingOlder={page.loadingOlder}
    hasMore={turns.length > limit || page.hasMore} more={more}/>;
}
