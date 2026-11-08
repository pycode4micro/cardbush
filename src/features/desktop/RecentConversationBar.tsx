import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { uiText } from '../../i18n';
import type { AppLanguage, ChatMessage, ConversationSummary } from '../../types';
import { useConversationArchives } from '../sidebar/conversationArchives';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { isBackendSupersededMessage } from '../chatMessages/transcript/messageFacts';
import { normalizeChatMessagesForDisplay } from '../chatMessages/transcript/messageProjection';
import { indexContextTurns, quickTurnPreviewMessages } from '../chat/quickContextIndex';
import { RecentConversationBarView, TurnListView, type RecentTab } from './RecentConversationBarView';
import './recentConversationBar.css';

const lastVisitKey = 'cardbush_last_opened_conversation';
const pageSize = 40;

// Streaming and restored histories can fold earlier assistant segments into a tool-only row.
function latestAssistantOutput(messages?: ChatMessage[]): string {
  if (!messages) return '';
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isBackendSupersededMessage(message) || message.role !== 'assistant') continue;
    const text = conversationDisplayTitle(message.content.slice(0, 600));
    if (text) return text;
    const preceding = latestAssistantOutput(message.loopHistory);
    if (preceding) return preceding;
  }
  return '';
}

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
  language: AppLanguage; conversation: ConversationSummary; conversations: ConversationSummary[]; inConversation?: boolean;
  transcripts: Record<string, ChatMessage[]>; pageFor(id: string): Page;
  open(id: string, message?: ChatMessage): void; onRecentList(value: RecentListOutlet | null): void;
};

export function RecentConversationBar({ language, conversation, conversations, inConversation = false, transcripts, pageFor, read, earlier, open, onRecentList }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<RecentTab>('turns');
  const [selectedId, setSelectedId] = useState('');
  const [browsedId, setBrowsedId] = useState('');
  const panel = useRef<HTMLElement>(null);
  const id = useId(), archived = useConversationArchives();
  useLayoutEffect(() => {
    panel.current?.hidePopover();
    setSelectedId('');
    setBrowsedId('');
  }, [conversation.id]);
  const timeline = useMemo(() => conversations.filter(item => !item.metadata?.hidden && !archived.has(item.id))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)), [conversations, archived]);
  const current = (!inConversation && timeline.find(item => item.id === browsedId)) || conversation;
  const position = timeline.findIndex(item => item.id === current.id);
  const previous = position >= 0 ? timeline[position + 1] : undefined;
  const next = position > 0 ? timeline[position - 1] : undefined;
  const switchConversation = (target: ConversationSummary) => {
    if (inConversation) open(target.id);
    else setBrowsedId(target.id);
    setSelectedId('');
  };
  const currentMessages = transcripts[current.id];
  const output = useMemo(() => latestAssistantOutput(currentMessages) || conversationDisplayTitle(current.assistantPreview ?? ''),
    [currentMessages, current.assistantPreview]);
  const selected = conversations.find(item => item.id === selectedId && !archived.has(item.id) && !item.metadata?.hidden) ?? current;
  const name = (item: ConversationSummary) => conversationDisplayTitle(item.title) || uiText(language)('composer.newConversation');
  const enter = useCallback((id: string, message?: ChatMessage) => {
    panel.current?.hidePopover();
    open(id, message);
  }, [open]);
  const browse = useCallback((id: string) => {
    setSelectedId(id); setTab('turns');
    panel.current?.querySelector<HTMLButtonElement>('[data-recent-tab="turns"]')?.focus({ preventScroll: true });
  }, []);
  return <RecentConversationBarView language={language} title={name(current)} output={output} selectedTitle={name(selected)} panelId={id}
    previous={previous && (() => switchConversation(previous))} next={next && (() => switchConversation(next))}
    panelRef={panel} expanded={expanded} tab={tab} onTab={setTab} onOpen={() => enter(current.id)}
    onToggle={value => { setExpanded(value); if (!value) { setTab('turns'); setSelectedId(''); } }}>
    {expanded && (tab === 'sessions'
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

  const transcript = useMemo(() => indexContextTurns(normalizeChatMessagesForDisplay(messages ?? [])), [messages]);
  const turns = useMemo(() => {
    const seen = new Set<string>();
    return transcript.turns.filter(message => {
      const key = message.turnId || message.id;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).reverse();
  }, [transcript]);
  const visible = useMemo(() => turns.slice(0, limit).map(message => {
    const reply = quickTurnPreviewMessages(transcript.messagesFor(message.id)).find(row => row.role === 'assistant');
    return { message, reply };
  }), [transcript, turns, limit]);
  const more = async () => {
    if (failed) { setRetry(value => value + 1); return; }
    if (turns.length <= limit && page.hasMore) await earlier(sessionId);
    setLimit(value => value + pageSize);
  };
  return <TurnListView language={language} turns={visible} select={select}
    loading={!loaded && !failed} failed={failed || Boolean(page.historyError)} loadingOlder={page.loadingOlder}
    hasMore={turns.length > limit || page.hasMore} more={more}/>;
}
