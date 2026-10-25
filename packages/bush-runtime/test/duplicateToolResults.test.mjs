import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { png } from "./helpers/modelImages.mjs";

import {
  ToolRegistry,
  registerExtendedBuiltins,
} from "../dist/index.js";

test("inject_image_input keeps duplicate call metadata out of its receipt", async (t) => {
  const root = await temporaryRoot(t);
  const registry = new ToolRegistry();
  registerExtendedBuiltins(registry, { dataRoot: root });
  const tool = registry.resolve("inject_image_input");
  const input = tool.decodeInput({
    url: "data:image/png;base64," + png.toString("base64"),
    label: "already in arguments",
    caption: "already in arguments too",
    detail: "low",
  });
  const invocation = context(input, "inject_image_input");
  assert.equal((await tool.authorize(invocation)).kind, 'allow');
  const result = await tool.execute(invocation);

  assert.equal(result.queued, true);
  assert.equal("url" in result, false);
  assert.equal("label" in result, false);
  assert.equal("caption" in result, false);
  assert.equal(result.artifacts[0].uri, input.url);
});

function childRegistration(name) {
  return {
    definition: {
      name,
      description: "fixture",
      inputSchema: { type: "object", additionalProperties: false },
    },
    manifest: manifest(`fixture.${name}`),
    parallelSafe: true,
    decodeInput: (input) => input,
    execute: (childContext) => ({ observed: childContext.input.value }),
  };
}

function context(input, name) {
  return {
    requestId: "request",
    sessionId: "session",
    turnId: "turn",
    toolCall: {
      protocol: "bush.tool_call.v1",
      id: `call_${name}`,
      name,
      argumentsText: JSON.stringify(input),
    },
    input,
    actionManifest: manifest(`fixture.${name}`),
    capabilityIds: [],
    recordWorkspaceChange() {},
  };
}

function manifest(operation) {
  return {
    protocol: "bush.tool.action_manifest.v1",
    manifest_id: `manifest_${operation}`,
    effect_kind: "observation",
    operation,
    risk: "low",
    owner: "test",
    dispatch_scope: "runtime",
    mutating: false,
  };
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "cardbush-duplicate-tool-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
