import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MCP_SNAPSHOT_PROTOCOL,
} from "@cardbush/bush-protocol";
import {
  ToolExecutionCoordinator,
  ToolRegistry,
} from "@cardbush/bush-runtime";

import { McpClientManager } from "../dist/index.js";

test("applies an MCP 2.x snapshot and executes a namespaced Tool", async () => {
  const registry = new ToolRegistry();
  const fake = fakeClient({ content: [{ type: "text", text: "pong" }] });
  const manager = new McpClientManager({
    registry,
    createClient: () => fake,
    createTransport: () => ({}),
    createReceiptId: () => "receipt_mcp",
  });

  const applied = await manager.apply(snapshot({ permission: "allow" }));
  assert.equal(applied.servers[0].negotiatedProtocolVersion, "2026-07-28");
  assert.deepEqual(applied.servers[0].tools, [{
    remoteName: "echo.tool",
    runtimeName: "mcp__server__echo_tool",
  }]);
  assert.ok(registry.resolve("mcp__server__echo_tool"));

  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });
  const outcome = await coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id: "call_1",
      name: "mcp__server__echo_tool",
      argumentsText: JSON.stringify({ value: "ping" }),
    },
    {
      requestId: "request",
      sessionId: "session",
      turnId: "turn",
      round: 1,
      ordinal: 0,
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(outcome.result.output.content, [{ type: "text", text: "pong" }]);
  assert.deepEqual(fake.calls, [{ name: "echo.tool", arguments: { value: "ping" } }]);
});

test("binds default MCP permission to one exact server Tool resource", async () => {
  const registry = new ToolRegistry();
  const fake = fakeClient({ content: [] });
  const manager = new McpClientManager({
    registry,
    createClient: () => fake,
    createTransport: () => ({}),
  });
  await manager.apply(snapshot());
  let requested;
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: {
      async request(input) {
        requested = input;
        return {
          protocol: "bush.runtime_permission_answer.v1",
          permissionId: "permission",
          answerId: "answer",
          decision: "allow_once",
          grantedCapabilityIds: input.capabilityIds,
        };
      },
    },
  });
  const outcome = await coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id: "call_2",
      name: "mcp__server__echo_tool",
      argumentsText: "{}",
    },
    {
      requestId: "request",
      sessionId: "session",
      turnId: "turn",
      round: 1,
      ordinal: 0,
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(requested.actions, ["external_tool_call"]);
  assert.deepEqual(requested.resources, ["mcp://server/tools/echo.tool"]);
  assert.equal(requested.capabilityIds.length, 1);
});

test("rejects snapshot mutation during a Turn and conflicting revision reuse", async () => {
  const registry = new ToolRegistry();
  let canApply = true;
  const manager = new McpClientManager({
    registry,
    canApply: () => canApply,
    createClient: () => fakeClient({ content: [] }),
    createTransport: () => ({}),
  });
  await manager.apply(snapshot());

  canApply = false;
  await assert.rejects(
    manager.apply({ ...snapshot(), revision: 2 }),
    /while a Runtime Turn is active/,
  );
  assert.ok(registry.resolve("mcp__server__echo_tool"));

  canApply = true;
  const changed = snapshot();
  changed.servers[0].exposeTools = [];
  await assert.rejects(manager.apply(changed), /reused with different content/);
  assert.ok(registry.resolve("mcp__server__echo_tool"));
});

function snapshot(policy) {
  return {
    protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
    snapshotId: "snapshot",
    revision: 1,
    servers: [{
      id: "server",
      transport: {
        kind: "streamable_http",
        url: "http://127.0.0.1:3000/mcp",
        headers: {},
      },
      versionMode: "auto",
      defaultToolPolicy: {
        permission: policy?.permission ?? "ask",
        parallelSafe: false,
        visibleToChild: true,
      },
      toolPolicies: {},
    }],
  };
}

function fakeClient(result) {
  return {
    calls: [],
    async connect() {},
    async close() {},
    async listTools() {
      return {
        tools: [{
          name: "echo.tool",
          description: "Echo a value",
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
          },
        }],
      };
    },
    async callTool(input) {
      this.calls.push(input);
      return result;
    },
    getNegotiatedProtocolVersion() {
      return "2026-07-28";
    },
  };
}
