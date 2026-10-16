import { useState } from 'react';
import { GitBranch, Plus, Search } from 'lucide-react';
import type { DefinitionReceipt, TeamRun, TeamWorkflow } from '@cardbush/bush-protocol';
import { requestTeamDocument } from './teamWorkspaceNavigation';
import { teamStatusLabel } from './teamFlowGraph';

export function TeamWorkflowLibrary({ teams, runs, language }: { teams: DefinitionReceipt<TeamWorkflow>[]; runs: TeamRun[]; language: 'zh' | 'en' }) {
  const [query, setQuery] = useState(''), zh = language === 'zh';
  const visible = [...teams].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(({ definition }) => `${definition.name} ${definition.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="native-team-management team-library" aria-label={zh ? '全部流程' : 'All workflows'}>
    <header><div><h1>{zh ? '全部流程' : 'All workflows'}</h1><p>{zh ? '选择一个流程继续，或让 AI 建立新的分工。' : 'Continue a workflow, or ask AI to create one.'}</p></div>
      <button type="button" onClick={() => requestTeamDocument({ kind: 'create' })}><Plus size={15}/>{zh ? '新建流程' : 'New workflow'}</button></header>
    <label className="team-library-search"><Search size={15}/><input aria-label={zh ? '搜索全部流程' : 'Search all workflows'} placeholder={zh ? '搜索名称或用途' : 'Search name or purpose'} value={query} onChange={event => setQuery(event.target.value)}/></label>
    <div className="team-library-list">{visible.map(({ definition, updatedAt }) => {
      const latest = runs.filter(run => run.teamId === definition.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return <button type="button" key={definition.id} onClick={() => requestTeamDocument({ kind: 'select', id: definition.id })}>
        <GitBranch size={18}/><span className="team-library-name"><strong>{definition.name}</strong><small>{definition.description || (zh ? `${definition.nodes.length} 个步骤` : `${definition.nodes.length} steps`)}</small></span>
        <span className="team-library-status">{latest ? teamStatusLabel(latest.status, language) : (zh ? '未运行' : 'Not run')}<time dateTime={updatedAt}>{new Date(updatedAt).toLocaleDateString(zh ? 'zh-CN' : 'en-US')}</time></span>
      </button>;
    })}</div>
    {!visible.length && <p>{query ? (zh ? '没有匹配的流程。' : 'No matching workflows.') : (zh ? '还没有流程。点击“新建流程”，描述你想完成的任务。' : 'No workflows yet. Create one and describe your goal.')}</p>}
  </section>;
}
