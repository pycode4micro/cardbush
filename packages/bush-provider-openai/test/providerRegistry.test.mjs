import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
} from "@cardbush/bush-protocol";
import { OpenAICompatibleProviderRegistry } from "../dist/index.js";

test("keeps provider secrets outside the returned binding reference", () => {
  const created = [];
  const registry = new OpenAICompatibleProviderRegistry({
    createRevision: () => "revision_1",
    createProvider: (config) => {
      created.push(config);
      return provider("configured");
    },
  });

  const result = registry.upsert(bindingConfig("secret-value"));

  assert.deepEqual(result, {
    protocol: "bush.provider_binding_result.v1",
    status: "configured",
    binding: { bindingId: "model_config_1", revision: "revision_1" },
  });
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(created[0].apiKey, "secret-value");
});

test("retains immutable revisions for concurrent Turns", async () => {
  let revision = 0;
  const registry = new OpenAICompatibleProviderRegistry({
    createRevision: () => `revision_${++revision}`,
    createProvider: (config) => provider(config.apiKey),
  });
  const first = registry.upsert(bindingConfig("first"));
  const second = registry.upsert(bindingConfig("second"));

  const firstEvents = await collect(
    registry.stream(request(first.binding)),
  );
  const secondEvents = await collect(
    registry.stream(request(second.binding)),
  );

  assert.equal(firstEvents[1].delta, "first");
  assert.equal(secondEvents[1].delta, "second");
});

test("recreates the same opaque revision after restart for the same exact config", () => {
  const first = new OpenAICompatibleProviderRegistry({
    createProvider: () => provider("first"),
  }).upsert(bindingConfig("same-secret"));
  const restarted = new OpenAICompatibleProviderRegistry({
    createProvider: () => provider("second"),
  }).upsert(bindingConfig("same-secret"));
  const changed = new OpenAICompatibleProviderRegistry({
    createProvider: () => provider("third"),
  }).upsert(bindingConfig("changed-secret"));

  assert.equal(first.binding.revision, restarted.binding.revision);
  assert.notEqual(first.binding.revision, changed.binding.revision);
  assert.match(first.binding.revision, /^sha256:[a-f0-9]{64}$/);
});

test("returns factual failures for missing bindings and removes all revisions", async () => {
  const registry = new OpenAICompatibleProviderRegistry({
    createRevision: () => "revision_1",
    createProvider: () => provider("configured"),
  });
  const configured = registry.upsert(bindingConfig("secret"));
  assert.equal(registry.remove({ bindingId: "model_config_1" }).status, "removed");

  const missing = await collect(registry.stream(request(configured.binding)));
  const unconfigured = await collect(registry.stream(request(undefined)));

  assert.equal(missing[0].code, "runtime_provider_binding_not_found");
  assert.equal(unconfigured[0].code, "runtime_provider_not_configured");
});

function bindingConfig(apiKey) {
  return {
    protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
    bindingId: "model_config_1",
    adapter: "openai_compatible",
    apiKey,
    baseURL: "https://provider.invalid/v1",
  };
}

function request(providerBinding) {
  return {
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: `request_${providerBinding?.revision ?? "none"}`,
    sessionId: "session_provider_registry",
    turnId: `turn_${providerBinding?.revision ?? "none"}`,
    model: "fixture-model",
    providerBinding,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };
}

function provider(text) {
  return {
    async *stream(modelRequest) {
      yield {
        protocol: BUSH_MODEL_EVENT_PROTOCOL,
        requestId: modelRequest.requestId,
        sequence: 0,
        createdAt: "2026-08-29T00:00:00.000Z",
        kind: "response_started",
      };
      yield {
        protocol: BUSH_MODEL_EVENT_PROTOCOL,
        requestId: modelRequest.requestId,
        sequence: 1,
        createdAt: "2026-08-29T00:00:00.000Z",
        kind: "text_delta",
        delta: text,
      };
      yield {
        protocol: BUSH_MODEL_EVENT_PROTOCOL,
        requestId: modelRequest.requestId,
        sequence: 2,
        createdAt: "2026-08-29T00:00:00.000Z",
        kind: "response_completed",
        finishReason: "stop",
      };
    },
  };
}

async function collect(events) {
  const values = [];
  for await (const event of events) values.push(event);
  return values;
}
