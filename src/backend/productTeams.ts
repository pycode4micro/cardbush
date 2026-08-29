import {
  BUSH_TEAM_SNAPSHOT_PROTOCOL,
  teamSnapshotSchema,
  type TeamSnapshotResult,
  type ToolDefinition,
} from '@cardbush/bush-protocol';

import type { AgentProfileDefinition, TeamDefinition } from '../types';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';

const teamsKey = 'cardbush_product_teams_v1';
const profilesKey = 'cardbush_product_agent_profiles_v1';
const revisionKey = 'cardbush_product_team_revision_v1';
const snapshotId = 'cardbush-product-teams';

export function readProductTeams(): TeamDefinition[] {
  return readArray(teamsKey) as TeamDefinition[];
}

export function readProductAgentProfiles(): AgentProfileDefinition[] {
  return readArray(profilesKey) as AgentProfileDefinition[];
}

export async function synchronizeProductTeamSnapshot(
  client: Pick<ProtocolRuntimeClient, 'applyTeamSnapshot'>,
  tools: ToolDefinition[],
): Promise<TeamSnapshotResult> {
  return client.applyTeamSnapshot(snapshot(
    readProductTeams(),
    readProductAgentProfiles(),
    tools,
    readRevision(),
  ));
}

export async function replaceProductTeamConfiguration(
  client: Pick<ProtocolRuntimeClient, 'applyTeamSnapshot'>,
  input: {
    teams: TeamDefinition[];
    profiles: AgentProfileDefinition[];
    tools: ToolDefinition[];
  },
): Promise<TeamSnapshotResult> {
  const previous = new Map([
    [teamsKey, window.localStorage.getItem(teamsKey)],
    [profilesKey, window.localStorage.getItem(profilesKey)],
    [revisionKey, window.localStorage.getItem(revisionKey)],
  ]);
  const revision = readRevision() + 1;
  window.localStorage.setItem(teamsKey, JSON.stringify(input.teams));
  window.localStorage.setItem(profilesKey, JSON.stringify(input.profiles));
  window.localStorage.setItem(revisionKey, String(revision));
  try {
    return await client.applyTeamSnapshot(snapshot(
      input.teams,
      input.profiles,
      input.tools,
      revision,
    ));
  } catch (error) {
    for (const [key, value] of previous) restore(key, value);
    throw error;
  }
}

export function validateProductTeamConfiguration(input: {
  teams: TeamDefinition[];
  profiles: AgentProfileDefinition[];
  tools: ToolDefinition[];
}) {
  return teamSnapshotSchema.safeParse(snapshot(
    input.teams,
    input.profiles,
    input.tools,
    1,
  ));
}

function snapshot(
  teams: TeamDefinition[],
  profiles: AgentProfileDefinition[],
  tools: ToolDefinition[],
  revision: number,
) {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const toolNames = tools.map((tool) => tool.name);
  return {
    protocol: BUSH_TEAM_SNAPSHOT_PROTOCOL,
    snapshotId,
    revision,
    teams: teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      instructions: team.description,
      conference: {
        enabled: team.conferenceEnabled === true,
        instructions: team.conferenceInstructions ?? '',
      },
      members: team.members.map((member) => {
        const profile = profilesById.get(member.agentProfileId);
        if (!profile) {
          throw new Error(
            `Team ${team.id} member ${member.id} references missing Agent configuration ${member.agentProfileId}.`,
          );
        }
        return {
          memberId: member.id,
          name: profile.name || member.id,
          role: member.responsibility || profile.description || profile.name || member.id,
          instructions: [profile.prompts.instructions, member.responsibility]
            .map((value) => value?.trim())
            .filter(Boolean)
            .join('\n\n'),
          toolNames: toolNames.filter((name) => !profile.disabledTools.includes(name)),
        };
      }),
    })),
  };
}

function readArray(key: string): unknown[] {
  const raw = window.localStorage.getItem(key);
  if (!raw?.trim()) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readRevision() {
  const value = Number(window.localStorage.getItem(revisionKey));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function restore(key: string, value: string | null) {
  if (value == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}
