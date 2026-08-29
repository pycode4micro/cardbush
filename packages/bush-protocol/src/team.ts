import { z } from "zod";

export const BUSH_TEAM_SNAPSHOT_PROTOCOL = "bush.team_snapshot.v1" as const;
export const BUSH_TEAM_SNAPSHOT_RESULT_PROTOCOL = "bush.team_snapshot_result.v1" as const;
export const APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND = "runtime.apply_team_snapshot" as const;
export const GET_RUNTIME_TEAM_SNAPSHOT_COMMAND = "runtime.get_team_snapshot" as const;

export const teamMemberSchema = z.object({
  memberId: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  instructions: z.string().default(""),
  toolNames: z.array(z.string().min(1)).default([]),
  agentProfileId: z.string().min(1),
  fallback: z.boolean(),
  skills: z.array(z.string().min(1)).optional(),
  hooks: z.array(z.string().min(1)).default([]),
  guards: z.array(z.string().min(1)).default([]),
  promptInstructions: z.string().default(""),
});

export const teamDefinitionSchema = z.object({
  teamId: z.string().min(1),
  name: z.string().min(1),
  instructions: z.string().default(""),
  members: z.array(teamMemberSchema).min(1),
}).superRefine((team, context) => {
  if (team.members.filter((member) => member.fallback).length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["members"],
      message: "Each Team must contain exactly one fallback member.",
    });
  }
  const memberIds = new Set<string>();
  for (const [index, member] of team.members.entries()) {
    if (memberIds.has(member.memberId)) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "memberId"],
        message: `Duplicate Team member ${member.memberId}.`,
      });
    }
    memberIds.add(member.memberId);
    if (new Set(member.toolNames).size !== member.toolNames.length) {
      context.addIssue({
        code: "custom",
        path: ["members", index, "toolNames"],
        message: `Team member ${member.memberId} contains duplicate Tool names.`,
      });
    }
  }
});

export const teamSnapshotSchema = z.object({
  protocol: z.literal(BUSH_TEAM_SNAPSHOT_PROTOCOL),
  snapshotId: z.string().min(1),
  revision: z.number().int().positive(),
  teams: z.array(teamDefinitionSchema),
}).superRefine((snapshot, context) => {
  const teamIds = new Set<string>();
  for (const [index, team] of snapshot.teams.entries()) {
    if (teamIds.has(team.teamId)) {
      context.addIssue({
        code: "custom",
        path: ["teams", index, "teamId"],
        message: `Duplicate Team ${team.teamId}.`,
      });
    }
    teamIds.add(team.teamId);
  }
});

export const teamSnapshotResultSchema = z.object({
  protocol: z.literal(BUSH_TEAM_SNAPSHOT_RESULT_PROTOCOL),
  snapshotId: z.string().min(1),
  revision: z.number().int().positive(),
  teamCount: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
});

export type TeamMember = z.infer<typeof teamMemberSchema>;
export type TeamDefinition = z.infer<typeof teamDefinitionSchema>;
export type TeamSnapshot = z.infer<typeof teamSnapshotSchema>;
export type TeamSnapshotResult = z.infer<typeof teamSnapshotResultSchema>;
