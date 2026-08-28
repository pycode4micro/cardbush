import { z } from "zod";

export const BUSH_RUNTIME_EVENT_PROTOCOL = "bush.runtime_event.v1" as const;
export const BUSH_RUNTIME_CAPABILITIES_PROTOCOL =
  "bush.runtime_capabilities.v1" as const;
export const BUSH_RUNTIME_FIXTURE_PROTOCOL = "bush.runtime_fixture.v1" as const;
export const GET_RUNTIME_CAPABILITIES_COMMAND =
  "runtime.get_capabilities" as const;

export const runtimeEventKindSchema = z.enum([
  "turn_accepted",
  "turn_started",
  "reasoning_segment_started",
  "reasoning_segment_delta",
  "reasoning_segment_completed",
  "assistant_segment_started",
  "assistant_segment_delta",
  "assistant_segment_completed",
  "turn_terminal",
]);

export type RuntimeEventKind = z.infer<typeof runtimeEventKindSchema>;

const runtimeEventEnvelopeSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_EVENT_PROTOCOL),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  createdAt: z.string().min(1),
});

const segmentIdentitySchema = z.object({
  messageId: z.string().min(1),
  segmentId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
});

const segmentStartedPayloadSchema = segmentIdentitySchema;
const segmentDeltaPayloadSchema = segmentIdentitySchema.extend({
  delta: z.string(),
});
const segmentCompletedPayloadSchema = segmentIdentitySchema.extend({
  content: z.string(),
});

export const runtimeEventSchema = z.discriminatedUnion("kind", [
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_accepted"),
    payload: z.object({ status: z.literal("accepted") }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_started"),
    payload: z.object({ status: z.literal("running") }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_started"),
    payload: segmentStartedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_delta"),
    payload: segmentDeltaPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_completed"),
    payload: segmentCompletedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_started"),
    payload: segmentStartedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_delta"),
    payload: segmentDeltaPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_completed"),
    payload: segmentCompletedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_terminal"),
    payload: z.object({
      status: z.enum([
        "completed",
        "failed",
        "stopped",
        "awaiting_user_action",
      ]),
      reason: z.string().min(1),
      finalMessageId: z.string().min(1).optional(),
      details: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export function decodeRuntimeEvent(input: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(input);
}

export const runtimeCapabilitiesSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_CAPABILITIES_PROTOCOL),
  hostId: z.string().min(1),
  runtimeVersion: z.string().min(1),
  eventProtocol: z.literal(BUSH_RUNTIME_EVENT_PROTOCOL),
  supportedEvents: z.array(runtimeEventKindSchema),
  supportedCommands: z.array(z.string().min(1)),
  features: z.array(z.string().min(1)),
});

export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

export function decodeRuntimeCapabilities(input: unknown): RuntimeCapabilities {
  return runtimeCapabilitiesSchema.parse(input);
}

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
