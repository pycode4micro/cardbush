import { ArchiveRestore, Folder, MessageSquare, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppLanguage, ConversationSummary, ProjectItem } from '../../types';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import { conversationMatchesScope } from '../conversationScope';
import { setConversationsArchived, useConversationArchives } from '../sidebar/conversationArchives';
import { SettingsCard } from './SettingsControls';

const pageSize = 20;
const noProjects: ProjectItem[] = [];

export function ArchivedItemsPanel({ language, conversations, projects = noProjects, onRestoreProjects, onNotify }: {
  language: AppLanguage;
  conversations: ConversationSummary[];
  projects?: ProjectItem[];
  onRestoreProjects?: (ids: string[]) => void;
  onNotify: (message: string) => void;
}) {
  const archivedIds = useConversationArchives();
  const [tab, setTab] = useState<'conversations' | 'projects'>('conversations');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const zh = language === 'zh';
  const archivedConversations = useMemo(
    () => conversations.filter(item => archivedIds.has(item.id)), [conversations, archivedIds],
  );
  const archivedProjects = useMemo(() => projects.filter(item => item.archived), [projects]);
  const rows = useMemo(() => tab === 'conversations'
    ? archivedConversations.map(item => {
      const project = projects.find(candidate => conversationMatchesScope(item,
        { mode: 'project', projectId: candidate.id, projectDir: candidate.rootPath }));
      const date = new Date(item.updatedAt);
      return { id: item.id, title: conversationDisplayTitle(item.title),
        detail: [project?.title, Number.isNaN(date.getTime()) ? '' : date.toLocaleString(zh ? 'zh-CN' : 'en-US',
          { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · '),
        archivedProjectId: project?.archived ? project.id : undefined };
    })
    : archivedProjects.map(item => ({ id: item.id, title: item.title, detail: item.rootPath,
      archivedProjectId: undefined as string | undefined })),
  [tab, archivedConversations, archivedProjects, projects, zh]);
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = rows.filter(item => terms.every(term => `${item.title} ${item.detail}`.toLocaleLowerCase().includes(term)));
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visibleRows = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function restore(items: typeof rows) {
    setError('');
    try {
      if (tab === 'conversations') {
        setConversationsArchived(items.map(item => item.id), false);
        const parentIds = [...new Set(items.flatMap(item => item.archivedProjectId ? [item.archivedProjectId] : []))];
        if (parentIds.length) onRestoreProjects?.(parentIds);
      } else {
        onRestoreProjects?.(items.map(item => item.id));
      }
      onNotify(zh ? `已恢复 ${items.length} 个${tab === 'conversations' ? '会话' : '项目'}`
        : `Restored ${items.length} ${tab === 'conversations' ? 'chats' : 'projects'}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }
  const canRestore = (items: typeof rows) => Boolean(items.length) &&
    (Boolean(onRestoreProjects) || (tab === 'conversations' && !items.some(item => item.archivedProjectId)));

  return <SettingsCard title={zh ? '归档管理' : 'Archived items'}
    subtitle={zh ? '归档会隐藏侧栏条目并保留历史，恢复后回到原来的项目或最近列表。'
      : 'Archiving hides sidebar entries and keeps their history. Restore them to their original project or recent list.'}>
    <div className="archive-manager">
      <div className="archive-manager-toolbar">
        <div className="archive-manager-tabs" role="group" aria-label={zh ? '归档类型' : 'Archive type'}>
          {(['conversations', 'projects'] as const).map(value => <button key={value} type="button"
            aria-pressed={tab === value} onClick={() => { setTab(value); setPage(0); setError(''); }}>
            {value === 'conversations' ? <MessageSquare size={15} /> : <Folder size={15} />}
            {value === 'conversations' ? (zh ? '会话' : 'Chats') : (zh ? '项目' : 'Projects')}
            <span>{value === 'conversations' ? archivedConversations.length : archivedProjects.length}</span>
          </button>)}
        </div>
        <button type="button" className="secondary-button" disabled={!canRestore(filtered)} onClick={() => restore(filtered)}>
          <ArchiveRestore size={14} />{query.trim() ? (zh ? '恢复搜索结果' : 'Restore results') : (zh ? '全部恢复' : 'Restore all')}
        </button>
      </div>
      <label className="archive-manager-search"><Search size={16} aria-hidden="true" />
        <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }}
          aria-label={zh ? '搜索归档' : 'Search archives'} placeholder={zh ? '搜索标题或项目' : 'Search titles or projects'} />
      </label>
      <div className="archive-manager-list">
        {visibleRows.map(item => <div className="archive-manager-row" key={item.id} data-archive-id={item.id}>
          {tab === 'conversations' ? <MessageSquare size={17} aria-hidden="true" /> : <Folder size={17} aria-hidden="true" />}
          <div className="archive-manager-info"><strong title={item.title}>{item.title}</strong>
            {item.detail && <small title={item.detail}>{item.detail}</small>}
            {item.archivedProjectId && <small>{zh ? '所属项目也已归档，恢复时一并恢复项目。' : 'Its archived project will also be restored.'}</small>}
          </div>
          <button type="button" className="secondary-button" disabled={!canRestore([item])}
            aria-label={`${zh ? '恢复' : 'Restore'} ${item.title}`} onClick={() => restore([item])}>
            <ArchiveRestore size={14} />{zh ? '恢复' : 'Restore'}
          </button>
        </div>)}
        {!visibleRows.length && <p className="archive-manager-empty">{query.trim()
          ? (zh ? '没有匹配的归档记录' : 'No matching archived items')
          : tab === 'conversations' ? (zh ? '暂无已归档会话' : 'No archived chats') : (zh ? '暂无已归档项目' : 'No archived projects')}</p>}
      </div>
      {lastPage > 0 && <div className="archive-manager-pagination">
        <button className="secondary-button" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{zh ? '上一页' : 'Previous'}</button>
        <span>{currentPage + 1} / {lastPage + 1}</span>
        <button className="secondary-button" type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{zh ? '下一页' : 'Next'}</button>
      </div>}
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </div>
  </SettingsCard>;
}
