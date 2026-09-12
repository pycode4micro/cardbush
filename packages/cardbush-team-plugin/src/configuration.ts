import { z } from 'zod';

export const TEAM_CONFIGURATION_FILE_PROTOCOL = 'cardbush.team_configuration.v1' as const;
const id = z.string().trim().min(1).max(120);
const strings = z.array(z.string().trim().min(1));
export const agentProfileDefinitionSchema = z.object({
  protocol: z.literal('bush.agent_profile.v1'), id, name: id,
  description: z.string().default(''), disabledTools: strings.default([]),
  skills: strings.optional(), hooks: strings.default([]), guards: strings.default([]),
  prompts: z.object({ instructions: z.string() }).strict(),
}).strict();
export const teamDefinitionSchema = z.object({
  protocol: z.literal('bush.team.v1'), id, name: id, description: z.string().default(''),
  members: z.array(z.object({ id, agentProfileId: id, responsibility: z.string().default(''), fallback: z.boolean().default(false) }).strict()).min(1),
}).strict();
export const teamConfigurationSchema = z.object({
  protocol: z.literal(TEAM_CONFIGURATION_FILE_PROTOCOL),
  teams: z.array(teamDefinitionSchema), profiles: z.array(agentProfileDefinitionSchema),
}).strict().superRefine((configuration, context) => {
  const profiles = new Set<string>();
  configuration.profiles.forEach((profile, index) => {
    if (profiles.has(profile.id)) context.addIssue({ code: 'custom', path: ['profiles', index, 'id'], message: 'Duplicate Agent Profile id.' });
    profiles.add(profile.id);
  });
  const teams = new Set<string>();
  configuration.teams.forEach((team, index) => {
    if (teams.has(team.id)) context.addIssue({ code: 'custom', path: ['teams', index, 'id'], message: 'Duplicate Team id.' });
    teams.add(team.id);
    const members = new Set<string>();
    team.members.forEach((member, memberIndex) => {
      const path = ['teams', index, 'members', memberIndex];
      if (members.has(member.id)) context.addIssue({ code: 'custom', path, message: 'Duplicate Team member id.' });
      if (!profiles.has(member.agentProfileId)) context.addIssue({ code: 'custom', path, message: `Missing Agent Profile ${member.agentProfileId}.` });
      members.add(member.id);
    });
  });
});

export type TeamFileConfiguration = z.infer<typeof teamConfigurationSchema>;
export interface TeamConfigurationReceipt { path: string; contentHash: string; configuration: TeamFileConfiguration }

export function defaultTeamConfiguration(): TeamFileConfiguration {
  return { protocol: TEAM_CONFIGURATION_FILE_PROTOCOL,
    teams: [{ protocol: 'bush.team.v1', id: 'general', name: 'General Team', description: 'General collaborators.',
      members: [{ id: 'general', agentProfileId: 'general', responsibility: 'Handle general delegated work.', fallback: true }] }],
    profiles: [{ protocol: 'bush.agent_profile.v1', id: 'general', name: 'General Agent',
      description: 'General-purpose collaborator for delegated work.', disabledTools: [], hooks: [], guards: [],
      prompts: { instructions: 'Handle the delegated task carefully and return concrete evidence to the parent Agent.' } }],
  };
}
