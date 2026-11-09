import { useMemo, useState } from 'react';
import type { AppLanguage, ConversationSummary, ProjectItem } from '../../types';
import { uiText } from '../../i18n';
import { useApplications } from '../appCenter/appCenterStore';
import { useLaunchApplication } from '../appCenter/AppCenter';
import { useConversationArchives } from '../sidebar/conversationArchives';
import { useComponents } from '../components/componentStore';
import { useAssistantProfile } from '../assistant/assistantProfile';
import { useEventExecution } from '../assistant/events/useEventExecution';
import type { HomePage } from '../navigation/appPage';
import { DesktopHomeView, ExploreView } from './DesktopCollectionView';
import './desktopCollection.css';

type Props = {
  projectsRef: (element: HTMLDivElement | null) => void;
  language: AppLanguage; page: HomePage; ready: boolean; unavailable: boolean; visible: boolean; conversationsLoading: boolean;
  projects: ProjectItem[]; conversations: ConversationSummary[]; onPage(page: HomePage): void;
  onProject(project: ProjectItem): void; onConversation(id: string): void; onAssistant(): void;
  onCreateComponent(draft:string): void; onNew(): void; onAddProject(): void; onExplore(): void;
};
export function DesktopHome(props: Props) {
  const needsEvents = props.page.kind === 'overview' || props.page.kind === 'events' || props.page.kind === 'event';
  const { snapshot, error, refresh } = useEventExecution(props.ready && props.visible && needsEvents, props.page.kind === 'event' ? 1500 : 15000);
  const archived = useConversationArchives();
  const collection = useComponents();
  const components = collection.items;
  const profile = useAssistantProfile();
  const projects = useMemo(() => props.projects.filter(project => !project.archived), [props.projects]);
  const conversations = useMemo(() => props.conversations.filter(item => !archived.has(item.id) && !item.metadata?.hidden)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [props.conversations, archived]);
  const events = useMemo(() => (snapshot?.events ?? []).filter(event => !event.archived)
    .sort((a, b) => Number(b.status === 'waiting_user') - Number(a.status === 'waiting_user') || b.updatedAt.localeCompare(a.updatedAt)), [snapshot?.events]);
  return <DesktopHomeView {...props} assistantName={profile.name} projects={projects} conversations={conversations}
    components={components} events={events} snapshot={snapshot} error={error || props.unavailable} retry={refresh}/>;
}
export function DesktopExplore({language}: {language: AppLanguage}) {
  const apps = useApplications(language);
  const launch = useLaunchApplication();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase(language);
  const matches = apps.filter(app => [app.title, app.description].some(value => value.toLocaleLowerCase(language).includes(needle)));
  const t = uiText(language);
  const groups = [
    {label: t('desktop.workspaceApps'), entries: matches.filter(app => app.kind === 'builtin')},
    {label: t('desktop.addedApps'), entries: matches.filter(app => app.kind !== 'builtin')},
  ].filter(group => group.entries.length);
  return <ExploreView language={language} groups={groups} query={query} onQuery={setQuery}
    featured={needle ? [] : ['builtin:md-presentation','builtin:team'].flatMap(id => apps.find(app => app.id === id) ?? [])}
    onLaunch={launch}/>;
}
