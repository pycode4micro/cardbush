import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
        metadata: {
          mcpContext: {
            filesystemRoots: ["C:\\workspace"],
            transportChannel: "external",
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
  assert.equal(fake.calls[0]._meta.transport_channel, "external");
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

test("normalizes a standard successful MCP response without a private Runtime envelope", async () => {
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
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.output.content[0].text, "untrusted");
  assert.equal(outcome.result.facts[0].verification_state, "attempted");
});

test("preserves the actionable MCP error text for Runtime and product UI", async () => {
  const registry = new ToolRegistry();
  const manager = new McpClientManager({
    registry,
    createClient: () => fakeClient({
      content: [{
        type: "text",
        text: "Could not connect to Chrome. Enable remote debugging first.",
      }],
      isError: true,
    }),
    createTransport: () => ({}),
  });
  await manager.apply(snapshot({ permission: "allow" }));
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });
  const outcome = await executeEcho(coordinator, "call_actionable_error");
  assert.equal(outcome.kind, "failed");
  assert.equal(
    outcome.result.error.message,
    "Could not connect to Chrome. Enable remote debugging first.",
  );
  assert.equal(outcome.result.error.details.resource, "mcp://server/tools/echo.tool");
  await manager.close();
});

test("leaves request timeout ownership to MCP and keeps the connection active", async () => {
  const registry = new ToolRegistry();
  const timeout = Object.assign(new Error("Request timed out"), {
    code: "REQUEST_TIMEOUT",
  });
  let attempt = 0;
  const client = fakeClient((input) => {
    attempt += 1;
    if (attempt === 1) throw timeout;
    return successfulToolResult(input);
  });
  const manager = new McpClientManager({
    registry,
    createClient: () => client,
    createTransport: () => ({}),
  });
  await manager.apply(snapshot({ permission: "allow" }));
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });

  assert.equal((await executeEcho(coordinator, "call_timeout")).kind, "failed");
  assert.equal(manager.snapshot().servers[0].health, "ready");
  assert.equal(client.closeCalls, 0);
  assert.equal("timeout" in client.callOptions[0], false);
  assert.equal("maxTotalTimeout" in client.callOptions[0], false);
  assert.equal((await executeEcho(coordinator, "call_after_timeout")).kind, "completed");
  assert.equal(client.calls.length, 2);
  await manager.close();
});

test("restarts only after the MCP connection actually closes", async () => {
  const registry = new ToolRegistry();
  const states = [];
  const disconnected = fakeClient(successfulToolResult);
  const recovered = fakeClient(successfulToolResult);
  const clients = [disconnected, recovered];
  const manager = new McpClientManager({
    registry,
    createClient: () => clients.shift(),
    createTransport: () => ({}),
    wait: async () => undefined,
    onServiceStateChange: (state) => states.push(state),
  });
  await manager.apply(snapshot({ permission: "allow" }));

  disconnected.onclose();
  await waitFor(() => manager.snapshot().servers[0].health === "ready");

  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });
  assert.equal((await executeEcho(coordinator, "call_after_reconnect")).kind, "completed");
  assert.equal(recovered.calls.length, 1);
  assert.ok(states.some((state) => state.health === "restarting"));
  assert.equal(states.at(-1).health, "ready");
  await manager.close();
});

test("does not restart an MCP service when user cancellation is surfaced as an SDK timeout", async () => {
  const registry = new ToolRegistry();
  const controller = new AbortController();
  const timeout = Object.assign(new Error("Request aborted by timeout machinery"), {
    code: "REQUEST_TIMEOUT",
  });
  const client = fakeClient(() => {
    controller.abort("user_stop");
    throw timeout;
  });
  const manager = new McpClientManager({
    registry,
    createClient: () => client,
    createTransport: () => ({}),
  });
  await manager.apply(snapshot({ permission: "allow" }));
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("permission was not expected"); } },
  });

  const outcome = await executeEcho(coordinator, "call_user_stop", controller.signal);
  assert.equal(outcome.kind, "cancelled");
  assert.equal(manager.snapshot().servers[0].health, "ready");
  assert.equal(client.closeCalls, 0);
  await manager.close();
});

test("drains stdio stderr so MCP diagnostics cannot backpressure the child process", async () => {
  const registry = new ToolRegistry();
  const stderr = new PassThrough();
  const diagnostics = [];
  const manager = new McpClientManager({
    registry,
    createClient: () => fakeClient(successfulToolResult),
    createTransport: () => ({ stderr, async close() {} }),
    onServerStderr: (entry) => diagnostics.push(entry),
  });

  await manager.apply(snapshot({ permission: "allow" }));
  stderr.write("chrome devtools diagnostic\n");
  await waitFor(() => diagnostics.length === 1);
  assert.deepEqual(diagnostics[0], {
    serverId: "server",
    message: "chrome devtools diagnostic",
  });
  await manager.close();
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

test("synthesizes a conservative Action Manifest for a standard MCP Tool", async () => {
  const registry = new ToolRegistry();
  const manager = new McpClientManager({
    registry,
    createClient: () => fakeClient({ content: [] }, { includeManifest: false }),
    createTransport: () => ({}),
  });
  await manager.apply(snapshot());
  const registered = registry.resolve("mcp__server__echo_tool");
  assert.ok(registered);
  assert.equal(registered.manifest.effect_kind, "external_mcp");
  assert.equal(registered.manifest.dispatch_mutating, true);
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
    callOptions: [],
    closeCalls: 0,
    async connect() {
      return options.connect?.();
    },
    async close() {
      this.closeCalls += 1;
      return options.close?.();
    },
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
    async callTool(input, callOptions) {
      this.calls.push(input);
      this.callOptions.push(callOptions);
      return typeof result === "function" ? result(input) : result;
    },
    getNegotiatedProtocolVersion() {
      return "2026-07-28";
    },
  };
}

function executeEcho(coordinator, id, signal) {
  return coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id,
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
    signal,
  );
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for MCP service state.");
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
