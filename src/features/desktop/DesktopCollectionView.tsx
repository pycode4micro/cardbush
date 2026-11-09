import { useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { ArrowUpRight, Blocks, ChevronLeft, ChevronRight, Folder, MessageSquare, Plus, Search, Waves } from 'lucide-react';
import type { EventPresentation, FriendsSnapshot, FriendsWorkEvent } from '@cardbush/bush-protocol';
import { uiText } from '../../i18n';
import type { AppLanguage, ConversationSummary, ProjectItem } from '../../types';
import { ApplicationIcon } from '../appCenter/AppCenter';
import type { ApplicationEntry } from '../appCenter/appCenterModel';
import { FriendsEventDetails, FriendsExecutionRequests } from '../assistant/events/EventDetails';
import { AutomationCalendar } from '../automations/AutomationCalendar';
import { ComponentsApp } from '../components/ComponentsApp';
import { HtmlComponentSurface } from '../components/HtmlComponentSurface';
import { HtmlComponentContext } from '../components/HtmlComponentContext';
import type { HtmlComponent } from '../components/componentModel';
import { conversationMatchesScope } from '../conversationScope';
import type { HomePage } from '../navigation/appPage';

function trackHeaderUnderlap(event: UIEvent<HTMLElement>) {
  const page = event.currentTarget;
  if (page.hasAttribute('data-header-underlap') !== (page.scrollTop > 0)) {
    page.toggleAttribute('data-header-underlap', page.scrollTop > 0);
  }
}

type Cover = EventPresentation['cover'];
type Card = {art: Cover; title: string; caption: string; summary?: string; open(): void};
function CoverCard({card}: {card?: Card}) {
  if (!card) return <div className="desktop-cover desktop-cover-pending" aria-hidden="true"/>;
  return <button type="button" className="desktop-cover" data-cover={card.art} onClick={card.open}>
    <span className="desktop-cover-copy"><small>{card.caption}</small><strong>{card.title}</strong>{card.summary && <span>{card.summary}</span>}</span>
    <ArrowUpRight aria-hidden="true"/>
  </button>;
}
function FeaturedShelf({ language, busy, children }: { language: AppLanguage; busy: boolean; children: ReactNode }) {
  const t = uiText(language);
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ previous: false, next: false });
  useLayoutEffect(() => {
    const node = track.current!;
    const measure = () => {
      const previous = node.scrollLeft > 1;
      const next = node.scrollWidth - node.clientWidth - node.scrollLeft > 1;
      setEdges(old => old.previous === previous && old.next === next ? old : { previous, next });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    node.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener('scroll', measure); };
  }, []);
  const scroll = (direction: number) => {
    const node = track.current;
    if (node) node.scrollBy({ left: direction * node.clientWidth });
  };
  return <Shelf title={t('desktop.featured')}><div className="featured-carousel">
    <div className="desktop-covers" aria-busy={busy} ref={track}>{children}</div>
    <button className="featured-step" data-step="previous" type="button" aria-label={t('desktop.previousFeatured')}
      disabled={!edges.previous} onClick={() => scroll(-1)}><ChevronLeft aria-hidden="true"/></button>
    <button className="featured-step" data-step="next" type="button" aria-label={t('desktop.nextFeatured')}
      disabled={!edges.next} onClick={() => scroll(1)}><ChevronRight aria-hidden="true"/></button>
  </div></Shelf>;
}
function Shelf({title, open, children}: {title: string; open?: () => void; children: ReactNode}) {
  return <section className="desktop-shelf"><h2>{open ? <button type="button" onClick={open}>{title}<ChevronRight/></button> : title}</h2>{children}</section>;
}
function Row({title, detail, icon, open}: {title: string; detail?: string; icon: ReactNode; open(): void}) {
  return <button className="desktop-row" type="button" onClick={open}><span className="desktop-row-icon">{icon}</span>
    <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span><ChevronRight className="desktop-row-arrow"/></button>;
}
function ComponentPage({item, page}: {item: HtmlComponent; page?: EventPresentation['pages'][number]}) {
  const surface = <HtmlComponentSurface component={item} eventPage={page} active/>;
  return <div className="desktop-component">{page ? <HtmlComponentContext.Provider value={null}>{surface}</HtmlComponentContext.Provider> : surface}</div>;
}
type HomeProps = {
  projectsRef: (element: HTMLDivElement | null) => void;
  language: AppLanguage; page: HomePage; conversationsLoading: boolean; projects: ProjectItem[]; conversations: ConversationSummary[]; assistantName: string;
  events: FriendsWorkEvent[]; snapshot?: FriendsSnapshot; components: HtmlComponent[]; error: boolean; retry(): Promise<void>;
  onPage(page: HomePage): void; onProject(project: ProjectItem): void; onConversation(id: string): void;
  onAssistant(): void; onExplore(): void; onCreateComponent(draft:string): void; onNew(): void; onAddProject(): void;
};
export function DesktopHomeView(p: HomeProps) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const {language, page, events, projects, conversations, onPage} = p;
  const t = uiText(language), home = t('desktop.home'), recent = t('chatSidebar.recent'), projectLabel = t('archivedItemsPanel.projects'), eventLabel = t('desktop.events');
  const selected = page.kind === 'event' ? events.find(item => item.id === page.id) : undefined;
  const pages = selected?.presentation?.pages ?? [];
  const subpage = page.kind === 'event' ? pages.find(item => item.id === page.page) : undefined;
  const parents: EventPresentation['pages'] = [];
  for (let parentId = subpage?.parentId; parentId;) {
    const parent = pages.find(item => item.id === parentId);
    if (!parent || parents.includes(parent)) break;
    parents.unshift(parent);
    parentId = parent.parentId;
  }
  const children = pages.filter(item => item.parentId === subpage?.id);
  const project = page.kind === 'project' ? projects.find(item => item.id === page.id) : undefined;
  const component = page.kind === 'component' ? p.components.find(item => item.id === page.id) : undefined;
  const attached = subpage?.componentId ? p.components.find(item => item.id === subpage.componentId) : undefined;
  const heading = page.kind === 'overview' ? home : page.kind === 'events' ? eventLabel : page.kind === 'projects' ? projectLabel :
    page.kind === 'recent' ? recent : page.kind === 'event' ? subpage?.title ?? selected?.title ?? eventLabel : page.kind === 'component' ? component?.title ?? t('appCenterModel.components') : project?.title ?? projectLabel;
  const scroll = useRef<HTMLElement>(null);
  useLayoutEffect(() => { scroll.current?.scrollTo(0, 0); }, [page]);
  const projectRows = (items: ProjectItem[]) => items.map(item => <Row key={item.id} title={item.title} detail={item.rootPath}
    icon={<Folder/>} open={() => onPage({kind:'project', id:item.id})}/>);
  const recentRows = (items: ConversationSummary[]) => items.map(item => <Row key={item.id} title={item.title} detail={item.preview}
    icon={<MessageSquare/>} open={() => p.onConversation(item.id)}/>);
  const eventRows = (items: FriendsWorkEvent[]) => items.map(item => <Row key={item.id} title={item.title} detail={t(`yourFriends.status.${item.status}`)}
    icon={<Waves/>} open={() => onPage({kind:'event', id:item.id})}/>);
  const addProject = <Row title={t('agentDataSettings.addProject')} icon={<Plus/>} open={p.onAddProject}/>;
  const newChat = <Row title={t('chatSidebar.newChat')} icon={<Plus/>} open={p.onNew}/>;
  const eventCards: Card[] = events.slice(0, 2).map((item, index) => ({art:item.presentation?.cover ?? (index ? 'fern' : 'tide'),
    title:item.title, caption:t(`yourFriends.status.${item.status}`), summary:item.presentation?.summary, open:() => onPage({kind:'event', id:item.id})}));
  // Keep the two local shortcuts in place while the runtime supplies event cards.
  const waitingForEvents = !p.snapshot && !p.error;
  const pendingRow = <div className="desktop-row" role="status">{t('common.loading')}</div>;
  const explore: Card = {art:'fern', title:t('appCenter.appCenter'), caption:t('desktop.workspaceApps'), open:p.onExplore};
  const library: Card = {art:'tide', title:eventLabel, caption:t('desktop.eventLibrary'), open:() => onPage({kind:'events'})};
  const assistant: Card = {art:'prism', title:p.assistantName, caption:t('desktop.openAssistant'), open:p.onAssistant};
  const projectCard: Card = {art:'fold', title:projects[0]?.title ?? projectLabel,
    caption:projects.length ? projectLabel : t('desktop.openProjects'),
    open:() => onPage(projects[0] ? {kind:'project', id:projects[0].id} : {kind:'projects'})};
  const lead = eventCards[0] ?? (waitingForEvents ? undefined : explore);
  const last = eventCards[1] ?? (waitingForEvents ? undefined : eventCards.length ? explore : library);
  return <section className="desktop-library" aria-label={heading} data-desktop-page={page.kind} ref={scroll} onScroll={trackHeaderUnderlap}>
    {page.kind !== 'overview' && <nav className="desktop-crumbs" aria-label={t('desktop.breadcrumb')}>
      <button onClick={() => onPage({kind:'overview'})}>{home}</button>
      {page.kind === 'event' && <><ChevronRight/><button onClick={() => onPage({kind:'events'})}>{eventLabel}</button></>}
      {subpage && selected && <><ChevronRight/><button onClick={() => onPage({kind:'event',id:selected.id})}>{selected.title}</button></>}
      {selected && parents.map(parent => <span className="desktop-crumb-part" key={parent.id}><ChevronRight/><button onClick={() => onPage({kind:'event',id:selected.id,page:parent.id})}>{parent.title}</button></span>)}
      {project && <><ChevronRight/><button onClick={() => onPage({kind:'projects'})}>{projectLabel}</button></>}
    </nav>}
    {page.kind === 'event' && selected && !subpage ? <header className="desktop-detail-heading">
      <div aria-hidden="true" className="desktop-detail-art" data-cover={selected.presentation?.cover ?? 'tide'}/>
      <div><small>{t(`yourFriends.status.${selected.status}`)}</small><h1>{heading}</h1>
        {!selected.conversationExecution && <p>{selected.presentation?.summary ?? selected.intent}</p>}</div>
    </header> : <h1>{heading}</h1>}
    {page.kind === 'overview' && <>
      <FeaturedShelf language={language} busy={waitingForEvents}>
        <CoverCard card={lead}/><CoverCard card={assistant}/><CoverCard card={projectCard}/><CoverCard card={last}/>
      </FeaturedShelf>
      <ComponentsApp language={language} home onCreate={p.onCreateComponent}/>
      <Shelf title={eventLabel} open={() => onPage({kind:'events'})}><div className="desktop-rows">{waitingForEvents ? pendingRow : events.length ? eventRows(events.slice(0,6)) :
        <Row title={p.error ? t('desktop.retryEvents') : t('desktop.openAssistant')} detail={p.error ? undefined : p.assistantName} icon={<Waves/>} open={p.error ? p.retry : p.onAssistant}/>}</div></Shelf>
      <Shelf title={projectLabel} open={() => onPage({kind:'projects'})}><div className="desktop-rows">{projects.length ? projectRows(projects.slice(0,6)) : addProject}</div></Shelf>
      <Shelf title={recent} open={() => onPage({kind:'recent'})}><div className="desktop-rows">{conversations.length ? recentRows(conversations.slice(0,6)) : p.conversationsLoading ? pendingRow : newChat}</div></Shelf>

    </>}
    {page.kind === 'events' && <div className="desktop-list">{eventRows(events)}{!events.length && <p role="status">{t(p.error ? 'desktop.eventsUnavailable' : !p.snapshot ? 'desktop.loadingEvents' : 'yourFriends.noEvents')}</p>}
      {p.error && <Row title={t('desktop.retryEvents')} icon={<Waves/>} open={p.retry}/>}
      <Row title={p.assistantName} detail={t('desktop.openAssistant')} icon={<Waves/>} open={p.onAssistant}/>
      <details open={calendarOpen} onToggle={event => setCalendarOpen(event.currentTarget.open)}><summary>{t('automationPanel.calendarView')}</summary>
        {calendarOpen && <AutomationCalendar language={language} snapshot={p.snapshot}/>}
      </details></div>}
    {page.kind === 'projects' && <div className="desktop-list" ref={p.projectsRef}/>}
    {page.kind === 'recent' && <div className="desktop-list">{recentRows(conversations)}{newChat}</div>}
    {project && <><p className="desktop-path">{project.rootPath}</p><Shelf title={recent}><div className="desktop-list">
      {recentRows(conversations.filter(item => conversationMatchesScope(item,{mode:'project',projectId:project.id,projectDir:project.rootPath})))}
      {!project.missing && <Row title={t('chatSidebar.newChat')} icon={<Plus/>} open={() => p.onProject(project)}/>}</div></Shelf></>}
    {subpage && <section className="desktop-authored" data-layout={subpage.layout}>{subpage.items.map((item,index) =>
      <div key={index}><h2>{item.label}</h2><p>{item.text}</p></div>)}{attached && <ComponentPage item={attached} page={subpage}/>}</section>}
    {selected && children.length > 0 && <div className="desktop-list">{children.map(item =>
      <Row key={item.id} title={item.title} detail={item.items[0]?.label} icon={<Blocks/>} open={() => onPage({kind:'event',id:selected.id,page:item.id})}/>)}</div>}
    {selected && !subpage && <FriendsEventDetails event={selected} snapshot={p.snapshot} language={language} showHeading={false}/>}
    {selected && !subpage && p.snapshot?.active?.eventId === selected.id && Boolean(p.snapshot.permissions.length || p.snapshot.solutions.length) &&
      <FriendsExecutionRequests snapshot={p.snapshot} language={language} refresh={p.retry}/>}
    {component && <ComponentPage item={component}/>}
    {((page.kind === 'event' && !selected) || (page.kind === 'component' && !component) || (page.kind === 'project' && !project)) &&
      <p role="status">{t(page.kind === 'event' && !p.snapshot ? (p.error ? 'desktop.eventsUnavailable' : 'desktop.loadingEvents') : 'desktop.itemUnavailable')}</p>}
  </section>;
}
type ExploreProps = {
  language: AppLanguage; groups: {label:string; entries:ApplicationEntry[]}[]; featured: ApplicationEntry[]; query:string;
  onQuery(query:string):void; onLaunch(app:ApplicationEntry):void;
};
export function ExploreView(p: ExploreProps) {
  const t = uiText(p.language);
  return <section className="desktop-library desktop-explore" aria-label={t('appCenter.appCenter')} data-desktop-page="explore" onScroll={trackHeaderUnderlap}>
    <h1>{t('appCenter.appCenter')}</h1>
    <label className="desktop-filter"><Search/><input type="search" aria-label={t('appCenter.searchApps')} placeholder={t('appCenter.searchApps')} value={p.query} onChange={event => p.onQuery(event.target.value)}/></label>
    {p.featured.length > 0 && <div className="desktop-discover-covers">{p.featured.map((app,index) =>
      <button type="button" key={app.id} onClick={() => p.onLaunch(app)}><strong>{app.title}</strong><small>{app.description}</small><span aria-hidden="true" data-cover={index ? 'fold' : 'tide'}/></button>)}</div>}
    {p.groups.map(group => <Shelf key={group.label} title={group.label}><div className="desktop-rows">{group.entries.map(app =>
      <Row key={app.id} title={app.title} detail={app.description} icon={<ApplicationIcon app={app}/>} open={() => p.onLaunch(app)}/>)}</div></Shelf>)}
    {!p.groups.length && <p role="status">{t('appCenter.noMatchingApps')}</p>}
  </section>;
}
