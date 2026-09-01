import { z } from "zod";

export const BUSH_SESSION_ENVIRONMENT_PROTOCOL =
  "bush.session_environment.v1" as const;

export const sessionEnvironmentFactSchema = z.object({
  protocol: z.literal(BUSH_SESSION_ENVIRONMENT_PROTOCOL),
  kind: z.enum(["snapshot", "update"]),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveAt: z.string().min(1),
});

export type SessionEnvironmentFact = z.infer<
  typeof sessionEnvironmentFactSchema
>;

export function encodeSessionEnvironmentFact(
  input: SessionEnvironmentFact,
): string {
  return JSON.stringify(sessionEnvironmentFactSchema.parse(input));
}

export function decodeSessionEnvironmentFact(
  input: string,
): SessionEnvironmentFact {
  return sessionEnvironmentFactSchema.parse(JSON.parse(input));
}
