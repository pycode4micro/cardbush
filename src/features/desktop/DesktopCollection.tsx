import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FileText, Pause, Play, Square, Trash2 } from 'lucide-react';
import type { FriendsWorkEvent } from '@cardbush/bush-protocol';
import type { AppLanguage, AppSection, ConversationSummary, ProjectItem } from '../../types';
import { uiText } from '../../i18n';
import { recentVisibleConversations, useConversationArchives } from '../sidebar/conversationArchives';
import { useComponents } from '../components/componentStore';
import { useAssistantProfile } from '../assistant/assistantProfile';
import { useEventExecution } from '../assistant/events/useEventExecution';
import { eventBackend } from '../assistant/events/eventBackend';
import { confirmEventDeletion, eventActionLabels, type EventAction } from '../assistant/events/eventManagement';
import { useSidebarContextMenu, type SidebarMenuEvent, type SidebarContextMenuItem } from '../sidebar/SidebarContextMenu';
import { showUiError } from '../../shared/showUiError';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import type { HomePage } from '../navigation/appPage';
import { DesktopHomeView, type LibraryReadingState } from './DesktopCollectionView';
import './desktopCollection.css';

type Props = {
  projectsRef: (element: HTMLDivElement | null) => void;
  language: AppLanguage; page: HomePage; ready: boolean; unavailable: boolean; visible: boolean; conversationsLoading: boolean;
  projects: ProjectItem[]; conversations: ConversationSummary[]; onPage(page: HomePage): void;
  onProject(project: ProjectItem): void; onConversation(id: string): void; onAssistant(): void;
  onCreateComponent(draft:string): void; onNew(): void; onAddProject(): void;
};
// Retain a visited Home and its live guests; only active Home pages poll events.
// Activity would disconnect guest effects and reload their src on return.
export function DesktopCollection({section, ...props}: Props & {section: AppSection}) {
  const [reading] = useState<LibraryReadingState>(() => ({offsets: new Map(), detailOffsets: new Map(), expanded: new Set()}));
  const active = section === 'home' && props.visible;
  const home = useSoftPanelPresence(active, 0, {keepMounted:true});
  const needsEvents = props.page.kind === 'overview' || props.page.kind === 'events' || props.page.kind === 'event';
  const execution = useEventExecution(active && props.ready && needsEvents, props.page.kind === 'event' ? 1500 : 15000);
  return home.mounted ? <DesktopHome {...props} visible={active} execution={execution} reading={reading}/> : null;
}
function DesktopHome(props: Props & {execution: ReturnType<typeof useEventExecution>; reading: LibraryReadingState}) {
  const { snapshot, error, refresh, refreshAfterChange } = props.execution;
  const { menu, openContextMenu, closeMenus } = useSidebarContextMenu();
  useEffect(closeMenus, [props.page, props.visible, closeMenus]);
  const pending = useRef(false);
  const t = uiText(props.language);
  async function manage(action: EventAction, event: FriendsWorkEvent) {
    if (pending.current) return;
    pending.current = true;
    try {
      if (action === 'delete' && !await confirmEventDeletion(event, props.language)) return;
      await eventBackend.manage(action, event.id);
      await refreshAfterChange();
    } catch {
      await refreshAfterChange();
      await showUiError(t('app.actionFailed'), t('assistant.events.manageFailed', { title: event.title }));
    } finally { pending.current = false; }
  }
  function openEventMenu(trigger: SidebarMenuEvent, event: FriendsWorkEvent) {
    if (pending.current) { trigger.preventDefault(); return; }
    const items: SidebarContextMenuItem[] = [{ key: 'details', icon: <FileText/>, label: t('common.details'),
      onClick: () => props.onPage({ kind: 'event', id: event.id }) }];
    const add = (action: EventAction, icon: SidebarContextMenuItem['icon']) => items.push({
      key: action, icon, label: t(eventActionLabels[action]),
      danger: action === 'delete', separatorBefore: action === 'delete', onClick: () => void manage(action, event),
    });
    if (event.status === 'paused' || event.status === 'failed') add('resume', <Play/>);
    else if (event.conversationExecution && (event.status === 'running' || event.status === 'queued')) add('stop', <Square/>);
    else if (event.status !== 'completed') add('pause', <Pause/>);
    add('archive', <Archive/>);
    add('delete', <Trash2/>);
    openContextMenu(trigger, event.id, items);
  }
  const archived = useConversationArchives();
  const collection = useComponents();
  const components = collection.items;
  const profile = useAssistantProfile();
  const projects = useMemo(() => props.projects.filter(project => !project.archived), [props.projects]);
  const conversations = useMemo(() => recentVisibleConversations(props.conversations, archived), [props.conversations, archived]);
  const events = useMemo(() => (snapshot?.events ?? []).filter(event => !event.archived)
    .sort((a, b) => Number(b.status === 'waiting_user') - Number(a.status === 'waiting_user') || b.updatedAt.localeCompare(a.updatedAt)), [snapshot?.events]);
  return <><DesktopHomeView {...props} assistantName={profile.name} projects={projects} conversations={conversations}
    components={components} events={events} snapshot={snapshot} error={error || props.unavailable} retry={refresh} onEventMenu={openEventMenu}/>{menu}</>;
}
