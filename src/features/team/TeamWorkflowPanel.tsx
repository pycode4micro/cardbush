import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import { useEffect } from 'react';

import type {
  AgentProfileDefinition,
  AppLanguage,
  TeamDefinition,
  TeamMemberDefinition,
} from '../../types';
import {
  loadTeamWorkspace,
  teamWorkspaceActions,
  useTeamWorkspaceState,
} from './teamWorkspaceStore';
import './team-workflow.css';

export function TeamWorkflowPanel({ language }: {
  language: AppLanguage;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
}) {
  const zh = language === 'zh';
  const workspace = useTeamWorkspaceState();
  const team = workspace.teams.find((item) => item.id === workspace.activeTeamId) ?? workspace.teams[0];
  const member = team?.members.find((item) => item.id === workspace.activeMemberId) ?? team?.members[0];
  const profile = workspace.profiles.find((item) => item.id === member?.agentProfileId);

  useEffect(() => { void loadTeamWorkspace().catch(() => undefined); }, []);

  if (workspace.loading && !team) return <div className="team-config-empty">{zh ? '正在加载 Team 配置…' : 'Loading team configuration…'}</div>;
  if (!team || !member || !profile) {
    return (
      <div className="team-config-empty">
        <strong>{workspace.error || (zh ? '还没有 Team 配置' : 'No team configuration yet')}</strong>
        <button type="button" onClick={() => workspace.error ? void teamWorkspaceActions.refresh() : teamWorkspaceActions.createTeam(language)}>
          {workspace.error ? <RefreshCw size={14} /> : <Plus size={14} />}
          {workspace.error ? (zh ? '重试' : 'Retry') : (zh ? '新建 Team' : 'New team')}
        </button>
      </div>
    );
  }

  return (
    <div className="team-workflow-content team-config-workspace">
      <header className="team-config-toolbar">
        <div className="team-config-heading">
          <span><small>{team.name}</small><strong>{workspace.view === 'manage' ? (zh ? '快速管理' : 'Quick management') : workspace.view === 'install' ? (zh ? '新建配置' : 'Create configuration') : profile.name}</strong></span>
        </div>
        <div className="team-workflow-toolbar-actions">
          <button type="button" title={zh ? '刷新' : 'Refresh'} onClick={() => void teamWorkspaceActions.refresh()}><RefreshCw size={15} /></button>
          {workspace.view === 'agent' && (
            <button className="primary" type="button" disabled={workspace.saving} onClick={() => void teamWorkspaceActions.saveTeam(team.id)}>
              <Save size={15} /><span>{workspace.saving ? (zh ? '校验并保存中' : 'Validating…') : (zh ? '校验并保存' : 'Validate & save')}</span>
            </button>
          )}
        </div>
      </header>
      <section className="team-workflow-stage">
        {workspace.error && <div className="team-workflow-save-status error">{workspace.error}</div>}
        {workspace.view === 'manage' ? (
          <TeamManagement language={language} />
        ) : workspace.view === 'install' ? (
          <TeamCreatePage language={language} />
        ) : (
          <AgentEditor language={language} team={team} member={member} profile={profile} profiles={workspace.profiles} />
        )}
      </section>
    </div>
  );
}

function AgentEditor({ language, team, member, profile, profiles }: {
  language: AppLanguage;
  team: TeamDefinition;
  member: TeamMemberDefinition;
  profile: AgentProfileDefinition;
  profiles: AgentProfileDefinition[];
}) {
  const zh = language === 'zh';
  const updateProfile = (patch: Partial<AgentProfileDefinition>) => teamWorkspaceActions.updateProfile(profile.id, patch);
  const updateMember = (patch: Partial<TeamMemberDefinition>) => teamWorkspaceActions.updateMember(team.id, member.id, patch);
  return (
    <article className="team-agent-editor" key={`${team.id}:${member.id}`}>
      <header className="team-agent-editor-header">
        <div>
          <span>{zh ? 'Agent Profile' : 'Agent profile'}</span>
          <input value={profile.name} aria-label={zh ? 'Agent 名称' : 'Agent name'} onChange={(event) => updateProfile({ name: event.currentTarget.value })} />
          <small>{profile.id}</small>
        </div>
        <button type="button" disabled={team.members.length <= 1} title={zh ? '从 Team 移除成员' : 'Remove member from team'} onClick={() => teamWorkspaceActions.deleteAgent(team.id, member.id)}><Trash2 size={15} /></button>
      </header>

      <div className="team-agent-config-grid team-profile-identity-grid">
        <label><span>{zh ? '成员 ID' : 'Member ID'}</span><input value={member.id} disabled /></label>
        <label><span>{zh ? '关联 Profile' : 'Agent profile'}</span><select value={member.agentProfileId} onChange={(event) => updateMember({ agentProfileId: event.currentTarget.value })}>{profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id}</option>)}</select></label>
      </div>

      <label className="team-agent-prompt"><span>{zh ? '成员职责' : 'Member responsibility'}</span><textarea value={member.responsibility} placeholder={zh ? '说明主 Agent 何时应该把任务派发给这个成员。' : 'Describe when the parent agent should delegate work to this member.'} onChange={(event) => updateMember({ responsibility: event.currentTarget.value })} /></label>
      <label className="team-agent-fallback"><input type="checkbox" checked={member.fallback} onChange={() => updateMember({ fallback: true })} /><span>{zh ? '设为唯一 fallback 成员' : 'Use as the single fallback member'}</span></label>

      <label className="team-agent-prompt"><span>{zh ? 'Profile 描述' : 'Profile description'}</span><textarea value={profile.description} onChange={(event) => updateProfile({ description: event.currentTarget.value })} /></label>
      <label className="team-agent-prompt"><span>{zh ? '系统指令' : 'Prompt instructions'}</span><textarea value={profile.prompts.instructions} placeholder={zh ? '定义职责、边界、行为和期望输出。' : 'Define responsibilities, boundaries, behavior, and expected output.'} onChange={(event) => updateProfile({ prompts: { instructions: event.currentTarget.value } })} /></label>

      <div className="team-profile-capability-grid">
        <StringListField language={language} label="disabled_tools" value={profile.disabledTools} onChange={(disabledTools) => updateProfile({ disabledTools })} />
        <StringListField language={language} label="hooks" value={profile.hooks} onChange={(hooks) => updateProfile({ hooks })} />
        <StringListField language={language} label="guards" value={profile.guards} onChange={(guards) => updateProfile({ guards })} />
        <div className="team-profile-skills-field">
          <label><input type="checkbox" checked={profile.skills == null} onChange={(event) => updateProfile({ skills: event.currentTarget.checked ? undefined : [] })} /><span>{zh ? 'skills 继承父 Agent' : 'Inherit parent skills'}</span></label>
          {profile.skills != null && <StringListField language={language} label="skills" value={profile.skills} onChange={(skills) => updateProfile({ skills })} />}
        </div>
      </div>
      <footer className="team-agent-editor-footer"><span>Team <strong>{team.id}</strong></span><span>{zh ? '成员' : 'Member'} <strong>{member.id}</strong></span><span>{zh ? '保存前由 Runtime 严格校验' : 'Strict Runtime validation before save'}</span></footer>
    </article>
  );
}

