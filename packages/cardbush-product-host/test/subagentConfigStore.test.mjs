import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CARDBUSH_SUBAGENT_CONFIG_PROTOCOL,
  ProductSubagentConfigStore,
} from "../dist/index.js";

test("creates an explicit fail-closed Subagent baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-subagent-config-"));
  const path = join(root, "subagents.json");
  const config = await new ProductSubagentConfigStore(path).read();

  assert.equal(config.protocol, CARDBUSH_SUBAGENT_CONFIG_PROTOCOL);
  assert.equal(config.permissionRouting, "user");
  assert.deepEqual(config.model, { mode: "inherit" });
  assert.ok(config.disabledTools.includes("subagent"));
  assert.ok(config.disabledTools.includes("team_delegate"));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
});

test("migrates the legacy permission-only file without losing its policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-subagent-legacy-"));
  const path = join(root, "subagents.json");
  await writeFile(path, JSON.stringify({
    permissionRouting: "parent",
    childPermissionMode: "user_free",
  }));

  const config = await new ProductSubagentConfigStore(path).read();
  assert.equal(config.permissionRouting, "parent");
  assert.equal(config.childPermissionMode, "user_free");
  assert.deepEqual(config.model, { mode: "inherit" });
  assert.ok(config.disabledTools.includes("subagent"));
  assert.equal(JSON.parse(await readFile(path, "utf8")).protocol, CARDBUSH_SUBAGENT_CONFIG_PROTOCOL);
});

test("accepts an opaque fixed model reference and rejects unknown fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-subagent-fixed-"));
  const path = join(root, "subagents.json");
  await writeFile(path, JSON.stringify({
    protocol: CARDBUSH_SUBAGENT_CONFIG_PROTOCOL,
    permissionRouting: "user",
    childPermissionMode: "task_free",
    model: { mode: "fixed", modelId: "reviewer" },
    disabledTools: ["subagent"],
  }));
  const store = new ProductSubagentConfigStore(path);
  assert.deepEqual((await store.read()).model, { mode: "fixed", modelId: "reviewer" });

  await writeFile(path, JSON.stringify({ permissionRouting: "user", surprise: true }));
  await assert.rejects(() => store.read(), /Unsupported Subagent config fields: surprise/);
});
