import { z } from "zod";

import {
  GET_RUNTIME_CAPABILITIES_COMMAND,
  runtimeCapabilitiesSchema,
  runtimeEventSchema,
} from "./runtimeHost.js";

export const BUSH_RUNTIME_FIXTURE_PROTOCOL = "bush.runtime_fixture.v1" as const;

const runtimeFixtureFrameSchema = z.object({
  event: runtimeEventSchema,
  delayMs: z.number().int().nonnegative().optional(),
});

export const runtimeFixtureSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_FIXTURE_PROTOCOL),
  name: z.string().min(1),
  events: z.array(runtimeFixtureFrameSchema).min(1),
  commandResponses: z.object({
    [GET_RUNTIME_CAPABILITIES_COMMAND]: runtimeCapabilitiesSchema,
  }),
});

export type RuntimeFixture = z.infer<typeof runtimeFixtureSchema>;

export function decodeRuntimeFixture(input: unknown): RuntimeFixture {
  return runtimeFixtureSchema.parse(input);
}
