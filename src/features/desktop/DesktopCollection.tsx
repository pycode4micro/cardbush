import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, FileText, Pause, Play, Square, Trash2 } from 'lucide-react';
import type { FriendsWorkEvent } from '@cardbush/bush-protocol';
import type { AppLanguage, AppSection, ConversationSummary, ProjectItem } from '../../types';
import { uiText } from '../../i18n';
import { useApplications } from '../appCenter/appCenterStore';
import { useLaunchApplication } from '../appCenter/AppCenter';
import { recentVisibleConversations, useConversationArchives } from '../sidebar/conversationArchives';
import { useComponents } from '../components/componentStore';
import { useAssistantProfile } from '../assistant/assistantProfile';
import { useEventExecution } from '../assistant/events/useEventExecution';
import { eventBackend } from '../assistant/events/eventBackend';
import { confirmEventDeletion, eventActionLabels, type EventAction } from '../assistant/events/eventManagement';
import { useSidebarContextMenu, type SidebarMenuEvent, type SidebarContextMenuItem } from '../sidebar/SidebarContextMenu';
import { showUiError } from '../../shared/showUiError';
import type { HomePage } from '../navigation/appPage';
import type { PageOffsets } from '../navigation/usePageScroll';
import { DesktopHomeView, ExploreView, type LibraryReadingState } from './DesktopCollectionView';
import './desktopCollection.css';

type Props = {
  projectsRef: (element: HTMLDivElement | null) => void;
  language: AppLanguage; page: HomePage; ready: boolean; unavailable: boolean; visible: boolean; conversationsLoading: boolean;
  projects: ProjectItem[]; conversations: ConversationSummary[]; onPage(page: HomePage): void;
  onProject(project: ProjectItem): void; onConversation(id: string): void; onAssistant(): void;
  onCreateComponent(draft:string): void; onNew(): void; onAddProject(): void; onExplore(): void;
};
// Keep small browsing preferences at the window boundary. Only the current page
// mounts its library, event polling, project portal and embedded documents.
export function DesktopCollection({section, ...props}: Props & {section: AppSection}) {
  const [reading] = useState<LibraryReadingState>(() => ({offsets: new Map(), detailOffsets: new Map(), expanded: new Set()}));
  const [query, setQuery] = useState('');
  const needsEvents = props.page.kind === 'overview' || props.page.kind === 'events' || props.page.kind === 'event';
  const execution = useEventExecution(section === 'home' && props.ready && props.visible && needsEvents, props.page.kind === 'event' ? 1500 : 15000);
  if (section === 'home') return <DesktopHome {...props} execution={execution} reading={reading}/>;
  if (section === 'explore') return <DesktopExplore language={props.language} offsets={reading.offsets} query={query} onQuery={setQuery}/>;
  return null;
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
    const items: SidebarContextMenuItem[] = [{ key: 'details', icon: <FileText/>, label: t('featureContentPanel.details'),
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
function DesktopExplore({language, offsets, query, onQuery}: {language: AppLanguage; offsets: PageOffsets; query: string; onQuery(value: string): void}) {
  const apps = useApplications(language);
  const launch = useLaunchApplication();
  const needle = query.trim().toLocaleLowerCase(language);
  const matches = apps.filter(app => [app.title, app.description].some(value => value.toLocaleLowerCase(language).includes(needle)));
  const t = uiText(language);
  const groups = [
    {label: t('desktop.workspaceApps'), entries: matches.filter(app => app.kind === 'builtin')},
    {label: t('desktop.addedApps'), entries: matches.filter(app => app.kind !== 'builtin')},
  ].filter(group => group.entries.length);
  return <ExploreView language={language} offsets={offsets} groups={groups} query={query} onQuery={onQuery}
    featured={needle ? [] : ['builtin:md-presentation','builtin:team'].flatMap(id => apps.find(app => app.id === id) ?? [])}
    onLaunch={launch}/>;
}
