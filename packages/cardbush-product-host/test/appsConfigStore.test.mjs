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
    assert.equal((await readFile(path, "utf8")).includes("computer_use"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
