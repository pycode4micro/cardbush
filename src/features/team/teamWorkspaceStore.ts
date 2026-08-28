import { useSyncExternalStore } from 'react';

import {
  deleteAgentProfile,
  deleteTeamDefinition,
  fetchAgentProfiles,
  fetchTeamConfigurationCapabilities,
  fetchTeams,
  saveAgentProfile,
  saveTeamDefinition,
} from '../../backend/api';
import {
  AGENT_PROFILE_PROTOCOL,
  TEAM_CONFIGURATION_PROTOCOL,
  type AgentProfileDefinition,
  type AppLanguage,
  type TeamConfigurationCapabilities,
  type TeamDefinition,
  type TeamMemberDefinition,
} from '../../types';

export type TeamWorkspaceView = 'agent' | 'manage' | 'install';
export type TeamSidebarDisplayMode = 'name' | 'description';

const displayModeStorageKey = 'cardbush_team_sidebar_display_mode_v1';
const selectedTeamStorageKey = 'cardbush_selected_team_v1';

type TeamWorkspaceState = {
  teams: TeamDefinition[];
  profiles: AgentProfileDefinition[];
  capabilities: TeamConfigurationCapabilities | null;
  activeTeamId: string;
  activeMemberId: string;
  selectedTeamId: string;
  view: TeamWorkspaceView;
  displayMode: TeamSidebarDisplayMode;
  loading: boolean;
  saving: boolean;
  loaded: boolean;
  error: string;
  dirtyTeamIds: Set<string>;
  dirtyProfileIds: Set<string>;
  remoteTeamIds: Set<string>;
  remoteProfileIds: Set<string>;
};

let state: TeamWorkspaceState = {
  teams: [], profiles: [], capabilities: null,
  activeTeamId: '', activeMemberId: '', selectedTeamId: readStorage(selectedTeamStorageKey),
  view: 'agent',
  displayMode: readStorage(displayModeStorageKey) === 'description' ? 'description' : 'name',
  loading: false, saving: false, loaded: false, error: '',
  dirtyTeamIds: new Set(), dirtyProfileIds: new Set(),
  remoteTeamIds: new Set(), remoteProfileIds: new Set(),
};
const listeners = new Set<() => void>();
let loadPromise: Promise<void> | null = null;

function readStorage(key: string) {
  try { return window.localStorage.getItem(key)?.trim() ?? ''; } catch { return ''; }
}
function writeStorage(key: string, value: string) {
  try { if (value) window.localStorage.setItem(key, value); else window.localStorage.removeItem(key); } catch { /* optional */ }
}
function normalizeSelection(current: TeamWorkspaceState): TeamWorkspaceState {
  const activeTeam = current.teams.find((team) => team.id === current.activeTeamId) ?? current.teams[0];
  const activeMember = activeTeam?.members.find((member) => member.id === current.activeMemberId) ?? activeTeam?.members[0];
  return {
    ...current,
    activeTeamId: activeTeam?.id ?? '',
    activeMemberId: activeMember?.id ?? '',
    selectedTeamId: current.teams.length === 0 && !current.loaded
      ? current.selectedTeamId
      : current.teams.some((team) => team.id === current.selectedTeamId) ? current.selectedTeamId : '',
  };
}
function publish(next: TeamWorkspaceState) {
  state = normalizeSelection(next);
  listeners.forEach((listener) => listener());
}
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function uniqueId(prefix: string, values: Iterable<string>) {
  const used = new Set(values);
  const base = prefix.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
  if (!used.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) if (!used.has(`${base}-${index}`)) return `${base}-${index}`;
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}
function createProfile(language: AppLanguage): AgentProfileDefinition {
  const id = uniqueId('agent', state.profiles.map((profile) => profile.id));
  return {
    protocol: AGENT_PROFILE_PROTOCOL, id,
    name: language === 'zh' ? '新 Agent' : 'New Agent', description: '',
    disabledTools: [], hooks: [], guards: [], prompts: { instructions: '' },
  };
}
function createMember(profile: AgentProfileDefinition, fallback: boolean): TeamMemberDefinition {
  return { id: profile.id, agentProfileId: profile.id, responsibility: '', fallback };
}

