import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FilePlus2, FileText, Files, FolderOpen, History, RefreshCw, Search, UsersRound } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { refreshTeamWorkspace, useTeamWorkspace } from './teamWorkspaceStore';
import { requestTeamDocument, showTeamWorkspaceTab, useTeamWorkspaceNavigation } from './teamWorkspaceNavigation';
import { AppCenterDock } from '../appCenter/AppCenter';
import './team-workspace.css';

export function NativeTeamSidebar({ language, onBack, onSelect, softVisible = true }: { language: AppLanguage; onBack?: () => void; onSelect?: () => void; onOpenSettings?: () => void; softVisible?: boolean }) {
  const state = useTeamWorkspace(), navigation = useTeamWorkspaceNavigation();
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null), t = (cn: string, en: string) => language === 'zh' ? cn : en;
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const search = query.trim().toLocaleLowerCase(), current = navigation.document;
  const documents = [...state.teams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ definition }) => ({
    id: definition.id, name: current?.id === definition.id ? current.name : definition.name,
    dirty: current?.id === definition.id && current.dirty,
  }));
  if (current && !documents.some(item => item.id === current.id)) documents.unshift(current);
  const visibleDocuments = documents.filter(item => !search || `${item.name} ${item.id}`.toLocaleLowerCase().includes(search));
  return <aside className={`sidebar native-team-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label="Team">
    <div className="sidebar-panel-content team-sidebar-content">
      <header className="team-sidebar-heading"><h2>Team</h2>
        <button type="button" onClick={onBack} aria-label={t('返回对话', 'Back to chats')} title={t('返回对话', 'Back to chats')}><ArrowLeft size={16}/></button>
        <button type="button" aria-label={t('搜索团队文档', 'Search Team documents')} aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setQuery(''); }}><Search size={16}/></button>
      </header>
      <button type="button" className="team-new-document" disabled={navigation.busy} onClick={() => { setQuery(''); requestTeamDocument({ kind: 'create' }); onSelect?.(); }}><FilePlus2 size={16}/>{t('新建团队文档', 'New Team document')}</button>
      <nav className="team-sidebar-nav" aria-label={t('团队管理', 'Team management')}>
        {([{ tab: 'teams', icon: Files, label: t('团队文档', 'Team documents') }, { tab: 'agents', icon: UsersRound, label: t('员工', 'Agents') }, { tab: 'runs', icon: History, label: t('运行记录', 'Runs') }] as const).map(({ tab, icon: Icon, label }) =>
          <button type="button" key={tab} aria-current={navigation.tab === tab ? 'page' : undefined} onClick={() => { showTeamWorkspaceTab(tab); onSelect?.(); }}><Icon size={16}/>{label}</button>)}
        <button type="button" disabled={navigation.busy} onClick={() => { setQuery(''); requestTeamDocument({ kind: 'open' }); onSelect?.(); }}><FolderOpen size={16}/>{t('打开 .md', 'Open .md')}</button>
      </nav>
      {searchOpen && <label className="team-sidebar-search"><Search size={14}/><input ref={searchRef} aria-label={t('筛选团队文档', 'Filter Team documents')} placeholder={t('搜索团队文档…', 'Search Team documents…')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}/></label>}
      <section className="team-sidebar-library" aria-label={t('最近更新', 'Recently updated')}>
        <div className="team-sidebar-section-heading"><span>{t('最近更新', 'Recently updated')}</span><button type="button" disabled={state.loading} aria-label={t('刷新', 'Refresh')} title={t('刷新', 'Refresh')} onClick={() => void refreshTeamWorkspace()}><RefreshCw size={13}/></button></div>
        {visibleDocuments.map(item => <button type="button" key={item.id} data-team-document-id={item.id} className="team-sidebar-document" aria-current={navigation.tab === 'teams' && current?.id === item.id ? 'page' : undefined} disabled={navigation.busy} title={item.name} onClick={() => {
          if (current?.id === item.id && !state.teams.some(record => record.definition.id === item.id)) showTeamWorkspaceTab('teams');
          else requestTeamDocument({ kind: 'select', id: item.id });
          onSelect?.();
        }}><FileText size={15}/><span>{item.name}</span>{item.dirty && <i className="team-document-dirty" aria-label={t('未保存修改', 'Unsaved changes')}/>}</button>)}
        {!visibleDocuments.length && <p>{state.loading ? t('正在加载…', 'Loading…') : search ? t('没有匹配的文档', 'No matching documents') : t('暂无团队文档', 'No Team documents')}</p>}
      </section>
      <div className="native-team-app-dock"><AppCenterDock language={language}/></div>
    </div>
  </aside>;
}
