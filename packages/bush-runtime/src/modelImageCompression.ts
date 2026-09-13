import sharp from "sharp";

// Pixel and byte limits are independent: vision tokens are not base64 tokens.
// Keep enough resolution for screenshots while bounding each new observation.
export const MODEL_IMAGE_MAX_EDGE = 4096;
export const MODEL_IMAGE_MAX_PIXELS = 4_000_000;
export const MODEL_IMAGE_TARGET_BYTES = 1_000_000;
export const MAX_MODEL_IMAGE_SOURCE_BYTES = 64_000_000;
const MAX_SOURCE_PIXELS = 64_000_000;

export async function compressModelImage(content: Buffer, mime: string, signal?: AbortSignal): Promise<{
  content: Buffer; mime: string;
}> {
  signal?.throwIfAborted();
  const metadata = await sharp(content, { limitInputPixels: MAX_SOURCE_PIXELS }).metadata();
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
  if (scale === 1 && content.length <= 256_000 && (!metadata.orientation || metadata.orientation === 1)) {
    return { content, mime };
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const pipeline = sharp(content, { limitInputPixels: MAX_SOURCE_PIXELS }).autoOrient().resize({
      width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)),
      fit: "inside", withoutEnlargement: true,
    }).timeout({ seconds: 15 });
    const quality = attempt === 0 ? 88 : 80;
    const encoded = await (metadata.hasAlpha
      ? pipeline.webp({ quality, alphaQuality: 100 })
      : pipeline.jpeg({ quality, chromaSubsampling: "4:4:4" })).toBuffer();
    signal?.throwIfAborted();
    if (encoded.length <= MODEL_IMAGE_TARGET_BYTES) {
      // A small, already-efficient image need not pay for another lossy generation.
      if (scale === 1 && encoded.length >= content.length && (!metadata.orientation || metadata.orientation === 1)) {
        return { content, mime };
      }
      return { content: encoded, mime: metadata.hasAlpha ? "image/webp" : "image/jpeg" };
    }
    scale *= Math.min(0.9, Math.sqrt(MODEL_IMAGE_TARGET_BYTES / encoded.length) * 0.94);
  }
  throw new Error("Cannot fit image into the model image budget. Crop the relevant area or explicitly request original: true.");
}
