import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const MAX_MODEL_IMAGE_BYTES = 9_000_000;

export class ModelImageInputError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelImageInputError";
  }
}

/** Read one bounded, complete observation, rather than a file that is still being written. */
export async function readLocalModelImage(path: string, signal?: AbortSignal): Promise<{
  content: Buffer;
  mime: string;
}> {
  signal?.throwIfAborted();
  if (!isAbsolute(path)) throw new ModelImageInputError("image_input_invalid", "Model image path must be absolute.");
  try {
    const file = await open(path, "r");
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw new ModelImageInputError("image_input_invalid", `Model image is not a file: ${path}`);
      if (before.size > BigInt(MAX_MODEL_IMAGE_BYTES)) {
        throw new ModelImageInputError("image_input_too_large", `Model image exceeds ${MAX_MODEL_IMAGE_BYTES} bytes: ${path}`);
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
      const content = buffer.subarray(0, length);
      return { content, mime: imageMime(content) };
    } finally {
      await file.close();
    }
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
  readonly #root: string;

  constructor(dataRoot = join(process.cwd(), ".cardbush-runtime")) {
    this.#root = resolve(dataRoot, "model-images");
  }

  async snapshot(source: string, signal?: AbortSignal): Promise<string> {
    const value = source.trim();
    // Keep existing remote/data image behavior; this store owns local file observations only.
    if (/^https?:\/\//i.test(value) || /^data:image\//i.test(value)) return value;
    const { content, mime } = await readLocalModelImage(value, signal);
    const digest = createHash("sha256").update(content).digest("hex");
    const target = join(this.#root, `${digest}.${mime.slice("image/".length)}`);
    if (resolve(value) === target) {
      return target;
    }
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

function imageMime(content: Buffer): string {
  if (
    content.length >= 32 &&
    content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    content.subarray(-12, -8).readUInt32BE(0) === 0 &&
    content.subarray(-8, -4).toString("ascii") === "IEND"
  ) return "image/png";
  if (
    content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 &&
    content.at(-2) === 0xff && content.at(-1) === 0xd9
  ) return "image/jpeg";
  if (
    content.length >= 14 &&
    ["GIF87a", "GIF89a"].includes(content.subarray(0, 6).toString("ascii")) &&
    content.at(-1) === 0x3b
  ) return "image/gif";
  if (
    content.length >= 20 && content.subarray(0, 4).toString("ascii") === "RIFF" &&
    content.subarray(8, 12).toString("ascii") === "WEBP" &&
    content.readUInt32LE(4) + 8 === content.length
  ) return "image/webp";
  if (
    content.length >= 26 && content.subarray(0, 2).toString("ascii") === "BM" &&
    content.readUInt32LE(2) === content.length
  ) return "image/bmp";
  throw new ModelImageInputError(
    "image_input_not_ready",
    "Model image content is not a supported raster image or is incomplete. Wait for the image writer to finish, then inject a complete PNG, JPEG, GIF, WebP, or BMP file.",
  );
}
