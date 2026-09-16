import { blobCacheEntries, temporaryCacheEntries } from './cacheMaintenance.js';
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import sharp from "sharp";
import { compressModelImage, MAX_MODEL_IMAGE_SOURCE_BYTES, MODEL_IMAGE_DECODER_OPTIONS } from "./modelImageCompression.js";

export { MODEL_IMAGE_MAX_EDGE, MODEL_IMAGE_MAX_PIXELS, MODEL_IMAGE_TARGET_BYTES, MAX_MODEL_IMAGE_SOURCE_BYTES } from "./modelImageCompression.js";

export const MAX_MODEL_IMAGE_BYTES = 9_000_000;

// Cache only successful content digests, never source paths or image buffers.
// Immutable history can be replayed each round without repeating pixel decoding.
const decodedImages = new Set<string>();
const MAX_DECODED_IMAGE_ENTRIES = 128;

export class ModelImageInputError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelImageInputError";
  }
}

/** Read one bounded, complete observation, rather than a file that is still being written. */
export async function readLocalModelImage(path: string, signal?: AbortSignal, maxBytes = MAX_MODEL_IMAGE_BYTES): Promise<{
  content: Buffer;
  mime: string;
}> {
  signal?.throwIfAborted();
  if (!isAbsolute(path)) throw new ModelImageInputError("image_input_invalid", "Model image path must be absolute.");
  try {
    const file = await open(path, "r");
    let content: Buffer;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new ModelImageInputError("image_input_invalid", `Model image is not a file: ${path}`);
      if (before.size > BigInt(maxBytes)) {
        throw new ModelImageInputError("image_input_too_large", `Model image exceeds ${maxBytes} bytes: ${path}`);
      }
      // One extra byte detects growth without an unbounded readFile allocation.
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true });
      signal?.throwIfAborted();
      // ctime can change when a completed snapshot's temporary hard link is removed.
      if (BigInt(length) !== before.size || after.size !== before.size ||
          after.mtimeNs !== before.mtimeNs) {
        throw new ModelImageInputError("image_input_not_ready", `Model image changed while reading: ${path}. Wait for the image writer to finish, then inject it again.`);
      }
      content = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    return { content, mime: await imageMime(content, signal) };
  } catch (error) {
    if (error instanceof ModelImageInputError || signal?.aborted) throw error;
    throw new ModelImageInputError(
      "image_input_unavailable",
      `Cannot read model image: ${path}. Ensure the file exists and its writer has finished, then inject it again.`,
      { cause: error },
    );
  }
}