export function useTeamWorkspaceState() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => state, () => state,
  );
}

export function loadTeamWorkspace(force = false) {
  if (loadPromise && !force) return loadPromise;
  if (state.loaded && !force) return Promise.resolve();
  publish({ ...state, loading: true, error: '' });
  loadPromise = Promise.all([fetchTeams(), fetchAgentProfiles(), fetchTeamConfigurationCapabilities()])
    .then(([teams, profiles, capabilities]) => {
      const selectedTeamId = state.selectedTeamId || readStorage(selectedTeamStorageKey);
      publish({
      ...state, teams, profiles, capabilities,
      selectedTeamId: teams.some((team) => team.id === selectedTeamId) ? selectedTeamId : '',
      loading: false, loaded: true, error: '',
      dirtyTeamIds: new Set(), dirtyProfileIds: new Set(),
      remoteTeamIds: new Set(teams.map((team) => team.id)),
      remoteProfileIds: new Set(profiles.map((profile) => profile.id)),
    });
    })
    .catch((error) => { publish({ ...state, loading: false, loaded: true, error: errorText(error) }); throw error; })
    .finally(() => { loadPromise = null; });
  return loadPromise;
}

export const teamWorkspaceActions = {
  refresh() { return loadTeamWorkspace(true); },
  clearError() { publish({ ...state, error: '' }); },
  setView(view: TeamWorkspaceView) { publish({ ...state, view }); },
  setDisplayMode(displayMode: TeamSidebarDisplayMode) { writeStorage(displayModeStorageKey, displayMode); publish({ ...state, displayMode }); },
  selectTeam(teamId: string) {
    const team = state.teams.find((candidate) => candidate.id === teamId); if (!team) return;
    publish({ ...state, activeTeamId: team.id, activeMemberId: team.members[0]?.id ?? '', view: 'agent' });
  },
  selectMember(teamId: string, memberId: string) {
    const team = state.teams.find((candidate) => candidate.id === teamId);
    if (!team?.members.some((member) => member.id === memberId)) return;
    publish({ ...state, activeTeamId: teamId, activeMemberId: memberId, view: 'agent' });
  },
  selectForNextTurn(teamId: string) {
    const normalized = state.teams.some((team) => team.id === teamId) ? teamId : '';
    writeStorage(selectedTeamStorageKey, normalized); publish({ ...state, selectedTeamId: normalized });
  },
  createTeam(language: AppLanguage) {
    const profile = createProfile(language);
    const id = uniqueId('team', state.teams.map((team) => team.id));
    const team: TeamDefinition = {
      protocol: TEAM_CONFIGURATION_PROTOCOL, id,
      name: language === 'zh' ? '未命名 Team' : 'Untitled Team', description: '',
      members: [createMember(profile, true)],
    };
    publish({
      ...state, teams: [team, ...state.teams], profiles: [profile, ...state.profiles],
      activeTeamId: id, activeMemberId: team.members[0].id, view: 'agent',
      dirtyTeamIds: new Set(state.dirtyTeamIds).add(id),
      dirtyProfileIds: new Set(state.dirtyProfileIds).add(profile.id),
    });
    return id;
  },
  createAgent(teamId: string, language: AppLanguage) {
    const team = state.teams.find((candidate) => candidate.id === teamId); if (!team) return '';
    const profile = createProfile(language);
    const member = { ...createMember(profile, team.members.length === 0), id: uniqueId(profile.id, team.members.map((item) => item.id)) };
    publish({
      ...state, profiles: [...state.profiles, profile],
      teams: state.teams.map((candidate) => candidate.id === teamId ? { ...candidate, members: [...candidate.members, member] } : candidate),
      activeTeamId: teamId, activeMemberId: member.id, view: 'agent',
      dirtyTeamIds: new Set(state.dirtyTeamIds).add(teamId),
      dirtyProfileIds: new Set(state.dirtyProfileIds).add(profile.id),
    });
    return member.id;
  },
  updateTeam(teamId: string, patch: Partial<Pick<TeamDefinition, 'name' | 'description'>>) {
    publish({ ...state, teams: state.teams.map((team) => team.id === teamId ? { ...team, ...patch } : team), dirtyTeamIds: new Set(state.dirtyTeamIds).add(teamId) });
  },
  updateMember(teamId: string, memberId: string, patch: Partial<TeamMemberDefinition>) {
    publish({
      ...state,
      teams: state.teams.map((team) => team.id === teamId ? {
        ...team,
        members: team.members.map((member) => member.id === memberId
          ? { ...member, ...patch, id: member.id }
          : patch.fallback === true ? { ...member, fallback: false } : member),
      } : team),
      dirtyTeamIds: new Set(state.dirtyTeamIds).add(teamId),
    });
  },
  updateProfile(profileId: string, patch: Partial<AgentProfileDefinition>) {
    publish({
      ...state,
      profiles: state.profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch, id: profile.id, prompts: patch.prompts ?? profile.prompts } : profile),
      dirtyProfileIds: new Set(state.dirtyProfileIds).add(profileId),
    });
  },
  async saveTeam(teamId: string) {
    const team = state.teams.find((candidate) => candidate.id === teamId); if (!team || state.saving) return;
    publish({ ...state, saving: true, error: '' });
    try {
      const profileIds = [...new Set(team.members.map((member) => member.agentProfileId))];
      const savedProfiles = await Promise.all(profileIds.map((profileId) => {
        const profile = state.profiles.find((candidate) => candidate.id === profileId);
        if (!profile) throw new Error(`Agent Profile ${profileId} is missing`);
        return saveAgentProfile(profile);
      }));
      const savedTeam = await saveTeamDefinition(team);
      const dirtyProfiles = new Set(state.dirtyProfileIds); savedProfiles.forEach((profile) => dirtyProfiles.delete(profile.id));
      const dirtyTeams = new Set(state.dirtyTeamIds); dirtyTeams.delete(savedTeam.id);
      publish({
        ...state,
        teams: state.teams.map((item) => item.id === savedTeam.id ? savedTeam : item),
        profiles: state.profiles.map((item) => savedProfiles.find((saved) => saved.id === item.id) ?? item),
        saving: false, error: '', dirtyTeamIds: dirtyTeams, dirtyProfileIds: dirtyProfiles,
        remoteTeamIds: new Set(state.remoteTeamIds).add(savedTeam.id),
        remoteProfileIds: new Set([...state.remoteProfileIds, ...savedProfiles.map((item) => item.id)]),
      });
    } catch (error) { publish({ ...state, saving: false, error: errorText(error) }); throw error; }
  },
  deleteAgent(teamId: string, memberId: string) {
    const team = state.teams.find((candidate) => candidate.id === teamId);
    if (!team || team.members.length <= 1) return;
    const members = team.members.filter((member) => member.id !== memberId);
    if (!members.some((member) => member.fallback)) members[0] = { ...members[0], fallback: true };
    publish({
      ...state,
      teams: state.teams.map((item) => item.id === teamId ? { ...item, members } : item),
      activeMemberId: state.activeMemberId === memberId ? members[0]?.id ?? '' : state.activeMemberId,
      dirtyTeamIds: new Set(state.dirtyTeamIds).add(teamId),
    });
  },
  async deleteTeam(teamId: string) {
    try {
      if (state.remoteTeamIds.has(teamId)) await deleteTeamDefinition(teamId);
      if (state.selectedTeamId === teamId) writeStorage(selectedTeamStorageKey, '');
      publish({ ...state, teams: state.teams.filter((team) => team.id !== teamId), selectedTeamId: state.selectedTeamId === teamId ? '' : state.selectedTeamId, error: '' });
    } catch (error) { publish({ ...state, error: errorText(error) }); throw error; }
  },
  async deleteProfile(profileId: string) {
    try {
      if (state.remoteProfileIds.has(profileId)) await deleteAgentProfile(profileId);
      publish({ ...state, profiles: state.profiles.filter((profile) => profile.id !== profileId), error: '' });
    } catch (error) { publish({ ...state, error: errorText(error) }); throw error; }
  },
};
