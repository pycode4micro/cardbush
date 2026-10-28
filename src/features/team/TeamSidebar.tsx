import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, GitBranch, Files, FolderOpen, History, RefreshCw, Search, UsersRound } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { refreshTeamWorkspace, useTeamWorkspace } from './teamWorkspaceStore';
import { requestTeamDocument, showTeamWorkspaceTab, useTeamWorkspaceNavigation } from './teamWorkspaceNavigation';
import { AppCenterDock } from '../appCenter/AppCenter';
import './team-workspace.css';

export function NativeTeamSidebar({ language, onBack, onSelect, softVisible = true }: { language: AppLanguage; onBack?: () => void; onSelect?: () => void; onOpenSettings?: () => void; softVisible?: boolean }) {
  const state = useTeamWorkspace(), navigation = useTeamWorkspaceNavigation();
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  const search = query.trim().toLocaleLowerCase(), current = navigation.document;
  const documents = [...state.teams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ definition }) => ({
    id: definition.id, name: current?.id === definition.id ? current.name : definition.name,
    dirty: current?.id === definition.id && current.dirty,
  }));
  if (current && !documents.some(item => item.id === current.id)) documents.unshift(current);
  const visibleDocuments = documents.filter(item => !search || `${item.name} ${item.id}`.toLocaleLowerCase().includes(search));
  return <aside className={`sidebar native-team-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`} aria-label={uiText(language)('creationCanvasApp.team')}>
    <div className="sidebar-panel-content team-sidebar-content">
      <header className="team-sidebar-heading"><h2>{uiText(language)('appCenterModel.workflows')}</h2>
        <button type="button" onClick={onBack} aria-label={uiText(language)('canvasSidebar.backToChats')} title={uiText(language)('canvasSidebar.backToChats')}><ArrowLeft size={16}/></button>
        <button type="button" aria-label={uiText(language)('teamSidebar.searchWorkflows')} aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setQuery(''); }}><Search size={16}/></button>
      </header>
      <button type="button" className="team-new-document" disabled={navigation.busy} onClick={() => { setQuery(''); requestTeamDocument({ kind: 'create' }); onSelect?.(); }}><Plus size={16}/>{uiText(language)('teamWorkflowLibrary.newWorkflow')}</button>
      <nav className="team-sidebar-nav" aria-label={uiText(language)('teamSidebar.teamManagement')}>
        {([{ tab: 'library', icon: Files, label: uiText(language)('teamWorkflowLibrary.allWorkflows') }, { tab: 'runs', icon: History, label: uiText(language)('teamSidebar.runs') }] as const).map(({ tab, icon: Icon, label }) =>
          <button type="button" key={tab} aria-current={navigation.tab === tab ? 'page' : undefined} onClick={() => { showTeamWorkspaceTab(tab); onSelect?.(); }}><Icon size={16}/>{label}</button>)}
      </nav>
      {searchOpen && <label className="team-sidebar-search"><Search size={14}/><input ref={searchRef} aria-label={uiText(language)('teamSidebar.filterWorkflows')} placeholder={uiText(language)('teamSidebar.searchWorkflows_a7e5b14')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }}/></label>}
      <section className="team-sidebar-library" aria-label={uiText(language)('canvasSidebar.recentlyUpdated')}>
        <div className="team-sidebar-section-heading"><span>{uiText(language)('canvasSidebar.recentlyUpdated')}</span><button type="button" disabled={state.loading} aria-label={uiText(language)('automationPanel.refresh')} title={uiText(language)('automationPanel.refresh')} onClick={() => void refreshTeamWorkspace()}><RefreshCw size={13}/></button></div>
        {visibleDocuments.map(item => <button type="button" key={item.id} data-team-document-id={item.id} className="team-sidebar-document" aria-current={navigation.tab === 'teams' && current?.id === item.id ? 'page' : undefined} disabled={navigation.busy} title={item.name} onClick={() => {
          if (current?.id === item.id && !state.teams.some(record => record.definition.id === item.id)) showTeamWorkspaceTab('teams');
          else requestTeamDocument({ kind: 'select', id: item.id });
          onSelect?.();
        }}><GitBranch size={15}/><span>{item.name}</span>{!state.teams.some(record => record.definition.id === item.id) && <small>{state.runs.some(run => run.teamId === item.id) ? uiText(language)('teamSidebar.history') : uiText(language)('teamSidebar.draft')}</small>}</button>)}
        {!visibleDocuments.length && <p>{state.loading ? uiText(language)('common.loading') : search ? uiText(language)('teamSidebar.noMatchingWorkflows') : uiText(language)('teamSidebar.noWorkflows')}</p>}
      </section>
      <details className="team-sidebar-manage"><summary>{uiText(language)('canvasSidebar.more')}</summary>
        <button type="button" aria-current={navigation.tab === 'agents' ? 'page' : undefined} onClick={() => { showTeamWorkspaceTab('agents'); onSelect?.(); }}><UsersRound size={16}/>{uiText(language)('teamSidebar.manageAgents')}</button>
        <button type="button" disabled={navigation.busy} onClick={() => { setQuery(''); requestTeamDocument({ kind: 'open' }); onSelect?.(); }}><FolderOpen size={16}/>{uiText(language)('teamSidebar.importMarkdown')}</button>
      </details>
      <div className="sidebar-footer"><AppCenterDock language={language}/></div>
    </div>
  </aside>;
}
