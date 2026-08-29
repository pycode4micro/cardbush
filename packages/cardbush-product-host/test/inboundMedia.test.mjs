import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadInboundMedia } from "../dist/index.js";

test("materializes inbound media under the product data directory with a safe name", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "cardbush-inbound-media-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const media = await downloadInboundMedia({
    url: "https://media.test/../../unsafe",
    directory: root,
    name: "..\\unsafe?.png",
    mediaType: "image/png",
    fetch: async () => new Response(Buffer.from([137, 80, 78, 71]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "4" },
    }),
  });
  assert.equal(media.kind, "image");
  assert.equal(media.path.startsWith(root), true);
  assert.equal(media.path.includes("?"), false);
  assert.deepEqual(await readFile(media.path), Buffer.from([137, 80, 78, 71]));
});

test("rejects non-network sources and declared oversized payloads", async () => {
  await assert.rejects(() => downloadInboundMedia({
    url: "file:///etc/passwd",
    directory: "C:\\tmp",
  }), /HTTP or HTTPS/);
  await assert.rejects(() => downloadInboundMedia({
    url: "https://media.test/file",
    directory: "C:\\tmp",
    maxBytes: 3,
    fetch: async () => new Response("data", {
      status: 200,
      headers: { "content-length": "4" },
    }),
  }), /exceeds 3 bytes/);
});
