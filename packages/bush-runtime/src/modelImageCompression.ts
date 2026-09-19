import sharp from "sharp";

// Pixel and byte limits are independent: vision tokens are not base64 tokens.
// Keep enough resolution for screenshots while bounding each new observation.
export const MODEL_IMAGE_MAX_EDGE = 4096;
export const MODEL_IMAGE_MAX_PIXELS = 4_000_000;
export const MODEL_IMAGE_TARGET_BYTES = 1_000_000;
export const MAX_MODEL_IMAGE_SOURCE_BYTES = 64_000_000;
export const MODEL_IMAGE_DECODER_OPTIONS = {
  limitInputPixels: 64_000_000,
  failOn: "warning",
  sequentialRead: true,
} as const;

export async function compressModelImage(content: Buffer, mime: string, signal?: AbortSignal): Promise<{
  content: Buffer; mime: string;
}> {
  signal?.throwIfAborted();
  const metadata = await sharp(content, MODEL_IMAGE_DECODER_OPTIONS).metadata();
  signal?.throwIfAborted();
  const width = metadata.autoOrient.width;
  const height = metadata.autoOrient.height;
  let scale = Math.min(1, MODEL_IMAGE_MAX_EDGE / Math.max(width, height),
    Math.sqrt(MODEL_IMAGE_MAX_PIXELS / (width * height)));
  // Never silently flatten an animation. Large animations need selected frames.
  if ((metadata.pages ?? 1) > 1) {
    if (scale < 1 || content.length > MODEL_IMAGE_TARGET_BYTES) {
      throw new Error("Animated image exceeds the model image budget. Extract the relevant frames, or explicitly request original: true.");
    }
    return { content, mime };
  }
  if (scale === 1 && content.length <= MODEL_IMAGE_TARGET_BYTES && (!metadata.orientation || metadata.orientation === 1)) {
    return { content, mime };
  }
  const pipeline = () => sharp(content, MODEL_IMAGE_DECODER_OPTIONS).autoOrient().resize({
    width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)),
    fit: "inside", withoutEnlargement: true,
  }).timeout({ seconds: 15 });
  // Screenshots, charts and document pages often fit losslessly. Try this at
  // the largest permitted resolution before introducing JPEG/WebP artifacts.
  // JPEG photos already have a lossy source, so avoid a redundant PNG encode.
  if (mime !== "image/jpeg") {
    const lossless = await pipeline().png({ compressionLevel: 6, adaptiveFiltering: true, palette: false }).toBuffer();
    signal?.throwIfAborted();
    if (lossless.length <= MODEL_IMAGE_TARGET_BYTES) return { content: lossless, mime: "image/png" };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const quality = attempt === 0 ? 88 : 80;
    const encoded = await (metadata.hasAlpha
      ? pipeline().webp({ quality, alphaQuality: 100 })
      : pipeline().jpeg({ quality, chromaSubsampling: "4:4:4" })).toBuffer();
    signal?.throwIfAborted();
    if (encoded.length <= MODEL_IMAGE_TARGET_BYTES) {
      return { content: encoded, mime: metadata.hasAlpha ? "image/webp" : "image/jpeg" };
    }
    scale *= Math.min(0.9, Math.sqrt(MODEL_IMAGE_TARGET_BYTES / encoded.length) * 0.94);
  }
  throw new Error("Cannot fit image into the model image budget. Crop the relevant area or explicitly request original: true.");
}
