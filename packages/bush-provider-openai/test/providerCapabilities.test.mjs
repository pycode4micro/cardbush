import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FileProviderCapabilityStore,
  InMemoryProviderCapabilityStore,
  openAIResponsesCapabilityScope,
} from "../dist/index.js";

const identity = {
  scope: "scope_1",
  model: "model_1",
  capability: "response_continuation",
};

test("tracks unknown, supported and expired provider capabilities", () => {
  let now = Date.parse("2026-08-31T00:00:00.000Z");
  const store = new InMemoryProviderCapabilityStore({
    ttlMs: 1_000,
    now: () => now,
  });
  assert.equal(store.read(identity).status, "unknown");

  store.observe(identity, { status: "supported", reason: "response_stored" });
  assert.equal(store.read(identity).status, "supported");
  assert.equal(store.read({ ...identity, model: "model_2" }).status, "unknown");

  now += 1_001;
  assert.equal(store.read(identity).status, "unknown");
});

test("persists observations and scopes them to endpoint configuration and model", (context) => {
  const root = mkdtempSync(join(tmpdir(), "cardbush-provider-capabilities-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "capabilities.json");
  const first = new FileProviderCapabilityStore(path);
  first.observe(identity, { status: "unsupported", reason: "unsupported_parameter" });

  const restarted = new FileProviderCapabilityStore(path);
  assert.equal(restarted.read(identity).status, "unsupported");
  assert.equal(restarted.read({ ...identity, scope: "scope_2" }).status, "unknown");
  assert.equal(restarted.read({ ...identity, model: "model_2" }).status, "unknown");
});

test("derives opaque capability scopes without exposing credentials", () => {
  const first = openAIResponsesCapabilityScope({
    apiKey: "secret-one",
    baseURL: "https://provider.invalid/v1",
  });
  const same = openAIResponsesCapabilityScope({
    apiKey: "secret-one",
    baseURL: "https://provider.invalid/v1",
  });
  const changedEndpoint = openAIResponsesCapabilityScope({
    apiKey: "secret-one",
    baseURL: "https://other.invalid/v1",
  });
  const changedCredential = openAIResponsesCapabilityScope({
    apiKey: "secret-two",
    baseURL: "https://provider.invalid/v1",
  });

  assert.equal(first, same);
  assert.notEqual(first, changedEndpoint);
  assert.notEqual(first, changedCredential);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes("secret-one"), false);
});