function StringListField({ language, label, value, onChange }: { language: AppLanguage; label: string; value: string[]; onChange: (value: string[]) => void }) {
  return <label className="team-string-list"><span>{label}</span><textarea value={value.join('\n')} placeholder={language === 'zh' ? '每行一项' : 'One item per line'} onChange={(event) => onChange(event.currentTarget.value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))} /></label>;
}

function TeamManagement({ language }: { language: AppLanguage }) {
  const zh = language === 'zh';
  const workspace = useTeamWorkspaceState();
  return (
    <div className="team-management-page">
      <div className="team-management-summary">
        <div><strong>{workspace.teams.length}</strong><span>Teams</span></div>
        <div><strong>{workspace.profiles.length}</strong><span>Profiles</span></div>
        <div className="team-management-display-mode"><span>{zh ? '侧栏显示' : 'Sidebar labels'}</span><div><button className={workspace.displayMode === 'name' ? 'active' : ''} type="button" onClick={() => teamWorkspaceActions.setDisplayMode('name')}>{zh ? '名称' : 'Name'}</button><button className={workspace.displayMode === 'description' ? 'active' : ''} type="button" onClick={() => teamWorkspaceActions.setDisplayMode('description')}>{zh ? '描述' : 'Description'}</button></div></div>
        <button type="button" onClick={() => teamWorkspaceActions.createTeam(language)}><Plus size={14} />{zh ? '新建 Team' : 'New team'}</button>
      </div>
      <div className="team-management-list">
        {workspace.teams.map((team) => <article className="team-management-card" key={team.id}><header><input value={team.name} onChange={(event) => teamWorkspaceActions.updateTeam(team.id, { name: event.currentTarget.value })} /><span>{team.members.length} Agents</span><button type="button" onClick={() => void teamWorkspaceActions.deleteTeam(team.id)}><Trash2 size={14} /></button></header><textarea value={team.description} onChange={(event) => teamWorkspaceActions.updateTeam(team.id, { description: event.currentTarget.value })} /><footer><button type="button" onClick={() => teamWorkspaceActions.selectTeam(team.id)}>{zh ? '打开配置' : 'Open'}</button><button type="button" onClick={() => teamWorkspaceActions.createAgent(team.id, language)}><Plus size={13} />Agent</button><button type="button" onClick={() => void teamWorkspaceActions.saveTeam(team.id)}><Save size={13} />{zh ? '保存' : 'Save'}</button></footer></article>)}
      </div>
    </div>
  );
}

function TeamCreatePage({ language }: { language: AppLanguage }) {
  const zh = language === 'zh';
  return <div className="team-install-page"><header><Plus size={20} /><div><strong>{zh ? '新建 Team 配置' : 'Create a team configuration'}</strong><span>{zh ? '当前 Runtime 没有模板安装协议；这里创建严格 v1 Team/Profile 草稿，保存前会调用 validate。' : 'The current Runtime has no template installation protocol. This creates strict v1 Team/Profile drafts and validates before saving.'}</span></div></header><button className="team-create-primary" type="button" onClick={() => teamWorkspaceActions.createTeam(language)}><Plus size={14} />{zh ? '新建 Team' : 'New team'}</button></div>;
}
