import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { MAX_MODEL_IMAGE_BYTES, ModelImageStore, readLocalModelImage } from "../dist/index.js";
import { gif, imageFixture, png } from "./helpers/modelImages.mjs";

test("pins exact bytes across source overwrite, deletion, and store restart", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  const first = await store.snapshot(source);
  assert.notEqual(first, source);
  assert.equal(first, join(root, "model-images", createHash("sha256").update(png).digest("hex") + ".png"));
  await writeFile(source, gif);
  const second = await store.snapshot(source);
  assert.notEqual(second, first);
  await rm(source);
  assert.deepEqual((await readLocalModelImage(first)).content, png);
  assert.deepEqual((await readLocalModelImage(second)).content, gif);
  assert.equal(await new ModelImageStore(root).snapshot(first), first);
  assert.deepEqual((await readLocalModelImage(first)).content, png);
});

test("concurrent injections atomically deduplicate identical bytes without temporary-file residue", async (context) => {
  const { root, source } = await imageFixture(context);
  const paths = await Promise.all(Array.from({ length: 12 }, () => new ModelImageStore(root).snapshot(source)));
  assert.equal(new Set(paths).size, 1);
  assert.equal((await readdir(join(root, "model-images"))).length, 1);
  assert.deepEqual(await readFile(paths[0]), png);
});

test("never silently overwrites a corrupt existing snapshot", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  const saved = await store.snapshot(source);
  await writeFile(saved, gif);
  await assert.rejects(store.snapshot(source), { code: "image_snapshot_corrupt" });
  assert.deepEqual(await readFile(saved), gif);
  assert.equal((await readdir(join(root, "model-images"))).length, 1);
});

test("rejects missing, incomplete, non-image, directory and oversized inputs before publishing a snapshot", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  await assert.rejects(store.snapshot(join(root, "missing.png")), { code: "image_input_unavailable" });
  await assert.rejects(store.snapshot(root), { code: "image_input_invalid" });
  await assert.rejects(store.snapshot("relative.png"), { code: "image_input_invalid" });
  for (const bytes of [Buffer.alloc(0), png.subarray(0, -12), Buffer.from("not an image")]) {
    await writeFile(source, bytes);
    await assert.rejects(store.snapshot(source), { code: "image_input_not_ready" });
  }
  await writeFile(source, Buffer.alloc(MAX_MODEL_IMAGE_BYTES + 1));
  await assert.rejects(store.snapshot(source), { code: "image_input_too_large" });
  await assert.rejects(readdir(join(root, "model-images")), { code: "ENOENT" });
});

test("validates raster completion, not the filename extension", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  await writeFile(source, gif);
  assert.match(await store.snapshot(source), /\.gif$/);
  const partialWebp = Buffer.alloc(24);
  partialWebp.write("RIFF", 0);
  partialWebp.writeUInt32LE(100, 4);
  partialWebp.write("WEBP", 8);
  await writeFile(source, partialWebp);
  await assert.rejects(store.snapshot(source), { code: "image_input_not_ready" });
});

test("does not reinterpret remote or data URLs, and honors cancellation before local IO", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  for (const url of ["https://example.test/image.png", "data:image/png;base64," + png.toString("base64")]) {
    assert.equal(await store.snapshot(url), url);
  }
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(store.snapshot(source, abort.signal), { name: "AbortError" });
  await assert.rejects(readdir(join(root, "model-images")), { code: "ENOENT" });
});
