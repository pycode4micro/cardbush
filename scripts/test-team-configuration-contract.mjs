import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/features/team/TeamSidebar.tsx', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/features/team/TeamWorkflowPanel.tsx', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/features/team/teamWorkspaceStore.ts', import.meta.url), 'utf8');
const productTeams = readFileSync(new URL('../src/backend/productTeams.ts', import.meta.url), 'utf8');

function expect(value, message) {
  if (!value) throw new Error(message);
}

expect(
  app.includes("section === 'team'") && app.includes('<TeamSidebar'),
  'Team mode must replace the regular chat sidebar.',
);
expect(sidebar.includes('返回会话') && sidebar.includes('Back to chats'), 'Team sidebar must expose chat return navigation.');
expect(sidebar.includes('安装') && sidebar.includes('管理'), 'Team sidebar must expose install and management actions.');
expect(sidebar.includes('team-sidebar-search') && !sidebar.includes('searchOpen'), 'Team search must be visible without an activation button.');
expect(sidebar.includes('createTeam(language)') && sidebar.includes('createAgent(team.id, language)'), 'Team sidebar must create teams and nested agents.');
expect(sidebar.includes('aria-expanded={expanded}') && sidebar.includes('toggleTeam(team.id)'), 'Team rows must support project-style expand and collapse.');
expect(!sidebar.includes('UsersRound') && !sidebar.includes('<Bot'), 'Team and Agent rows must use text hierarchy instead of decorative icons.');
expect(sidebar.includes('onContextMenu') && sidebar.includes('TeamSidebarContextMenu'), 'Team and Agent rows must expose project-style context menus.');
expect(sidebar.includes('className="settings-dock"') && sidebar.includes('onOpenSettings'), 'Team sidebar must keep the settings shortcut.');
expect(!panel.includes('<Bot') && !panel.includes('<UsersRound'), 'Team configuration headings must not render decorative robot/group icons.');
expect(sidebar.includes('>\n            +\n') || sidebar.includes('>\r\n            +\r\n'), 'New Team must use the compact plus affordance.');
expect(panel.includes('<AgentEditor') && panel.includes('<TeamManagement') && panel.includes('<TeamCreatePage'), 'Team content must provide agent, management, and creation surfaces.');
expect(!panel.includes('team-agent-rail') && !panel.includes('team-agent-marker'), 'Agent configuration must not render the old scale rail.');
expect(store.includes("type TeamWorkspaceView = 'agent' | 'manage' | 'install'"), 'Team workspace views must be explicit.');
expect(store.includes("type TeamSidebarDisplayMode = 'name' | 'description'"), 'Team sidebar must support name and description labels.');
expect(store.includes('displayModeStorageKey'), 'Team sidebar display preference must persist.');
expect(store.includes('fetchTeams()') && store.includes('fetchAgentProfiles()'), 'Team UI must load the product Team/Profile catalogs.');
expect(
  productTeams.includes('readArrayOrDefault(teamsKey, [bundledGeneralTeam])') &&
    productTeams.includes('readArrayOrDefault(profilesKey, [bundledGeneralProfile])'),
  'A fresh CardBush profile must expose the bundled General Team and Agent profile.',
);
expect(store.includes('saveAgentProfile(profile)') && store.includes('saveTeamDefinition(team)'), 'Team save must validate and persist profiles before the Team.');
expect(app.includes('selectedTeamId: teamWorkspace.selectedTeamId'), 'Chat request context must receive the current Team selection.');
expect(app.includes("section === 'team'") && app.includes('activeTeam?.name.trim()'), 'The Team page title must use the active Team name.');

const api = readFileSync(new URL('../src/backend/api.ts', import.meta.url), 'utf8');
const runtimeChat = readFileSync(new URL('../src/backend/runtimeChat.ts', import.meta.url), 'utf8');
const composer = readFileSync(new URL('../src/features/composer/Composer.tsx', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../src/hooks/useCardbushChat.ts', import.meta.url), 'utf8');
expect(
  api.includes('readProductTeams()') &&
    api.includes('readProductAgentProfiles()') &&
    api.includes('replaceProductTeamConfiguration(runtime.client'),
  'Team configuration must use the product snapshot and typed Runtime boundary.',
);
expect(!api.includes('/v1/teams') && !api.includes('/v1/agent-profiles'), 'Team configuration must not depend on the retired HTTP service.');
expect(runtimeChat.includes('teamId: request.teamId'), 'Team activation must be part of the typed Turn request.');
expect(composer.includes("id: '/team'") && composer.includes('<ComposerTeamPicker'), '/team must open the frontend Team picker.');
expect(hook.includes('teamId: turnTeamId'), 'Each new Turn must snapshot the selected Team.');

console.log('team configuration contract: ok');
