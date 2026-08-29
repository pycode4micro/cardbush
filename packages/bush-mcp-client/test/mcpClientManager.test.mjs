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
  const fake = fakeClient(successfulToolResult);
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
    undefined,
    {
      request: {
        protocol: "bush.model_request.v1",
        requestId: "request",
        sessionId: "session",
        turnId: "turn",
        model: "fixture",
        messages: [],
        tools: [registry.resolve("mcp__server__echo_tool").definition],
        toolChoice: "auto",
        metadata: {
          mcpContext: {
            filesystemRoots: ["C:\\workspace"],
            transportChannel: "weixin",
          },
        },
      },
      contextMessages: [],
    },
  );
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(outcome.result.output.content, [{ type: "text", text: "pong" }]);
  assert.equal(fake.calls[0].name, "echo.tool");
  assert.deepEqual(fake.calls[0].arguments, { value: "ping" });
  assert.deepEqual(fake.calls[0]._meta.filesystem_roots, ["C:\\workspace"]);
  assert.equal(fake.calls[0]._meta.transport_channel, "weixin");
  assert.equal(fake.calls[0]._meta.runtime_tool_result_protocol, "bush.tool_result.v1");
  assert.equal(fake.calls[0]._meta.receipt_id, "receipt_mcp");
  assert.equal(fake.calls[0]._meta.action_manifest.protocol, "bush.tool.action_manifest.v1");
});

test("binds default MCP permission to one exact server Tool resource", async () => {
  const registry = new ToolRegistry();
  const fake = fakeClient(successfulToolResult);
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

test("rejects a successful MCP response that omits the Runtime Tool Result protocol", async () => {
  const registry = new ToolRegistry();
  const manager = new McpClientManager({
    registry,
    createClient: () => fakeClient({ content: [{ type: "text", text: "untrusted" }] }),
    createTransport: () => ({}),
    createReceiptId: () => "receipt_invalid",
  });
  await manager.apply(snapshot({ permission: "allow" }));
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });
  const outcome = await coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id: "call_invalid",
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
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.result.error.code, "mcp_tool_result_protocol_invalid");
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

test("rejects an MCP Tool that does not declare an Action Manifest", async () => {
  const registry = new ToolRegistry();
  const manager = new McpClientManager({
    registry,
    createClient: () => fakeClient({ content: [] }, { includeManifest: false }),
    createTransport: () => ({}),
  });
  await assert.rejects(manager.apply(snapshot()), /must provide a complete/);
  assert.equal(registry.resolve("mcp__server__echo_tool"), undefined);
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

function fakeClient(result, options = {}) {
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
          ...(options.includeManifest === false ? {} : {
            _meta: {
              "cardbush/action_manifest": {
                effect_kind: "fixture_effect",
                operation: "fixture.echo",
                risk: "low",
                owner: "fixture_mcp",
                dispatch_phase: "execution",
                dispatch_scope: "external_service",
                dispatch_side_effect: "fixture_effect",
                dispatch_mutating: true,
                dispatch_source: "mcp_tool_metadata",
                stage_modes: ["execute"],
                output_kinds: ["structured_data"],
                handoff_exports: [],
                evidence_hints: ["mcp_tool_result"],
              },
            },
          }),
        }],
      };
    },
    async callTool(input) {
      this.calls.push(input);
      return typeof result === "function" ? result(input) : result;
    },
    getNegotiatedProtocolVersion() {
      return "2026-07-28";
    },
  };
}

function successfulToolResult(input) {
  const manifest = input._meta.action_manifest;
  return {
    content: [{ type: "text", text: "pong" }],
    structuredContent: {
      protocol: "bush.tool_result.v1",
      tool_call_id: input._meta.tool_call_id,
      success: true,
      output: { content: [{ type: "text", text: "pong" }] },
      facts: [{
        protocol: "bush.tool.execution_fact.v1",
        receipt_id: input._meta.receipt_id,
        action_manifest_id: manifest.manifest_id,
        status: "succeeded",
        operation: manifest.operation,
        effect_kind: manifest.effect_kind,
        owner: manifest.owner,
        dispatch_scope: manifest.dispatch_scope,
        categories: ["mcp_tool_result"],
        paths: [],
        execution_success: true,
        semantic_success: true,
        verification_state: "verified",
        error_code: "",
      }],
      artifacts: [],
      workspace_changes: [],
      guidance: [],
    },
  };
}
