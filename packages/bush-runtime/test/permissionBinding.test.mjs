import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import {
  InMemoryRuntimeCapabilityStore, ToolExecutionCoordinator, ToolRegistry,
  registerWorkspaceTools,
} from "../dist/index.js";

const identity = { requestId: "r", sessionId: "s", turnId: "t", round: 1, ordinal: 0 };
const call = (id, name, input = {}) => ({
  protocol: "bush.tool_call.v1", id, name, argumentsText: JSON.stringify(input),
});
const answer = (request, decision) => ({
  protocol: "bush.runtime_permission_answer.v1", permissionId: "p", answerId: "a",
  decision, grantedCapabilityIds: decision === "deny" ? [] : request.capabilityIds,
});

test('retired pre-approval is unavailable and cannot create permission grants', async () => {
  const registry = new ToolRegistry();
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: {} };
  assert.ok(!request.tools.some(tool => tool.name === 'request_permission'));
  assert.ok(!modelToolDefinitions(registry, request).some(tool => tool.name === 'request_permission'));
  let prompts = 0;
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { prompts++; throw new Error('Unexpected prompt'); } } });
  const result = await coordinator.execute(call('old-preapproval', 'request_permission', { path: 'C:/fixture/report.txt', access_kind: 'write', reason: 'Legacy request' }), identity);
  assert.equal(result.kind, 'failed'); assert.equal(result.execution.dispatch, 'not_started'); assert.equal(prompts, 0);
});

test("a model-supplied capability cannot authorize a different displayed file", async () => {
  const registry = new ToolRegistry();

  registerWorkspaceTools(registry);
  const actual = realpathSync(fileURLToPath(import.meta.url));
  const capability = `capability:read:${createHash("sha256")
    .update(process.platform === "win32" ? actual.toLowerCase() : actual).digest("hex")}`;
  const prompts = [];
  const coordinator = new ToolExecutionCoordinator({
    registry, capabilities: new InMemoryRuntimeCapabilityStore(),
    permissions: { request: async (request) => {
      prompts.push(request);
      return answer(request, "deny");
    } },
  });
  const grant = await coordinator.execute(call("grant", "request_permission", {
    path: "C:/public/report.txt", access_kind: "read", reason: "Read public report",
    capability_ids: [capability],
  }), identity);
  assert.equal(grant.kind, "failed");
  assert.equal(grant.execution.dispatch, "not_started");
  assert.equal(prompts.length, 0, 'a removed tool cannot request or grant permission');
  const read = await coordinator.execute(call("read", "read_file", { path: actual }), identity);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].targets[0].value, actual);
  assert.equal(read.kind, "failed");
  assert.equal(read.error.code, "permission_rejected");
});

test("session grants bind actions and target kind/value without changing native capabilities", async () => {
  const registry = new ToolRegistry();
  const native = { content: [{ type: "text", text: "tool-owned result" }], isError: true };
  registry.register({
    definition: { name: "external", description: "test", inputSchema: { type: "object" } },
    manifest: { effect_kind: "observation", operation: "external.call", risk: "read_only",
      owner: "test", dispatch_scope: "session", mutating: false },
    decodeInput: (input) => input,
    authorize: ({ input }) => ({ kind: "ask", request: {
      reason: "test", actions: input.actions ?? ["read"],
      targets: [{ kind: input.kind ?? "mcp_resource", value: input.target ?? "mcp://server/tool" }],
      capabilityIds: ["native-capability"],
    } }),
    execute: ({ capabilityIds }) => {
      assert.deepEqual(capabilityIds, ["native-capability"]);
      return native;
    },
  });
  const capabilities = new InMemoryRuntimeCapabilityStore();
  let prompts = 0;
  const make = (capabilitySessionId) => new ToolExecutionCoordinator({
    registry, capabilities, capabilitySessionId,
    permissions: { request: async (request) => { prompts++; return answer(request, "allow_session"); } },
  });
  const parent = make("parent");
  assert.deepEqual((await parent.execute(call("a", "external"), identity)).result, native);
  await parent.execute(call("b", "external"), identity);
  assert.equal(prompts, 1);
  await make("parent").execute(call("child", "external"), { ...identity, sessionId: "child" });
  assert.equal(prompts, 1, "explicitly inherited child grants retain their scope");
  await parent.execute(call("write", "external", { actions: ["write"] }), identity);
  await parent.execute(call("other", "external", { target: "mcp://server/other" }), identity);
  await parent.execute(call("opaque", "external", { kind: "opaque" }), identity);
  await make("another-session").execute(call("another", "external"), identity);
  assert.equal(prompts, 5);
});
