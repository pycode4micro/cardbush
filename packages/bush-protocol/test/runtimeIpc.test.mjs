import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_RUNTIME_IPC_PROTOCOL,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcInboundMessage,
  decodeRuntimeIpcOutboundMessage,
} from "../dist/index.js";

test("decodes typed command and stream IPC messages", () => {
  const command = decodeRuntimeIpcInboundMessage({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: "command",
    operationId: "operation_1",
    command: { kind: "runtime.get_capabilities", payload: {} },
  });
  assert.equal(command.type, "command");

  const frame = decodeRuntimeIpcOutboundMessage({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: "stream_frame",
    subscriptionId: "subscription_1",
    frame: { kind: "end" },
  });
  assert.equal(frame.type, "stream_frame");
});

test("exposes protocol mismatch as a stable structured error", () => {
  const error = createProtocolVersionMismatchError(
    "bush.runtime_ipc.v2",
    BUSH_RUNTIME_IPC_PROTOCOL,
    "operation_1",
  );
  assert.equal(error.kind, "protocol");
  assert.equal(error.code, "protocol_version_mismatch");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.details, {
    expected: BUSH_RUNTIME_IPC_PROTOCOL,
    received: "bush.runtime_ipc.v2",
  });
  assert.throws(() =>
    decodeRuntimeIpcInboundMessage({
      protocol: "bush.runtime_ipc.v2",
      type: "cancel_operation",
      operationId: "operation_1",
    }),
  );
  assert.throws(() =>
    decodeRuntimeIpcOutboundMessage({
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: "protocol_error",
      error: {
        protocol: "bush.runtime_error.v1",
        code: "missing_kind",
        message: "invalid",
        retryable: false,
        details: {},
      },
    }),
  );
});
