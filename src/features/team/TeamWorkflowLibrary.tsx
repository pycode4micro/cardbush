import { uiText } from '../../i18n';
import { useState } from 'react';
import { GitBranch, Plus, Search } from 'lucide-react';
import type { DefinitionReceipt, TeamRun, TeamWorkflow } from '@cardbush/bush-protocol';
import { requestTeamDocument } from './teamWorkspaceNavigation';
import { teamStatusLabel } from './teamFlowGraph';

export function TeamWorkflowLibrary({ teams, runs, language }: { teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[]; language: string }) {
  const [query, setQuery] = useState('');
  const visible = [...teams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(({ definition }) => `${definition.name} ${definition.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="native-team-management team-library" aria-label={uiText(language)('teamWorkflowLibrary.allWorkflows')}>
    <header><div><h1>{uiText(language)('teamWorkflowLibrary.allWorkflows')}</h1><p>{uiText(language)('teamWorkflowLibrary.continueAWorkflowOrAskAiTo')}</p></div>
      <button type="button" onClick={() => requestTeamDocument({ kind: 'create' })}><Plus size={15}/>{uiText(language)('teamWorkflowLibrary.newWorkflow')}</button></header>
    <label className="team-library-search"><Search size={15}/><input aria-label={uiText(language)('teamWorkflowLibrary.searchAllWorkflows')} placeholder={uiText(language)('teamWorkflowLibrary.searchNameOrPurpose')} value={query} onChange={event => setQuery(event.target.value)}/></label>
    <div className="team-library-list">{visible.map(({ definition, updatedAt }) => {
      const latest = runs.filter(run => run.teamId === definition.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return <button type="button" key={definition.id} onClick={() => requestTeamDocument({ kind: 'select', id: definition.id })}>
        <GitBranch size={18}/><span className="team-library-name"><strong>{definition.name}</strong><small>{definition.description || (uiText(language)('teamWorkflowLibrary.steps', { value1: definition.nodes.length }))}</small></span>
        <span className="team-library-status">{latest ? teamStatusLabel(latest.status, language) : (uiText(language)('teamWorkflowLibrary.notRun'))}<time dateTime={updatedAt}>{new Date(updatedAt).toLocaleDateString(language)}</time></span>
      </button>;
    })}</div>
    {!visible.length && <p>{query ? (uiText(language)('teamWorkflowLibrary.noMatchingWorkflows')) : (uiText(language)('teamWorkflowLibrary.noWorkflowsYetCreateOneAndDescribe'))}</p>}
  </section>;
}
