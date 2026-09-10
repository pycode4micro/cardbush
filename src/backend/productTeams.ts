import {
  BUSH_TEAM_SNAPSHOT_PROTOCOL,
  serializeTeamSnapshotContent,
  teamSnapshotSchema,
  type TeamSnapshot,
  type TeamSnapshotResult,
  type ToolDefinition,
} from '@cardbush/bush-protocol';

import type { AgentProfileDefinition, TeamDefinition } from '../types';
import type { ProtocolRuntimeClient } from '../runtime-client/ProtocolRuntimeClient';

const teamsKey = 'cardbush_product_teams_v1';
const profilesKey = 'cardbush_product_agent_profiles_v1';
const revisionKey = 'cardbush_product_team_revision_v1';
const snapshotId = 'cardbush-product-teams';
type TeamSnapshotClient = Pick<ProtocolRuntimeClient, 'getTeamSnapshot' | 'applyTeamSnapshot'>;

// Per-turn clients share one Runtime team store; revision selection and apply must be serialized.
let pendingUpdate: Promise<unknown> = Promise.resolve();
function serializeUpdate<T>(update: () => Promise<T>): Promise<T> {
  const task = pendingUpdate.then(update);
  pendingUpdate = task.catch(() => {});
  return task;
}

const bundledGeneralProfile: AgentProfileDefinition = {
  protocol: 'bush.agent_profile.v1',
  id: 'general',
  name: 'General Agent',
  description: 'General-purpose collaborator for delegated work.',
  disabledTools: [],
  skills: [],
  hooks: [],
  guards: [],
  prompts: {
    instructions: 'Handle the delegated task carefully and return concrete evidence to the parent Agent.',
  },
};

const bundledGeneralTeam: TeamDefinition = {
  protocol: 'bush.team.v1',
  id: 'general',
  name: 'General Team',
  description: 'A minimal Team with one general-purpose fallback member.',
  members: [{
    id: 'general',
    agentProfileId: 'general',
    responsibility: 'Handle general delegated work.',
    fallback: true,
  }],
};

export function readProductTeams(): TeamDefinition[] {
  return readArrayOrDefault(teamsKey, [bundledGeneralTeam]) as TeamDefinition[];
}

export function readProductAgentProfiles(): AgentProfileDefinition[] {
  return readArrayOrDefault(profilesKey, [bundledGeneralProfile]) as AgentProfileDefinition[];
}

export async function synchronizeProductTeamSnapshot(
  client: TeamSnapshotClient,
  tools: ToolDefinition[],
): Promise<TeamSnapshotResult> {
  return serializeUpdate(() => applySnapshot(client, snapshot(
    readProductTeams(), readProductAgentProfiles(), tools,
  )));
}

export async function replaceProductTeamConfiguration(
  client: TeamSnapshotClient,
  input: {
    teams: TeamDefinition[];
    profiles: AgentProfileDefinition[];
    tools: ToolDefinition[];
  },
): Promise<TeamSnapshotResult> {
  return serializeUpdate(async () => {
    const next = snapshot(input.teams, input.profiles, input.tools);
    const previous = new Map([
      [teamsKey, window.localStorage.getItem(teamsKey)],
      [profilesKey, window.localStorage.getItem(profilesKey)],
      [revisionKey, window.localStorage.getItem(revisionKey)],
    ]);
    try {
      window.localStorage.setItem(teamsKey, JSON.stringify(input.teams));
      window.localStorage.setItem(profilesKey, JSON.stringify(input.profiles));
      return await applySnapshot(client, next);
    } catch (error) {
      for (const [key, value] of previous) restore(key, value);
      throw error;
    }
  });
}

export async function resetProductTeamConfiguration(
  client: TeamSnapshotClient,
  tools: ToolDefinition[],
): Promise<TeamSnapshotResult> {
  return replaceProductTeamConfiguration(client, {
    teams: [structuredClone(bundledGeneralTeam)],
    profiles: [structuredClone(bundledGeneralProfile)],
    tools,
  });
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

function readArrayOrDefault(key: string, fallback: unknown[]): unknown[] {
  const raw = window.localStorage.getItem(key);
  if (!raw?.trim()) return structuredClone(fallback);
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function readRevision() {
  const value = Number(window.localStorage.getItem(revisionKey));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function restore(key: string, value: string | null) {
  if (value == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
}
