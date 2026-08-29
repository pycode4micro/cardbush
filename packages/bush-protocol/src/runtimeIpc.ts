import { z } from "zod";

import {
  runtimeCapabilitiesSchema,
  runtimeEventCursorSchema,
  runtimeEventSchema,
} from "./runtimeHost.js";

export const BUSH_RUNTIME_IPC_PROTOCOL = "bush.runtime_ipc.v1" as const;
export const BUSH_RUNTIME_ERROR_PROTOCOL = "bush.runtime_error.v1" as const;

export const RUNTIME_IPC_COMMAND_CHANNEL = "bush-runtime:command" as const;
export const RUNTIME_IPC_START_STREAM_CHANNEL =
  "bush-runtime:start-stream" as const;
export const RUNTIME_IPC_STOP_STREAM_CHANNEL =
  "bush-runtime:stop-stream" as const;
export const RUNTIME_IPC_CANCEL_OPERATION_CHANNEL =
  "bush-runtime:cancel-operation" as const;
export const RUNTIME_IPC_STREAM_FRAME_CHANNEL =
  "bush-runtime:stream-frame" as const;

export const runtimeProtocolErrorSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_ERROR_PROTOCOL),
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).default({}),
  requestId: z.string().min(1).optional(),
});

export type RuntimeProtocolError = z.infer<typeof runtimeProtocolErrorSchema>;

export function createProtocolVersionMismatchError(
  received: unknown,
  expected: string = BUSH_RUNTIME_IPC_PROTOCOL,
  requestId?: string,
): RuntimeProtocolError {
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    code: "protocol_version_mismatch",
    message: `Runtime protocol ${String(received)} is not supported.`,
    retryable: false,
    details: { expected, received },
    requestId,
  };
}

const runtimeIpcBaseSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_IPC_PROTOCOL),
});

export const runtimeIpcCommandSchema = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});

export const runtimeIpcInboundMessageSchema = z.discriminatedUnion("type", [
  runtimeIpcBaseSchema.extend({
    type: z.literal("command"),
    operationId: z.string().min(1),
    command: runtimeIpcCommandSchema,
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("cancel_operation"),
    operationId: z.string().min(1),
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("start_stream"),
    subscriptionId: z.string().min(1),
    request: z.object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      cursor: runtimeEventCursorSchema.optional(),
    }),
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("stop_stream"),
    subscriptionId: z.string().min(1),
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("host_tool_response"),
    requestId: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: runtimeProtocolErrorSchema.optional(),
  }).superRefine((value, context) => {
    if (!value.ok && !value.error) {
      context.addIssue({ code: "custom", message: "failed host tool response requires error" });
    }
  }),
]);

export type RuntimeIpcInboundMessage = z.infer<
  typeof runtimeIpcInboundMessageSchema
>;

const runtimeIpcStreamFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), event: runtimeEventSchema }),
  z.object({ kind: z.literal("end") }),
  z.object({ kind: z.literal("error"), error: runtimeProtocolErrorSchema }),
]);

export type RuntimeIpcStreamFrame = z.infer<typeof runtimeIpcStreamFrameSchema>;

const runtimeIpcCommandResponseSchema = z.discriminatedUnion("ok", [
  runtimeIpcBaseSchema.extend({
    type: z.literal("command_response"),
    operationId: z.string().min(1),
    ok: z.literal(true),
    result: z.unknown(),
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("command_response"),
    operationId: z.string().min(1),
    ok: z.literal(false),
    error: runtimeProtocolErrorSchema,
  }),
]);

export const runtimeIpcOutboundMessageSchema = z.union([
  runtimeIpcBaseSchema.extend({
    type: z.literal("ready"),
    capabilities: runtimeCapabilitiesSchema,
  }),
  runtimeIpcCommandResponseSchema,
  runtimeIpcBaseSchema.extend({
    type: z.literal("stream_frame"),
    subscriptionId: z.string().min(1),
    frame: runtimeIpcStreamFrameSchema,
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("protocol_error"),
    error: runtimeProtocolErrorSchema,
  }),
  runtimeIpcBaseSchema.extend({
    type: z.literal("host_tool_request"),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
    context: z.object({
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      toolCallId: z.string().min(1),
      capabilityIds: z.array(z.string()),
    }),
  }),
]);

export type RuntimeIpcOutboundMessage = z.infer<
  typeof runtimeIpcOutboundMessageSchema
>;

export function decodeRuntimeIpcInboundMessage(
  input: unknown,
): RuntimeIpcInboundMessage {
  return runtimeIpcInboundMessageSchema.parse(input);
}

export function decodeRuntimeIpcOutboundMessage(
  input: unknown,
): RuntimeIpcOutboundMessage {
  return runtimeIpcOutboundMessageSchema.parse(input);
}

export function extractRuntimeIpcProtocol(input: unknown): unknown {
  return input && typeof input === "object"
    ? (input as Record<string, unknown>).protocol
    : undefined;
}
