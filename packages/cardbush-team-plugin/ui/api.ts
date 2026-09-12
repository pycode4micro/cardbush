import { runtimeClient, synchronizeTools } from './host';
import { AGENT_PROFILE_PROTOCOL, type TeamDefinition, type AgentProfileDefinition, type TeamConfigurationCapabilities } from './types';
import { readProductTeams, readProductAgentProfiles, readProductTeamConfiguration, replaceProductTeamConfiguration } from './productTeams';

export async function fetchTeams(_signal?: AbortSignal) { return readProductTeams(); }
export async function fetchAgentProfiles(_signal?: AbortSignal) { return readProductAgentProfiles(); }
export async function fetchTeamWorkspace() { return readProductTeamConfiguration(); }

async function updateConfiguration(change: (configuration: { teams: TeamDefinition[]; profiles: AgentProfileDefinition[] }) => void, expectedHash?: string, signal?: AbortSignal) {

    void signal;
    await synchronizeTools();
    const tools = await runtimeClient.getToolCatalog();
    const receipt = await readProductTeamConfiguration();
    change(receipt.configuration);
    return (await replaceProductTeamConfiguration(runtimeClient, {
      ...receipt.configuration, tools, expectedHash: expectedHash ?? receipt.contentHash,
    })).configurationReceipt;

}

export async function saveTeamDefinition(team: TeamDefinition, signal?: AbortSignal) {
  await updateConfiguration(configuration => {
    const index = configuration.teams.findIndex(item => item.id === team.id);
    if (index < 0) configuration.teams.push(team); else configuration.teams[index] = team;
  }, undefined, signal);
  return team;
}
export async function saveAgentProfile(profile: AgentProfileDefinition, signal?: AbortSignal) {
  await updateConfiguration(configuration => {
    const index = configuration.profiles.findIndex(item => item.id === profile.id);
    if (index < 0) configuration.profiles.push(profile); else configuration.profiles[index] = profile;
  }, undefined, signal);
  return profile;
}
export async function deleteTeamDefinition(teamId: string, expectedHash?: string) {
  return updateConfiguration(configuration => { configuration.teams = configuration.teams.filter(team => team.id !== teamId.trim()); }, expectedHash);
}
export async function deleteAgentProfile(profileId: string, expectedHash?: string) {
  return updateConfiguration(configuration => { configuration.profiles = configuration.profiles.filter(profile => profile.id !== profileId.trim()); }, expectedHash);
}
export async function saveTeamWorkspace(input: { teams: TeamDefinition[]; profiles: AgentProfileDefinition[]; expectedHash: string }) {
  return updateConfiguration(configuration => { configuration.teams = input.teams; configuration.profiles = input.profiles; }, input.expectedHash);
}

export async function fetchTeamConfigurationCapabilities(signal?: AbortSignal) {
  void signal;
  return {
    available: true,
    teamProtocol: 'bush.team_snapshot.v1',
    agentProfileProtocol: AGENT_PROFILE_PROTOCOL,
    contextProtocol: 'bush.session_snapshot.v1',
    delegationTool: 'team_delegate',
    ordinarySubagentProfileArgument: false,
    memberCapabilities: [
      'responsibility',
      'disabled_tools',
      'skills',
      'hooks',
      'guards',
      'prompts.instructions',
      'fallback',
    ],
    toolPolicy: 'explicit_snapshot',
    fallbackMemberRequired: true,
    fixedDag: false,
    profileOnlyHooks: [],
  } satisfies TeamConfigurationCapabilities;
}
