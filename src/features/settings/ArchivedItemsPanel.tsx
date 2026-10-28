import { uiText } from '../../i18n';
import { ArchiveRestore, Folder, MessageSquare, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { AppLanguage, ConversationSummary, ProjectItem } from '../../types';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { conversationMatchesScope } from '../conversationScope';
import { setConversationsArchived, useConversationArchives } from '../sidebar/conversationArchives';
import { SettingsCard } from './SettingsControls';

const pageSize = 20;
const noProjects: ProjectItem[] = [];

type ArchivedItemsProps = {
  language: AppLanguage;
  conversations: ConversationSummary[];
  projects?: ProjectItem[];
  onRestoreProjects?: (ids: string[]) => void;
  onNotify: (message: string) => void;
};

export function ArchivedItemsPanel(props: ArchivedItemsProps) {
  const archivedIds = useConversationArchives();
  const conversations = useMemo(() => props.conversations.filter(item => archivedIds.has(item.id)), [props.conversations, archivedIds]);
  return <ArchivedItemsManager {...props} conversations={conversations} onRestoreConversations={ids => setConversationsArchived(ids, false)}/>;
}

/** Both hosts share presentation; each supplies its own archived rows and restore operation. */
export function ArchivedItemsManager({ language, conversations: archivedConversations, projects = noProjects, onRestoreProjects, onNotify,
  onRestoreConversations, showProjects = true }: ArchivedItemsProps & {
  onRestoreConversations: (ids: string[]) => void | Promise<void>; showProjects?: boolean;
}) {
  const [tab, setTab] = useState<'conversations' | 'projects'>('conversations');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const restoring = useRef(false);

  const archivedProjects = useMemo(() => projects.filter(item => item.archived), [projects]);
  const rows = useMemo(() => tab === 'conversations'
    ? archivedConversations.map(item => {
      const project = projects.find(candidate => conversationMatchesScope(item,
        { mode: 'project', projectId: candidate.id, projectDir: candidate.rootPath }));
      const date = new Date(item.updatedAt);
      return { id: item.id, title: conversationDisplayTitle(item.title),
        detail: [project?.title, Number.isNaN(date.getTime()) ? '' : date.toLocaleString(language,
          { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · '),
        archivedProjectId: project?.archived ? project.id : undefined };
    })
    : archivedProjects.map(item => ({ id: item.id, title: item.title, detail: item.rootPath,
      archivedProjectId: undefined as string | undefined })),
  [tab, archivedConversations, archivedProjects, projects, language]);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter(item => terms.every(term => `${item.title} ${item.detail}`.toLocaleLowerCase().includes(term)));
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleRows = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  async function restore(items: typeof rows) {
    if (restoring.current) return;
    restoring.current = true; setBusy(true); setError('');
    try {
      if (tab === 'conversations') {
        await onRestoreConversations(items.map(item => item.id));
        const parentIds = [...new Set(items.flatMap(item => item.archivedProjectId ? [item.archivedProjectId] : []))];
        if (parentIds.length) onRestoreProjects?.(parentIds);
      } else {
        onRestoreProjects?.(items.map(item => item.id));
      }
      onNotify(uiText(language)('archivedItemsPanel.restored', { value1: items.length, value2: (tab === 'conversations' ? uiText(language)('archivedItemsPanel.chats') : uiText(language)('archivedItemsPanel.projects_bcfe89c')) }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally { restoring.current = false; setBusy(false); }
  }
  const canRestore = (items: typeof rows) => !busy && Boolean(items.length) &&
    (Boolean(onRestoreProjects) || (tab === 'conversations' && !items.some(item => item.archivedProjectId)));

  return <SettingsCard title={uiText(language)('agentArchivesPanel.archivedItems')}
    subtitle={uiText(language)('archivedItemsPanel.archivingHidesSidebarEntriesAndKeepsTheir')}>
    <div className="archive-manager">
      <div className="archive-manager-toolbar">
        <div className="archive-manager-tabs" role="group" aria-label={uiText(language)('archivedItemsPanel.archiveType')}>
          {(['conversations', 'projects'] as const).filter(value => showProjects || value === 'conversations').map(value => <button key={value} type="button" disabled={busy}
            aria-pressed={tab === value} onClick={() => { setTab(value); setPage(0); setError(''); }}>
            {value === 'conversations' ? <MessageSquare size={15} /> : <Folder size={15} />}
            {value === 'conversations' ? (uiText(language)('conversationSearchDialog.chats')) : (uiText(language)('archivedItemsPanel.projects'))}
            <span>{value === 'conversations' ? archivedConversations.length : archivedProjects.length}</span>
          </button>)}
        </div>
        <button type="button" className="secondary-button" disabled={!canRestore(filtered)} onClick={() => void restore(filtered)}>
          <ArchiveRestore size={14} />{query.trim() ? (uiText(language)('archivedItemsPanel.restoreResults')) : (uiText(language)('archivedItemsPanel.restoreAll'))}
        </button>
      </div>
      <label className="archive-manager-search"><Search size={16} aria-hidden="true" />
        <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}
          aria-label={uiText(language)('archivedItemsPanel.searchArchives')} placeholder={uiText(language)('archivedItemsPanel.searchTitlesOrProjects')} />
      </label>
      <div className="archive-manager-list">
        {visibleRows.map(item => <div className="archive-manager-row" key={item.id} data-archive-id={item.id}>
          {tab === 'conversations' ? <MessageSquare size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}
          <div className="archive-manager-info"><strong title={item.title}>{item.title}</strong>
            {item.detail && <small title={item.detail}>{item.detail}</small>}
            {item.archivedProjectId && <small>{uiText(language)('archivedItemsPanel.itsArchivedProjectWillAlsoBeRestored')}</small>}
          </div>
          <button type="button" className="secondary-button" disabled={!canRestore([item])}
            aria-label={`${uiText(language)('archivedItemsPanel.restore')} ${item.title}`} onClick={() => void restore([item])}>
            <ArchiveRestore size={14} />{uiText(language)('archivedItemsPanel.restore')}
          </button>
        </div>)}
        {!visibleRows.length && <p className="archive-manager-empty">{query.trim()
          ? (uiText(language)('archivedItemsPanel.noMatchingArchivedItems'))
          : tab === 'conversations' ? (uiText(language)('archivedItemsPanel.noArchivedChats')) : (uiText(language)('archivedItemsPanel.noArchivedProjects'))}</p>}
      </div>
      {lastPage > 0 && <div className="archive-manager-pagination">
        <button className="secondary-button" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{uiText(language)('browserLibraryDialog.previous')}</button>
        <span>{currentPage + 1} / {lastPage + 1}</span>
        <button className="secondary-button" type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{uiText(language)('browserLibraryDialog.next')}</button>
      </div>}
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </div>
  </SettingsCard>;
}
