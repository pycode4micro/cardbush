import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_RUNTIME_EVENT_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
} from "@cardbush/bush-protocol";
import {
  ElectronRuntimeTransport,
  RuntimeRemoteError,
} from "../dist/index.js";

test("delivers typed command responses", async () => {
  const bridge = fakeBridge();
  bridge.command = async (request) => ({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: "command_response",
    operationId: request.operationId,
    ok: true,
    result: { value: 1 },
  });
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "operation_1",
  });

  assert.deepEqual(
    await transport.sendCommand({ kind: "runtime.test", payload: {} }),
    { value: 1 },
  );
});

test("streams events and closes only on an explicit end frame", async () => {
  const bridge = fakeBridge();
  const event = runtimeEvent();
  bridge.startStream = async (request) => {
    queueMicrotask(() => {
      bridge.emit({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: "stream_frame",
        subscriptionId: request.subscriptionId,
        frame: { kind: "event", event },
      });
      bridge.emit({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: "stream_frame",
        subscriptionId: request.subscriptionId,
        frame: { kind: "end" },
      });
    });
  };
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "subscription_1",
  });

  const received = [];
  for await (const value of transport.openEventStream({
    sessionId: "session_1",
    turnId: "turn_1",
  })) {
    received.push(value);
  }
  assert.deepEqual(received, [event]);
  assert.equal(bridge.stopCalls, 1);
});

test("turns an incompatible live host into a structured mismatch error", async () => {
  const bridge = fakeBridge();
  bridge.command = async () => ({
    protocol: "bush.runtime_ipc.v2",
    type: "command_response",
  });
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "operation_1",
  });

  await assert.rejects(
    () => transport.sendCommand({ kind: "runtime.test", payload: {} }),
    (error) =>
      error instanceof RuntimeRemoteError &&
      error.fact.code === "protocol_version_mismatch",
  );
});

test("surfaces an incompatible stream frame inside the AsyncIterable", async () => {
  const bridge = fakeBridge();
  bridge.startStream = async (request) => {
    queueMicrotask(() => {
      bridge.emit({
        protocol: "bush.runtime_ipc.v2",
        type: "stream_frame",
        subscriptionId: request.subscriptionId,
        frame: { kind: "end" },
      });
    });
  };
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "subscription_1",
  });

  await assert.rejects(
    async () => {
      for await (const _event of transport.openEventStream({
        sessionId: "session_1",
        turnId: "turn_1",
      })) {
        // No valid event is expected.
      }
    },
    (error) =>
      error instanceof RuntimeRemoteError &&
      error.fact.code === "protocol_version_mismatch",
  );
});

test("classifies bridge command rejection as a transport fact without reading prose", async () => {
  const bridge = fakeBridge();
  bridge.command = async () => { throw new Error("arbitrary localized text"); };
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "operation_transport",
  });

  await assert.rejects(
    () => transport.sendCommand({ kind: "runtime.test", payload: {} }),
    (error) =>
      error instanceof RuntimeRemoteError &&
      error.fact.kind === "transport" &&
      error.fact.code === "runtime_command_transport_failed" &&
      error.fact.retryable === true,
  );
});

test("classifies malformed same-version payload as a protocol fact", async () => {
  const bridge = fakeBridge();
  bridge.command = async () => ({
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: "unknown_response",
  });
  const transport = new ElectronRuntimeTransport(bridge, {
    createId: () => "operation_protocol",
  });

  await assert.rejects(
    () => transport.sendCommand({ kind: "runtime.test", payload: {} }),
    (error) =>
      error instanceof RuntimeRemoteError &&
      error.fact.kind === "protocol" &&
      error.fact.code === "invalid_runtime_ipc_message",
  );
});

test("abort-side IPC failures do not escape as unhandled rejections", async () => {
  const bridge = fakeBridge();
  const controller = new AbortController();
  let respond;
  bridge.command = request => new Promise(resolve => {
    respond = () => resolve({protocol:BUSH_RUNTIME_IPC_PROTOCOL,type:"command_response",
      operationId:request.operationId,ok:true,result:"settled"});
  });
  bridge.cancelOperation = async () => { throw new Error("host disposed during cancellation"); };
  bridge.stopStream = async () => { throw new Error("host disposed during stream cleanup"); };
  const transport = new ElectronRuntimeTransport(bridge);
  const command = transport.sendCommand({kind:"runtime.test",payload:{}},controller.signal);
  const iterator = transport.openEventStream({sessionId:"session_1",turnId:"turn_1",signal:controller.signal});
  const next = iterator.next();
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  respond();
  assert.equal(await command,"settled","authoritative command settlement is preserved");
  assert.equal((await next).done,true);
  // Node's test runner fails on any unhandled rejection from the abort listener.
  await new Promise(resolve=>setImmediate(resolve));
});

function fakeBridge() {
  const listeners = new Set();
  const bridge = {
    command: async () => undefined,
    startStream: async () => undefined,
    stopStream: async () => {
      bridge.stopCalls += 1;
    },
    cancelOperation: async () => undefined,
    onStreamFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of listeners) listener(message);
    },
    stopCalls: 0,
  };
  return bridge;
}

function runtimeEvent() {
  return {
    protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
    eventId: "event_1",
    sequence: 1,
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: "2026-08-29T00:00:00.000Z",
    kind: "turn_accepted",
    payload: { status: "accepted" },
  };
}
