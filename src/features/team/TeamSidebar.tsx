import { Settings } from 'lucide-react';
import {
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { AppLanguage } from '../../types';
import {
  loadTeamWorkspace,
  teamWorkspaceActions,
  useTeamWorkspaceState,
} from './teamWorkspaceStore';
import './team-workflow.css';

type TeamContextMenu = {
  kind: 'team' | 'agent';
  teamId: string;
  agentId?: string;
  x: number;
  y: number;
};

type RenameTarget = {
  kind: 'team' | 'agent';
  teamId: string;
  agentId?: string;
  value: string;
};

export function TeamSidebar({
  language,
  onBack,
  onOpenSettings,
  softVisible = true,
}: {
  language: AppLanguage;
  onBack: () => void;
  onOpenSettings: () => void;
  softVisible?: boolean;
}) {
  const zh = language === 'zh';
  const workspace = useTeamWorkspaceState();
  const [query, setQuery] = useState('');
  const [expandedTeamIds, setExpandedTeamIds] = useState<Set<string>>(
    () => new Set(workspace.teams.map((team) => team.id)),
  );
  const [contextMenu, setContextMenu] = useState<TeamContextMenu | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const displayTeamLabel = (team: (typeof workspace.teams)[number]) => (
    workspace.displayMode === 'description' && team.description.trim()
      ? team.description.trim()
      : team.name
  );
  const displayAgentLabel = (
    member: (typeof workspace.teams)[number]['members'][number],
  ) => (
    (() => {
      const profile = workspace.profiles.find((item) => item.id === member.agentProfileId);
      return workspace.displayMode === 'description' && (member.responsibility.trim() || profile?.description.trim())
        ? member.responsibility.trim() || profile?.description.trim() || member.id
        : profile?.name || member.id;
    })()
  );
  const visibleTeams = useMemo(() => workspace.teams.flatMap((team) => {
    if (!normalizedQuery) return [team];
    const teamMatches = `${team.id} ${team.name} ${team.description}`
      .toLowerCase()
      .includes(normalizedQuery);
    const matchingAgents = team.members.filter((member) => {
      const profile = workspace.profiles.find((item) => item.id === member.agentProfileId);
      return `${member.id} ${profile?.name ?? ''} ${profile?.description ?? ''} ${member.responsibility}`.toLowerCase().includes(normalizedQuery);
    }
    );
    return teamMatches || matchingAgents.length > 0
      ? [{ ...team, members: teamMatches ? team.members : matchingAgents }]
      : [];
  }), [normalizedQuery, workspace.profiles, workspace.teams]);

  useEffect(() => {
    void loadTeamWorkspace().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (workspace.teams.length > 0) {
      setExpandedTeamIds((current) => new Set([...current, ...workspace.teams.map((team) => team.id)]));
    }
  }, [workspace.teams]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.team-sidebar-context-menu')) return;
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [contextMenu]);

  const toggleTeam = (teamId: string) => {
    setExpandedTeamIds((current) => {
      const next = new Set(current);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  };

  const openContextMenu = (
    event: ReactMouseEvent,
    target: Omit<TeamContextMenu, 'x' | 'y'>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 184;
    const height = target.kind === 'team' ? 220 : 128;
    setContextMenu({
      ...target,
      x: Math.max(8, Math.min(event.clientX + 2, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY + 2, window.innerHeight - height - 8)),
    });
  };

  const beginRename = (target: TeamContextMenu) => {
    const team = workspace.teams.find((candidate) => candidate.id === target.teamId);
    const member = team?.members.find((candidate) => candidate.id === target.agentId);
    const profile = workspace.profiles.find((candidate) => candidate.id === member?.agentProfileId);
    setRenameTarget({
      kind: target.kind,
      teamId: target.teamId,
      agentId: target.agentId,
      value: target.kind === 'team' ? team?.name ?? '' : profile?.name ?? '',
    });
    setContextMenu(null);
  };

  const commitRename = () => {
    if (!renameTarget) return;
    const value = renameTarget.value.trim();
    if (value) {
      if (renameTarget.kind === 'team') {
        teamWorkspaceActions.updateTeam(renameTarget.teamId, { name: value });
      } else if (renameTarget.agentId) {
        const team = workspace.teams.find((item) => item.id === renameTarget.teamId);
        const member = team?.members.find((item) => item.id === renameTarget.agentId);
        if (member) teamWorkspaceActions.updateProfile(member.agentProfileId, { name: value });
      }
    }
    setRenameTarget(null);
  };

  return (
    <aside
      className={`sidebar team-sidebar soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      ref={sidebarRef}
      aria-hidden={!softVisible}
    >
      <div className="team-sidebar-top">
        <button className="team-back-button" type="button" onClick={onBack}>
          <span>{zh ? '返回会话' : 'Back to chats'}</span>
        </button>
        <label className="team-sidebar-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={zh ? '搜索 Team 或 Agent' : 'Search teams or agents'}
          />
          {query && <button type="button" onClick={() => setQuery('')}>×</button>}
        </label>
        <div className="team-sidebar-actions" aria-label={zh ? 'Team 工具' : 'Team tools'}>
          <button
            className={workspace.view === 'install' ? 'active' : ''}
            type="button"
            onClick={() => teamWorkspaceActions.setView('install')}
          >
            <span>{zh ? '安装' : 'Install'}</span>
          </button>
          <button
            className={workspace.view === 'manage' ? 'active' : ''}
            type="button"
            onClick={() => teamWorkspaceActions.setView('manage')}
          >
            <span>{zh ? '管理' : 'Manage'}</span>
          </button>
        </div>
      </div>

      <div className="team-sidebar-scroll">
        <header className="team-sidebar-section-heading">
          <span>Team</span>
          <button
            type="button"
            title={zh ? '新建 Team' : 'New team'}
            aria-label={zh ? '新建 Team' : 'New team'}
            onClick={() => {
              const id = teamWorkspaceActions.createTeam(language);
              setExpandedTeamIds((current) => new Set(current).add(id));
            }}
          >
            +
          </button>
        </header>
        <div className="team-sidebar-list">
          {workspace.loading && <div className="team-sidebar-empty">{zh ? '正在加载 Team…' : 'Loading teams…'}</div>}
          {workspace.error && (
            <button className="team-sidebar-error" type="button" onClick={() => void teamWorkspaceActions.refresh()}>
              <span>{workspace.error}</span><small>{zh ? '点击重试' : 'Click to retry'}</small>
            </button>
          )}
          {visibleTeams.map((team) => {
            const expanded = normalizedQuery.length > 0 || expandedTeamIds.has(team.id);
            const active = team.id === workspace.activeTeamId;
            const renamingTeam = renameTarget?.kind === 'team' && renameTarget.teamId === team.id;
            return (
              <section className={`team-sidebar-group${active ? ' active' : ''}`} key={team.id}>
                <div
                  className="team-sidebar-team-row"
                  onContextMenu={(event) => openContextMenu(event, { kind: 'team', teamId: team.id })}
                >
                  {renamingTeam ? (
                    <input
                      autoFocus
                      className="team-sidebar-inline-rename"
                      value={renameTarget.value}
                      onChange={(event) => setRenameTarget({ ...renameTarget, value: event.currentTarget.value })}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') commitRename();
                        if (event.key === 'Escape') setRenameTarget(null);
                      }}
                    />
                  ) : (
                    <button
                      className="team-sidebar-team-main"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => {
                        toggleTeam(team.id);
                        if (!expanded) teamWorkspaceActions.selectTeam(team.id);
                      }}
                    >
                      <span title={displayTeamLabel(team)}>{displayTeamLabel(team)}</span>
                      <small>{team.members.length}</small>
                    </button>
                  )}
                  <button
                    className="team-sidebar-add-agent"
                    type="button"
                    title={zh ? '新建 Agent' : 'New agent'}
                    aria-label={zh ? `在 ${team.name} 新建 Agent` : `New agent in ${team.name}`}
                    onClick={() => {
                      teamWorkspaceActions.createAgent(team.id, language);
                      setExpandedTeamIds((current) => new Set(current).add(team.id));
                    }}
                  >
                    +
                  </button>
                </div>
                {expanded && (
                  <div className="team-sidebar-agent-list">
                    {team.members.map((agent) => {
                      const renamingAgent = renameTarget?.kind === 'agent' &&
                        renameTarget.teamId === team.id && renameTarget.agentId === agent.id;
                      return renamingAgent ? (
                        <input
                          autoFocus
                          className="team-sidebar-inline-rename nested"
                          key={agent.id}
                          value={renameTarget.value}
                          onChange={(event) => setRenameTarget({ ...renameTarget, value: event.currentTarget.value })}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename();
                            if (event.key === 'Escape') setRenameTarget(null);
                          }}
                        />
                      ) : (
                        <button
                          className={
                            team.id === workspace.activeTeamId &&
                            agent.id === workspace.activeMemberId &&
                            workspace.view === 'agent'
                              ? 'active'
                              : ''
                          }
                          key={agent.id}
                          type="button"
                          onContextMenu={(event) => openContextMenu(event, {
                            kind: 'agent',
                            teamId: team.id,
                            agentId: agent.id,
                          })}
                          onClick={() => teamWorkspaceActions.selectMember(team.id, agent.id)}
                        >
                          <span title={displayAgentLabel(agent)}>{displayAgentLabel(agent)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
          {visibleTeams.length === 0 && (
            <div className="team-sidebar-empty">
              {zh ? '没有匹配的 Team 或 Agent' : 'No matching team or agent'}
            </div>
          )}
        </div>
      </div>

      <button className="settings-dock" type="button" onClick={onOpenSettings}>
        <Settings size={17} />
        <span>{zh ? '设置' : 'Settings'}</span>
      </button>

      {contextMenu && createPortal(
        <TeamSidebarContextMenu
          language={language}
          menu={contextMenu}
          workflowCount={workspace.teams.length}
          agentCount={workspace.teams.find((team) => team.id === contextMenu.teamId)?.members.length ?? 0}
          onClose={() => setContextMenu(null)}
          onRename={() => beginRename(contextMenu)}
          onCreateAgent={() => {
            teamWorkspaceActions.createAgent(contextMenu.teamId, language);
            setExpandedTeamIds((current) => new Set(current).add(contextMenu.teamId));
          }}
        />,
        sidebarRef.current?.closest('.app') ?? document.body,
      )}
    </aside>
  );
}

function TeamSidebarContextMenu({
  language,
  menu,
  workflowCount,
  agentCount,
  onClose,
  onRename,
  onCreateAgent,
}: {
  language: AppLanguage;
  menu: TeamContextMenu;
  workflowCount: number;
  agentCount: number;
  onClose: () => void;
  onRename: () => void;
  onCreateAgent: () => void;
}) {
  const zh = language === 'zh';
  const run = (action: () => void) => {
    onClose();
    action();
  };
  return (
    <div
      className="sidebar-context-menu team-sidebar-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
    >
      <button className="sidebar-menu-button" type="button" role="menuitem" onClick={() => run(() => {
        if (menu.kind === 'team') teamWorkspaceActions.selectTeam(menu.teamId);
        else if (menu.agentId) teamWorkspaceActions.selectMember(menu.teamId, menu.agentId);
      })}>
        <span>{zh ? '打开配置' : 'Open configuration'}</span>
      </button>
      {menu.kind === 'team' && (
        <button className="sidebar-menu-button" type="button" role="menuitem" onClick={() => run(onCreateAgent)}>
          <span>{zh ? '新建 Agent' : 'New agent'}</span>
        </button>
      )}
      <button className="sidebar-menu-button" type="button" role="menuitem" onClick={onRename}>
        <span>{menu.kind === 'team'
          ? zh ? '重命名 Team' : 'Rename team'
          : zh ? '重命名 Agent' : 'Rename agent'}</span>
      </button>
      {menu.kind === 'team' && (
        <>
          <button className="sidebar-menu-button" type="button" role="menuitem" onClick={() => run(() => teamWorkspaceActions.setDisplayMode('name'))}>
            <span>{zh ? '按名称显示' : 'Show names'}</span>
          </button>
          <button className="sidebar-menu-button" type="button" role="menuitem" onClick={() => run(() => teamWorkspaceActions.setDisplayMode('description'))}>
            <span>{zh ? '按描述显示' : 'Show descriptions'}</span>
          </button>
        </>
      )}
      <button
        className="sidebar-menu-button danger"
        type="button"
        role="menuitem"
        disabled={menu.kind === 'team' ? workflowCount <= 1 : agentCount <= 1}
        onClick={() => {
          const confirmed = window.confirm(
            menu.kind === 'team'
              ? zh ? '确定删除这个 Team？' : 'Delete this team?'
              : zh ? '确定删除这个 Agent？' : 'Delete this agent?',
          );
          if (!confirmed) return;
          run(() => {
            if (menu.kind === 'team') void teamWorkspaceActions.deleteTeam(menu.teamId);
            else if (menu.agentId) teamWorkspaceActions.deleteAgent(menu.teamId, menu.agentId);
          });
        }}
      >
        <span>{menu.kind === 'team'
          ? zh ? '删除 Team' : 'Delete team'
          : zh ? '删除 Agent' : 'Delete agent'}</span>
      </button>
    </div>
  );
}
