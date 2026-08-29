import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BotConfigStore, BotSupervisor } from "../dist/index.js";

test("runs adapters in-process and serializes lifecycle operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  await config.write("discord", {
    enabled: true,
    application_id: "app",
    bot_token: "secret",
  });
  const calls = [];
  const supervisor = new BotSupervisor({
    configStore: config,
    dataDir: root,
    adapterFactories: {
      discord: (context) => ({
        async start() {
          calls.push("start");
          await context.log("info", "token=must-not-leak");
        },
        async stop() { calls.push("stop"); },
        status() { return { healthStatus: "healthy" }; },
      }),
    },
  });
  const started = await supervisor.start("discord");
  assert.equal(started.service_status, "running");
  const [stopped, restarted] = await Promise.all([
    supervisor.stop("discord"),
    supervisor.start("discord"),
  ]);
  assert.equal(stopped.service_status, "stopped");
  assert.equal(restarted.service_status, "running");
  assert.deepEqual(calls, ["start", "stop", "start"]);
  const logs = await supervisor.logs("discord");
  assert.equal(logs.lines.some((line) => line.includes("must-not-leak")), false);
  await supervisor.shutdown();
});

test("does not fabricate availability for an adapter that is not registered", async () => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-product-host-"));
  const config = new BotConfigStore(join(root, "bots.json"));
  await config.write("feishu", {
    enabled: true,
    app_id: "app",
    app_secret: "secret",
  });
  const supervisor = new BotSupervisor({ configStore: config, dataDir: root });
  await assert.rejects(() => supervisor.start("feishu"), /not installed/);
  assert.equal((await supervisor.status("feishu")).service_status, "stopped");
});
