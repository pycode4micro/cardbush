import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import sharp from "sharp";

import { MAX_MODEL_IMAGE_SOURCE_BYTES, ModelImageStore, readLocalModelImage } from "../dist/index.js";
import { gif, imageFixture, incompletePng, png } from "./helpers/modelImages.mjs";

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
  for (const [bytes, code] of [
    [Buffer.alloc(0), "image_input_invalid"],
    [incompletePng, "image_input_invalid"],
    [Buffer.from("not an image"), "image_input_unsupported"],
  ]) {
    await writeFile(source, bytes);
    await assert.rejects(store.snapshot(source), { code });
  }
  await truncate(source, MAX_MODEL_IMAGE_SOURCE_BYTES + 1);
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
  await assert.rejects(store.snapshot(source), { code: "image_input_invalid" });
});

test("accepts decoder-valid trailing data through local, data-URL, original and history inputs", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  const trailer = Buffer.alloc(24, 0x42);
  const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#315f83" } }).jpeg().toBuffer();
  const webp = await sharp(png).webp().toBuffer();
  for (const [mime, original] of [["jpeg", jpeg], ["png", png], ["gif", gif], ["webp", webp]]) {
    const bytes = Buffer.concat([original, trailer]);
    await writeFile(source, bytes);
    const read = await readLocalModelImage(source);
    assert.equal(read.mime, `image/${mime}`, "actual bytes determine the format, not the extension");
    assert.deepEqual(read.content, bytes);
    const saved = await store.snapshot(source);
    assert.equal(saved, await store.snapshot(`data:image/${mime};base64,${bytes.toString("base64")}`));
    const pinnedOriginal = await store.snapshot(source, undefined, { original: true });
    assert.deepEqual(await readFile(pinnedOriginal), bytes);
    assert.equal(await new ModelImageStore(root).snapshot(pinnedOriginal), pinnedOriginal);
    assert.deepEqual(await readFile(source), bytes, "ingestion leaves the source unchanged");
    assert.deepEqual(await sharp(await readFile(saved)).raw().toBuffer(), await sharp(original).raw().toBuffer());
  }
});

test("rejects broken pixel data even with matching headers and end markers, including original mode", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  const corruptPng = Buffer.from(png);
  corruptPng[45] ^= 0xff;
  const fakeJpeg = Buffer.from([255, 216, 1, 2, 3, 4, 255, 217]);
  const jpeg = await sharp(png).jpeg().toBuffer();
  // A prior successful read of the same path must not make changed bytes trusted.
  await store.snapshot(source);
  for (const bytes of [corruptPng, fakeJpeg, jpeg.subarray(0, -2)]) {
    await writeFile(source, bytes);
    for (const operation of [
      () => readLocalModelImage(source),
      () => store.snapshot(source),
      () => store.snapshot(source, undefined, { original: true }),
      () => store.snapshot(`data:image/png;base64,${bytes.toString("base64")}`),
    ]) await assert.rejects(operation(), error => {
      assert.equal(error.code, "image_input_invalid");
      assert.match(error.message, /Cannot decode model image/);
      assert.doesNotMatch(error.message, /Wait for the image writer/);
      return true;
    });
  }
  await writeFile(source, png);
  assert.deepEqual((await readLocalModelImage(source)).content, png);
});

test("enforces the decoder pixel limit even for tiny files and explicit originals", async (context) => {
  const { root, source } = await imageFixture(context);
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(9000, 16);
  oversized.writeUInt32BE(9000, 20);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  await writeFile(source, oversized);
  const store = new ModelImageStore(root);
  await assert.rejects(readLocalModelImage(source), { code: "image_input_too_large" });
  await assert.rejects(store.snapshot(source), { code: "image_input_too_large" });
  await assert.rejects(store.snapshot(source, undefined, { original: true }), { code: "image_input_too_large" });
  await assert.rejects(readdir(join(root, "model-images")), { code: "ENOENT" });
});

test("replays identical image bytes without decoding them for every model request", async (context) => {
  const { root, source } = await imageFixture(context);
  const image = await sharp({ create: { width: 17, height: 23, channels: 3, background: "#9167bd" } }).png().toBuffer();
  await writeFile(source, image);
  const decode = context.mock.method(sharp.prototype, "raw");
  const saved = await new ModelImageStore(root).snapshot(source);
  const firstDecodes = decode.mock.callCount();
  assert.equal(firstDecodes, 1);
  for (let round = 0; round < 3; round++) {
    await readLocalModelImage(saved);
    await new ModelImageStore(root).snapshot(saved);
  }
  assert.equal(decode.mock.callCount(), firstDecodes);
});

test("leaves remote URLs alone, pins data images, and honors cancellation before IO", async (context) => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root);
  const remote = "https://example.test/image.png";
  assert.equal(await store.snapshot(remote), remote);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(store.snapshot(source, abort.signal), { name: "AbortError" });
  await assert.rejects(readdir(join(root, "model-images")), { code: "ENOENT" });
  const saved = await store.snapshot("data:image/png;base64," + png.toString("base64"));
  assert.deepEqual(await readFile(saved), png);
  assert.equal(saved, await store.snapshot(source));
  await assert.rejects(store.snapshot("data:image/png;base64,not base64!"), { code: "image_input_invalid" });
});
