import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  CARDBUSH_APPS_CONFIG_PROTOCOL,
  CardbushAppsConfigStore,
} from "../dist/index.js";

test("persists service, plugin lifecycle, and plugin-specific configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-apps-config-"));
  try {
    const path = join(root, "apps.json");
    const store = new CardbushAppsConfigStore(path);
    const initial = await store.read();
    assert.equal(initial.protocol, CARDBUSH_APPS_CONFIG_PROTOCOL);
    assert.equal(initial.serviceEnabled, true);
    assert.equal(initial.plugins[0].installed, true);
    const saved = await store.write({
      serviceEnabled: false,
      plugins: [{
        id: "computer_use",
        installed: false,
        enabled: false,
        config: {
          screenshotDirectory: root,
          allowOpenApp: false,
          allowWindowClose: false,
        },
      }],
    });
    assert.equal(saved.revision, 2);
    assert.equal(saved.plugins[0].config.screenshotDirectory, root);
    assert.deepEqual(await store.read(), saved);
    assert.equal(saved.plugins[0].id, "computer-use");
    assert.equal((await readFile(path, "utf8")).includes("computer-use"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defaults Chrome to the extension connector and keeps remote debugging explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-chrome-config-"));
  try {
    const path = join(root, "apps.json");
    const chrome = {
      id: "chrome",
      name: "Chrome",
      description: "Chrome DevTools MCP",
      longDescription: "Official Chrome DevTools MCP",
      version: "1.8.0",
      developerName: "Google",
      category: "Productivity",
      capabilities: ["Interactive"],
      keywords: ["chrome"],
      defaultPrompts: ["Open a page"],
      brandColor: "#4285F4",
      logoPath: "",
      logoDarkPath: "",
      manifestPath: "",
      source: "bundled",
      installation: "AVAILABLE",
      components: [{ kind: "mcp", id: "chrome-devtools", name: "Chrome", description: "MCP service" }],
    };
    const store = new CardbushAppsConfigStore(path, {
      loadCatalog: async () => [chrome],
    });
    const initial = await store.read();
    assert.deepEqual(initial.plugins[0].config, { connectionMode: "connector" });
    const migrated = await store.write({
      serviceEnabled: true,
      plugins: [{
        id: "chrome",
        installed: true,
        enabled: true,
        config: {},
      }],
    });
    assert.deepEqual(migrated.plugins[0].config, { connectionMode: "connector" });
    const saved = await store.write({
      serviceEnabled: true,
      plugins: [{
        id: "chrome",
        installed: true,
        enabled: true,
        config: { connectionMode: "managed" },
      }],
    });
    assert.deepEqual(saved.plugins[0].config, { connectionMode: "connector" });
    const remoteDebugging = await store.write({
      serviceEnabled: true,
      plugins: [{
        id: "chrome",
        installed: true,
        enabled: true,
        config: { connectionMode: "remote_debugging" },
      }],
    });
    assert.deepEqual(remoteDebugging.plugins[0].config, { connectionMode: "remote_debugging" });
    await assert.rejects(
      () => store.write({
        serviceEnabled: true,
        plugins: [{
          id: "chrome",
          installed: true,
          enabled: true,
          config: { connectionMode: "shared-silently" },
        }],
      }),
      /chrome\.connectionMode must be connector or remote_debugging/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