/** Runtime-owned content-addressed blobs. Persisted messages reference these, never mutable source files. */
export class ModelImageStore {
  async cacheEntries() {
    return [...await blobCacheEntries(this.#root, 'model_images', name => /^[a-f0-9]{64}\.(png|jpeg|webp|gif|bmp)$/.test(name)), ...await temporaryCacheEntries(this.#root)];
  }

  readonly #root: string;

  constructor(dataRoot = join(process.cwd(), ".cardbush-runtime")) {
    this.#root = resolve(dataRoot, "model-images");
  }

  async snapshot(source: string, signal?: AbortSignal, options: { original?: boolean } = {}): Promise<string> {
    signal?.throwIfAborted();
    const value = source.trim();
    // Remote URLs remain provider-owned; do not fetch arbitrary URLs in the host.
    if (/^https?:\/\//i.test(value)) return value;
    const managed = isAbsolute(value) && dirname(resolve(value)) === this.#root;
    const maxBytes = options.original || managed ? MAX_MODEL_IMAGE_BYTES : MAX_MODEL_IMAGE_SOURCE_BYTES;
    let { content, mime } = /^data:image\//i.test(value)
      ? await readDataImage(value, maxBytes, signal) : await readLocalModelImage(value, signal, maxBytes);
    if (managed) {
      const expected = join(this.#root, `${createHash("sha256").update(content).digest("hex")}.${mime.slice(6)}`);
      if (resolve(value) !== expected) throw new ModelImageInputError("image_snapshot_corrupt", "Stored model image failed its content integrity check.");
      // Snapshots (including legacy and explicit originals) are immutable. Never
      // re-encode the prefix when replaying history or receiving a tool snapshot.
      return expected;
    }
    if (!options.original) {
      try { ({ content, mime } = await compressModelImage(content, mime, signal)); }
      catch (error) {
        if (signal?.aborted) throw error;
        throw new ModelImageInputError("image_input_compression_failed", `Cannot prepare model image: ${error instanceof Error ? error.message : String(error)}. Use a complete PNG, JPEG or WebP, crop the relevant area, or request original: true.`, { cause: error });
      }
    }
    const digest = createHash("sha256").update(content).digest("hex");
    const target = join(this.#root, `${digest}.${mime.slice("image/".length)}`);
    signal?.throwIfAborted();
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporary = join(this.#root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600, flush: true, signal });
      signal?.throwIfAborted();
      try {
        // An atomic, no-replace publish: concurrent injections share a complete blob.
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLocalModelImage(target, signal);
        if (!existing.content.equals(content)) {
          throw new ModelImageInputError("image_snapshot_corrupt", "Stored model image failed its content integrity check. The existing observation was not overwritten.");
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return target;
  }
}

async function readDataImage(value: string, maxBytes: number, signal?: AbortSignal): Promise<{ content: Buffer; mime: string }> {
  const header = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(value);
  if (!header) throw new ModelImageInputError("image_input_invalid", "Data image must use base64 encoding.");
  const encoded = value.slice(header[0].length);
  if (encoded.length > Math.ceil(maxBytes / 3) * 4) {
    throw new ModelImageInputError("image_input_too_large", `Model image exceeds ${maxBytes} bytes.`);
  }
  const content = Buffer.from(encoded, "base64");
  if (content.length > maxBytes) throw new ModelImageInputError("image_input_too_large", `Model image exceeds ${maxBytes} bytes.`);
  if (content.toString("base64") !== encoded) throw new ModelImageInputError("image_input_invalid", "Data image contains invalid base64.");
  return { content, mime: await imageMime(content, signal) };
}

async function imageMime(content: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!content.length) throw new ModelImageInputError("image_input_invalid", "Model image is empty. Choose a complete image file.");
  const mime = rasterMime(content);
  if (!mime) throw new ModelImageInputError("image_input_unsupported", "Model image format is not supported. Convert it to PNG, JPEG, GIF or WebP.");
  const digest = createHash("sha256").update(content).digest("hex");
  if (decodedImages.has(digest)) {
    decodedImages.delete(digest);
    decodedImages.add(digest);
    return mime;
  }
  try {
    // Headers identify the format, not completeness. Decode every frame with
    // strict pixel checks and bounded resources. The tiny output is discarded;
    // validation never replaces the image or allocates a full raster in JS.
    await sharp(content, { ...MODEL_IMAGE_DECODER_OPTIONS, animated: true })
      .resize({ width: 1, height: 1, fit: "fill", fastShrinkOnLoad: false })
      .timeout({ seconds: 15 }).raw().toBuffer();
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    const detail = error instanceof Error ? error.message : String(error);
    const code = /pixel limit/i.test(detail) ? "image_input_too_large"
      : /timeout/i.test(detail) ? "image_input_decode_timeout"
      : /unsupported image format/i.test(detail) ? "image_input_unsupported" : "image_input_invalid";
    throw new ModelImageInputError(code,
      `Cannot decode model image: ${detail}. Use a complete PNG, JPEG, GIF or WebP image within the image size limits.`,
      { cause: error });
  }
  decodedImages.add(digest);
  if (decodedImages.size > MAX_DECODED_IMAGE_ENTRIES) decodedImages.delete(decodedImages.values().next().value!);
  return mime;
}

function rasterMime(content: Buffer): string | undefined {
  if (
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) return "image/png";
  if (content[0] === 0xff && content[1] === 0xd8) return "image/jpeg";
  if (
    ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii"))
  ) return "image/gif";
  if (
    content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (content.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}
