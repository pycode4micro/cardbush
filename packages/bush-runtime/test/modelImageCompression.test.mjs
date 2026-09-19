import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import { ModelImageStore, MAX_MODEL_IMAGE_BYTES, MODEL_IMAGE_MAX_EDGE,
  MODEL_IMAGE_MAX_PIXELS, MODEL_IMAGE_TARGET_BYTES } from '../dist/index.js';
import { imageFixture } from './helpers/modelImages.mjs';

// Deterministic high-entropy RGB input forces the byte limiter, not just resize.
async function noisyImage(width, height, channels = 3) {
  const raw = Buffer.alloc(width * height * channels);
  let state = 73;
  for (let i = 0; i < raw.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    raw[i] = channels === 4 && i % 4 === 3 ? i % 251 : state & 255;
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}

test('keeps an already compliant image byte-exact, including the former 256 KB to 1 MB lossy range', async t => {
  const { root, source } = await imageFixture(t);
  const original = await noisyImage(600, 400);
  assert.ok(original.length > 256_000 && original.length <= MODEL_IMAGE_TARGET_BYTES);
  await writeFile(source, original);
  const store = new ModelImageStore(root);
  const saved = await store.snapshot(source);
  assert.deepEqual(await readFile(saved), original, 'no unnecessary lossy generation');
  assert.equal(await new ModelImageStore(root).snapshot(saved), saved, 'history remains byte-exact across restart');
});

test('re-encodes document graphics losslessly when that meets the byte budget', async t => {
  const { root, source } = await imageFixture(t);
  const original = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <rect x="10" y="10" width="1180" height="780" fill="white"/>
    <path d="M20 300H1180M20 301H1180M400 10V790" stroke="#184bdc" stroke-width="1"/>
    <text x="100" y="280" font-size="12" fill="#111">Small text and thin lines must survive encoding.</text>
  </svg>`)).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(original.length > MODEL_IMAGE_TARGET_BYTES);
  await writeFile(source, original);
  const result = await readFile(await new ModelImageStore(root).snapshot(source));
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.hasAlpha, true);
  assert.ok(result.length <= MODEL_IMAGE_TARGET_BYTES);
  assert.deepEqual(await sharp(result).raw().toBuffer(), await sharp(original).raw().toBuffer(), 'all pixels, including text and alpha, survive');
  assert.deepEqual(await readFile(source), original, 'the UI still receives the original file');
});

test('bounds a source above the former 9 MB limit and pins the compressed observation across restart', async t => {
  const { root, source } = await imageFixture(t);
  const original = await noisyImage(2200, 1800);
  assert.ok(original.length > MAX_MODEL_IMAGE_BYTES);
  await writeFile(source, original);
  const saved = await new ModelImageStore(root).snapshot(source);
  const bytes = await readFile(saved);
  const metadata = await sharp(bytes).metadata();
  assert.ok(bytes.length <= MODEL_IMAGE_TARGET_BYTES);
  assert.ok(metadata.width * metadata.height <= MODEL_IMAGE_MAX_PIXELS);
  assert.ok(Math.max(metadata.width, metadata.height) <= MODEL_IMAGE_MAX_EDGE);
  assert.ok(Math.abs(metadata.width / metadata.height - 2200 / 1800) < .01);
  assert.deepEqual(await readFile(source), original, 'UI/source image is untouched');
  assert.ok(saved.includes(createHash('sha256').update(bytes).digest('hex')));
  assert.equal(await new ModelImageStore(root).snapshot(source), saved, 'repeated ingestion is deterministic');
  await assert.rejects(new ModelImageStore(root).snapshot(source, undefined, { original: true }), { code: 'image_input_too_large' });
  await rm(source);
  assert.equal(await new ModelImageStore(root).snapshot(saved), saved);
  assert.deepEqual(await readFile(saved), bytes);
});

test('preserves transparency, orientation, aspect ratio and long-image coverage', async t => {
  const { root, source } = await imageFixture(t);
  const original = await noisyImage(400, 5000, 4);
  await writeFile(source, original);
  const store = new ModelImageStore(root);
  const bytes = await readFile(await store.snapshot(source));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.hasAlpha, true);
  assert.ok(metadata.height <= 4096 && metadata.height > 2000);
  assert.ok(Math.abs(metadata.width / metadata.height - .08) < .001);
  assert.ok(bytes.length <= MODEL_IMAGE_TARGET_BYTES);
  const rotated = await sharp({ create: { width: 40, height: 80, channels: 3, background: '#3478e8' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  await writeFile(source, rotated);
  const oriented = await sharp(await readFile(await store.snapshot(source))).metadata();
  assert.equal(oriented.width, 80);
  assert.equal(oriented.height, 40);
  assert.equal(oriented.orientation, undefined);
});

test('bounds pixels even when a highly compressible source is already tiny in bytes', async t => {
  const { root, source } = await imageFixture(t);
  const original = await sharp({ create: { width: 6000, height: 2000, channels: 3, background: '#3681ed' } }).png().toBuffer();
  assert.ok(original.length < 256_000);
  await writeFile(source, original);
  const result = await readFile(await new ModelImageStore(root).snapshot(source));
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, 'png', 'resizing a flat graphic need not add lossy compression');
  assert.ok(metadata.width <= MODEL_IMAGE_MAX_EDGE);
  assert.ok(metadata.width * metadata.height <= MODEL_IMAGE_MAX_PIXELS);
  assert.ok(Math.abs(metadata.width / metadata.height - 3) < .01);
  assert.ok(result.length <= MODEL_IMAGE_TARGET_BYTES);
});

test('explicit original remains exact on the second snapshot performed by the tool loop', async t => {
  const { root, source } = await imageFixture(t);
  const original = await noisyImage(1200, 900);
  await writeFile(source, original);
  const store = new ModelImageStore(root);
  const saved = await store.snapshot(source, undefined, { original: true });
  assert.deepEqual(await readFile(await store.snapshot(saved)), original);
  const compressed = await store.snapshot(source);
  assert.notEqual(compressed, saved);
  assert.ok((await readFile(compressed)).length <= MODEL_IMAGE_TARGET_BYTES);
  const fromData = await store.snapshot('data:image/png;base64,' + original.toString('base64'));
  assert.equal(fromData, compressed);
});

test('does not flatten animated inputs and reports invalid image decoders explicitly', async t => {
  const { root, source } = await imageFixture(t);
  const frames = Buffer.alloc(16 * 32 * 3, 0);
  frames.fill(255, 16 * 16 * 3);
  const animated = await sharp(frames, { raw: { width: 16, height: 32, channels: 3, pageHeight: 16 } })
    .gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const store = new ModelImageStore(root);
  await writeFile(source, animated);
  assert.deepEqual(await readFile(await store.snapshot(source)), animated);
  const metadata = await sharp(animated, { animated: true }).metadata();
  assert.equal(metadata.pages, 2);
  // File signature is complete, but the pixel stream is broken.
  await writeFile(source, Buffer.from([255, 216, 1, 2, 3, 4, 255, 217]));
  await assert.rejects(store.snapshot(source), { code: 'image_input_invalid' });
});
