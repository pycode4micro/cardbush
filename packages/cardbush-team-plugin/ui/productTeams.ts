import { defaultTeamConfiguration, TEAM_CONFIGURATION_FILE_PROTOCOL, teamConfigurationSchema, type TeamConfigurationReceipt } from '../src/configuration';
import {
  BUSH_TEAM_SNAPSHOT_PROTOCOL,
  serializeTeamSnapshotContent,
  teamSnapshotSchema,
  type TeamSnapshot,
  type TeamSnapshotResult,
  type ToolDefinition,
} from '@cardbush/bush-protocol';

import type { AgentProfileDefinition, TeamDefinition } from './types';
import { teamConfiguration, runtimeClient } from './host';

const teamsKey = 'cardbush_product_teams_v1';
const profilesKey = 'cardbush_product_agent_profiles_v1';
const revisionKey = 'cardbush_product_team_revision_v1';
const snapshotId = 'cardbush-product-teams';
type TeamSnapshotClient = typeof runtimeClient;

// Per-turn clients share one Runtime team store; revision selection and apply must be serialized.
let pendingUpdate: Promise<unknown> = Promise.resolve();
function serializeUpdate<T>(update: () => Promise<T>): Promise<T> {
  const task = pendingUpdate.then(update);
  pendingUpdate = task.catch(() => {});
  return task;
}

export async function readProductTeamConfiguration(): Promise<TeamConfigurationReceipt> {
  const bridge = teamConfiguration;
  if (!bridge) throw new Error('The Team plugin file configuration bridge is unavailable.');
  const oldTeams = window.localStorage.getItem(teamsKey);
  const oldProfiles = window.localStorage.getItem(profilesKey);
  const defaults = defaultTeamConfiguration();
  const migration = oldTeams || oldProfiles ? { ...defaults,
    teams: oldTeams ? JSON.parse(oldTeams) : defaults.teams,
    profiles: oldProfiles ? JSON.parse(oldProfiles) : defaults.profiles,
  } : undefined;
  const receipt = await bridge({ action: 'read', migration }) as TeamConfigurationReceipt;
  teamConfigurationSchema.parse(receipt.configuration);
  // Remove legacy storage only after the file-backed receipt confirms successful migration.
  window.localStorage.removeItem(teamsKey);
  window.localStorage.removeItem(profilesKey);
  return receipt;
}

export async function readProductTeams(): Promise<TeamDefinition[]> {
  return (await readProductTeamConfiguration()).configuration.teams;
}
export async function readProductAgentProfiles(): Promise<AgentProfileDefinition[]> {
  return (await readProductTeamConfiguration()).configuration.profiles;
}
export async function synchronizeProductTeamSnapshot(client: TeamSnapshotClient, tools: ToolDefinition[]): Promise<TeamSnapshotResult> {
  return serializeUpdate(async () => {
    const { configuration } = await readProductTeamConfiguration();
    return applySnapshot(client, snapshot(configuration.teams, configuration.profiles, tools));
  });
}
export async function replaceProductTeamConfiguration(client: TeamSnapshotClient, input: {
  teams: TeamDefinition[]; profiles: AgentProfileDefinition[]; tools: ToolDefinition[]; expectedHash?: string;
}): Promise<TeamSnapshotResult & { configurationReceipt: TeamConfigurationReceipt }> {
  return serializeUpdate(async () => {
    const before = await readProductTeamConfiguration();
    if (input.expectedHash !== undefined && input.expectedHash !== before.contentHash) throw new Error('Team configuration changed on disk. Refresh before saving.');
    const configuration = teamConfigurationSchema.parse({ protocol: TEAM_CONFIGURATION_FILE_PROTOCOL, teams: input.teams, profiles: input.profiles });
    const next = snapshot(configuration.teams, configuration.profiles, input.tools);
    // Validate/admit effective constraints before committing the editable source file.
    // On a lost apply response or a file conflict the next send reconciles from that file.
    const result = await applySnapshot(client, next);
    const configurationReceipt = await teamConfiguration({ action: 'write', configuration, expectedHash: before.contentHash }) as TeamConfigurationReceipt;
    return { ...result, configurationReceipt };
  });
}
export async function resetProductTeamConfiguration(client: TeamSnapshotClient, tools: ToolDefinition[]): Promise<TeamSnapshotResult> {
  return replaceProductTeamConfiguration(client, { ...defaultTeamConfiguration(), tools });
}

function snapshot(
  teams: TeamDefinition[],
  profiles: AgentProfileDefinition[],
  tools: ToolDefinition[],
): TeamSnapshot {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const toolNames = [...new Set(tools.map((tool) => tool.name))].sort();
  return teamSnapshotSchema.parse({
    protocol: BUSH_TEAM_SNAPSHOT_PROTOCOL,
    snapshotId,
    revision: 1,
    teams: teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      instructions: team.description,
      members: team.members.map((member) => {
        const profile = profilesById.get(member.agentProfileId);
        if (!profile) {
          throw new Error(
            `Team ${team.id} member ${member.id} references missing Agent configuration ${member.agentProfileId}.`,
          );
        }
        if (profile.hooks.length > 0 || profile.guards.length > 0) {
          throw new Error(
            `Agent configuration ${profile.id} references Hook/Guard ids, but this CardBush Runtime has no trusted Hook/Guard registrations.`,
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
          agentProfileId: profile.id,
          fallback: member.fallback === true,
          skills: profile.skills,
          hooks: profile.hooks ?? [],
          guards: profile.guards ?? [],
          promptInstructions: profile.prompts.instructions,
        };
      }),
    })),
  });
}

async function applySnapshot(client: TeamSnapshotClient, next: TeamSnapshot): Promise<TeamSnapshotResult> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeTeamSnapshotContent(next)));
  const contentHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const applied = await client.getTeamSnapshot();
  const current = applied?.snapshotId === snapshotId ? applied : null;
  let result: TeamSnapshotResult;
  if (current?.contentHash === contentHash) {
    // The Runtime is authoritative, including after a renderer restart or a lost apply response.
    result = current;
  } else {
    const revision = current ? Math.max(readRevision(), current.revision) + 1 : readRevision();
    if (!Number.isSafeInteger(revision)) throw new Error('Team snapshot revision exceeds the supported range.');
    result = await client.applyTeamSnapshot({ ...next, revision });
  }
  // Persist only the successful revision floor; never keep a second copy of the effective catalog.
  const revision = Math.max(readRevision(), result.revision);
  if (window.localStorage.getItem(revisionKey) !== String(revision)) {
    window.localStorage.setItem(revisionKey, String(revision));
  }
  return result;
}

function readRevision() {
  const value = Number(window.localStorage.getItem(revisionKey));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}
