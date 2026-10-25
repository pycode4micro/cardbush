import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import sharp from "sharp";

import { configureProcessResourceClient, MAX_MODEL_IMAGE_SOURCE_BYTES, ModelImageStore, readLocalModelImage } from "../dist/index.js";
import { gif, imageFixture, incompletePng, png } from "./helpers/modelImages.mjs";
import { WorkspacePathGuard } from '../dist/workspacePathGuard.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

test('resource admission refusals retain their code, details and identity for model input preparation', async t => {
  const { root, source } = await imageFixture(t);
  const refused = Object.assign(new Error('Process admission blocked by system_memory; no process was started.'),
    { code: 'resource_memory_pressure', details: { headroomBytes: 0, startupMemoryBytes: 64 * 1024 ** 2 } });
  configureProcessResourceClient({ acquire: async () => { throw refused; } });
  t.after(() => configureProcessResourceClient());
  await assert.rejects(readLocalModelImage(source), error => error === refused);
  await assert.rejects(new ModelImageStore(root).snapshot(source), error => error === refused);
});

test('request-scoped readers grant only listed images and never turn a store path or metadata into authority', async t => {
  const { root, source } = await imageFixture(t), store = new ModelImageStore(root);
  const snapshot = await store.snapshot(`data:image/png;base64,${png.toString('base64')}`);
  const other = await store.snapshot(`data:image/gif;base64,${gif.toString('base64')}`);
  const sources = [snapshot, source], read = store.readerFor(sources);
  sources.push(other);
  const refused = Object.assign(new Error('sandbox unavailable'), { code: 'workspace_path_guard_unavailable' });
  let externalReads = 0;
  t.mock.method(WorkspacePathGuard.prototype, 'pin', async () => { externalReads++; throw refused; });
  assert.deepEqual((await read(snapshot)).content, png);
  await assert.rejects(read(other), { code: 'image_input_not_authorized' });
  await assert.rejects(store.readerFor([])(snapshot), { code: 'image_input_not_authorized' });
  await assert.rejects(read(source), error => error.code === 'image_input_unavailable' && error.cause === refused);
  assert.equal(externalReads, 1);
  await writeFile(snapshot, gif);
  await assert.rejects(read(snapshot), { code: 'image_snapshot_corrupt' });
  assert.equal(externalReads, 1, 'corrupt owned snapshots must not fall back to source reads');
  await rm(snapshot);
  await assert.rejects(read(snapshot), error => error.code === 'image_input_unavailable' && error.cause.code === 'ENOENT');
});

test('missing images and rejected sandbox preflight have distinct actionable errors and retain their cause', async t => {
  const { root, source } = await imageFixture(t);
  await assert.rejects(readLocalModelImage(join(root, 'missing.png')), error => {
    assert.equal(error.code, 'image_input_unavailable'); assert.equal(error.cause.code, 'ENOENT');
    assert.match(error.message, /Ensure the file exists/); return true;
  });
  const refused = Object.assign(new Error('sandbox path guard unavailable'), { code: 'workspace_path_guard_unavailable' });
  t.mock.method(WorkspacePathGuard.prototype, 'pin', async () => { throw refused; });
  await assert.rejects(new ModelImageStore(root).snapshot(source), error => {
    assert.equal(error.code, 'image_input_unavailable'); assert.equal(error.cause, refused);
    assert.match(error.message, /authorization and sandbox availability/);
    assert.doesNotMatch(error.message, /Ensure the file exists/); return true;
  });
  await assert.rejects(readdir(join(root, 'model-images')), { code: 'ENOENT' });
});

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

test('preview snapshot reads verify ownership, real path and content digest', async context => {
  const { root, source } = await imageFixture(context);
  const store = new ModelImageStore(root), path = await store.snapshot(source);
  await rm(source);
  assert.deepEqual(await new ModelImageStore(root).readSnapshot(path), { content: png, mime: 'image/png' });
  if (process.platform === 'win32') assert.deepEqual((await store.readSnapshot(path.toUpperCase().replaceAll('\\', '/'))).content, png);
  await assert.rejects(store.readSnapshot(source), { code: 'image_snapshot_invalid' });
  await assert.rejects(store.readSnapshot(basename(path)), { code: 'image_snapshot_invalid' });
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, basename(path)), png);
  await assert.rejects(store.readSnapshot(join(outside, basename(path))), { code: 'image_snapshot_invalid' });
  await writeFile(path, gif);
  await assert.rejects(store.readSnapshot(path), { code: 'image_snapshot_corrupt' });
  await rm(path);
  // An owned blob name must not redirect to an external file, even identical bytes.
  try { await symlink(join(outside, basename(path)), path, 'file'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  await assert.rejects(store.readSnapshot(path), { code: 'image_snapshot_invalid' });
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

test('snapshot publication can reuse a pinned existing blob, but still rejects corruption', { skip: process.platform !== 'win32' }, async t => {
  const { root, source } = await imageFixture(t);
  const store = new ModelImageStore(root), saved = await store.snapshot(source);
  const inline = `data:image/png;base64,${png.toString('base64')}`;
  for (const corrupt of [false, true]) {
    if (corrupt) await writeFile(saved, gif);
    const guard = new WorkspacePathGuard();
    try {
      await guard.pin(join(root, 'model-images'));
      if (corrupt) await assert.rejects(store.snapshot(inline), { code: 'image_snapshot_corrupt' });
      else assert.equal(await store.snapshot(inline), saved);
      assert.deepEqual(await readFile(saved), corrupt ? gif : png);
      assert.equal((await readdir(join(root, 'model-images'))).length, 1);
    } finally { await guard.close(); }
  }
});

for (const cancelled of [false, true]) test(`a busy unpublished snapshot retries only publication and respects cancellation (${cancelled})`, async t => {
  const { root } = await imageFixture(t);
  const store = new ModelImageStore(root), controller = new AbortController();
  const inline = `data:image/png;base64,${png.toString('base64')}`;
  const original = fs.link;
  let attempts = 0;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, 'link', async (from, to) => {
    if (++attempts === 1) {
      if (cancelled) controller.abort();
      throw Object.assign(new Error('snapshot reader is holding the directory'), { code: 'EBUSY' });
    }
    return original(from, to);
  }); syncBuiltinESMExports();
  if (cancelled) {
    await assert.rejects(store.snapshot(inline, controller.signal), { name: 'AbortError' });
    assert.equal(attempts, 1);
    assert.deepEqual(await readdir(join(root, 'model-images')), []);
  } else {
    const saved = await store.snapshot(inline);
    assert.equal(attempts, 2); assert.deepEqual(await readFile(saved), png);
    assert.equal((await readdir(join(root, 'model-images'))).length, 1);
  }
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
