export const uploadLimits = {
  fileBytes: 16 * 1024 * 1024,
  sourceImageBytes: 64 * 1024 * 1024,
  sourceImagePixels: 64_000_000,
  imagePixels: 12_000_000,
  // Lossy uploads are normalized to PNG on the NAS; four million pixels also bound that stored copy.
  lossyImagePixels: 4_000_000,
  imageEdge: 8192,
  targetImageBytes: 4 * 1024 * 1024,
  chunkBytes: 512 * 1024,
} as const;

type ImageInfo = { width: number; height: number; mime: string };
export type PreparedAttachment = { file: File; note?: string };
export function fileSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
const unsupported = () => new Error('请选择静态 PNG/JPG/WebP 图片、文本、PDF 或 Office 文件；不支持视频。');
const animated = () => new Error('暂不支持动图，请选择其中一帧或上传静态图片。');

/** Inspect the original before any canvas conversion, so animations and disguised videos stay rejected. */
export async function readImageInfo(file: Blob, signal: AbortSignal): Promise<ImageInfo> {
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const view = new DataView(bytes.buffer), ascii = (at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size));
  let width = 0, height = 0, mime = '';
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) && ascii(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
    let end = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = view.getUint32(offset), kind = ascii(offset + 4, 4);
      if (size > bytes.length - offset - 12) throw unsupported();
      if (kind === 'acTL') throw animated();
      offset += size + 12;
      if (kind === 'IEND') { end = true; break; }
    }
    if (!end) throw unsupported();
  } else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    mime = 'image/webp';
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = view.getUint32(offset + 4, true), kind = ascii(offset, 4), data = offset + 8;
      if (size > bytes.length - data) throw unsupported();
      if (kind === 'ANIM' || kind === 'ANMF' || (kind === 'VP8X' && size >= 10 && (bytes[data] & 2))) throw animated();
      if (kind === 'VP8X' && size >= 10) {
        width = 1 + bytes[data + 4] + (bytes[data + 5] << 8) + (bytes[data + 6] << 16);
        height = 1 + bytes[data + 7] + (bytes[data + 8] << 8) + (bytes[data + 9] << 16);
      } else if (kind === 'VP8 ' && size >= 10 && ascii(data + 3, 3) === '\x9d\x01\x2a') {
        width ||= view.getUint16(data + 6, true) & 0x3fff; height ||= view.getUint16(data + 8, true) & 0x3fff;
      } else if (kind === 'VP8L' && size >= 5 && bytes[data] === 0x2f) {
        const bits = view.getUint32(data + 1, true);
        width ||= 1 + (bits & 0x3fff); height ||= 1 + ((bits >>> 14) & 0x3fff);
      }
      offset = data + size + (size & 1);
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = 'image/jpeg';
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset++] !== 0xff) throw unsupported();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw unsupported();
      const size = view.getUint16(offset);
      if (size < 2 || size > bytes.length - offset) throw unsupported();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5); break;
      }
      offset += size;
    }
  }
  if (!width || !height || !mime) throw unsupported();
  if (width * height > uploadLimits.sourceImagePixels) throw new Error('图片分辨率过高（超过 6400 万像素），请截取需要的区域后再粘贴。');
  return { width, height, mime };
}

export function fitImageSize(width: number, height: number, pixels: number = uploadLimits.imagePixels) {
  const scale = Math.min(1, uploadLimits.imageEdge / Math.max(width, height), Math.sqrt(pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

async function decodeImage(file: File, signal: AbortSignal) {
  signal.throwIfAborted();
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return { image: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file), image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => { image.onload = image.onerror = null; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const abort = () => { image.src = ''; finish(signal.reason); };
      image.onload = () => finish(); image.onerror = () => finish(new Error('图片无法读取，请重新复制或选择原图片文件。'));
      signal.addEventListener('abort', abort, { once: true }); image.src = url;
    });
    signal.throwIfAborted();
    return { image: image as CanvasImageSource, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; URL.revokeObjectURL(url); } };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

async function optimizeImage(file: File, info: ImageInfo, signal: AbortSignal): Promise<File> {
  const decoded = await decodeImage(file, signal);
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
  try {
    let size = fitImageSize(decoded.width, decoded.height);
    const encode = (type: string, quality?: number): Promise<Blob> => {
      signal.throwIfAborted();
      if (canvas instanceof HTMLCanvasElement) return new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('图片优化失败，请截取需要的区域后重试。')), type, quality));
      return canvas.convertToBlob({ type, quality });
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      signal.throwIfAborted();
      const draw = () => {
        canvas.width = size.width; canvas.height = size.height;
        const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error('当前浏览器无法处理大图，请截取需要的区域后重试。');
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.drawImage(decoded.image, 0, 0, size.width, size.height);
      };
      draw();
      // Keep screenshots lossless when possible. WebP preserves transparency if PNG is still too large.
      let result = info.mime !== 'image/jpeg' && attempt === 0 ? await encode('image/png') : undefined;
      signal.throwIfAborted();
      if (!result || result.size > uploadLimits.targetImageBytes) {
        if (size.width * size.height > uploadLimits.lossyImagePixels) {
          size = fitImageSize(size.width, size.height, uploadLimits.lossyImagePixels); draw();
        }
        result = await encode('image/webp', attempt === 0 ? 0.9 : 0.84);
      }
      signal.throwIfAborted();
      if (result.size > 0 && result.size <= uploadLimits.targetImageBytes) {
        const ext = result.type === 'image/webp' ? '.webp' : '.png';
        return new File([result], (file.name.replace(/\.[^.]+$/, '') || '粘贴图片').slice(0, 140) + ext, { type: result.type, lastModified: file.lastModified });
      }
      const scale = Math.min(0.85, Math.sqrt(uploadLimits.targetImageBytes / result.size) * 0.92);
      size = { width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) };
    }
    throw new Error('图片优化后仍然过大，请截取需要的区域后重试。');
  } finally { decoded.close(); canvas.width = canvas.height = 1; }
}

export async function prepareAttachment(file: File, signal: AbortSignal, progress: (text: string) => void): Promise<PreparedAttachment> {
  signal.throwIfAborted();
  if (!file.size) throw new Error('附件为空，请重新选择文件。');
  if (file.type.startsWith('video/')) throw unsupported();
  const image = /\.(png|jpe?g|webp)$/i.test(file.name) || /^image\/(png|jpeg|webp)$/.test(file.type);
  if (!image) {
    if (!/\.(txt|md|csv|tsv|json|log|pdf|docx|xlsx|pptx)$/i.test(file.name)) throw unsupported();
    if (file.size > uploadLimits.fileBytes) throw new Error(`文件为 ${fileSize(file.size)}，文档最大支持 16 MB，请拆分后上传。`);
    if (file.name.length > 160) throw new Error('文件名过长，请缩短文件名后上传。');
    return { file };
  }
  if (file.size > uploadLimits.sourceImageBytes) throw new Error(`图片为 ${fileSize(file.size)}，超过 64 MB，请截取需要的区域后再粘贴。`);
  progress(`正在检查图片 · ${file.name || '粘贴图片'}`);
  const info = await readImageInfo(file, signal), size = fitImageSize(info.width, info.height);
  if (file.size <= uploadLimits.targetImageBytes && size.width === info.width && size.height === info.height) {
    const ext = info.mime === 'image/jpeg' ? '.jpg' : info.mime === 'image/webp' ? '.webp' : '.png';
    const name = (file.name.replace(/\.[^.]+$/, '') || '粘贴图片').slice(0, 140) + ext;
    return { file: name === file.name && file.type === info.mime ? file : new File([file], name, { type: info.mime, lastModified: file.lastModified }) };
  }
  progress(`正在优化大图 · ${file.name || '粘贴图片'}（${fileSize(file.size)}）`);
  const optimized = await optimizeImage(file, info, signal);
  return { file: optimized, note: `已优化 · ${fileSize(file.size)} → ${fileSize(optimized.size)}` };
}

type ChunkReply<T> = { nextOffset: number; attachment?: T };
/** Keep the same upload ID and chunk on network retries; the server already acknowledges chunks idempotently. */
export async function uploadInChunks<T>(file: File, signal: AbortSignal,
  send: (chunk: { offset: number; content: string; done: boolean }) => Promise<ChunkReply<T>>,
  progress: (percent: number) => void): Promise<T> {
  let attachment: T | undefined;
  for (let offset = 0; offset < file.size;) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(await file.slice(offset, offset + uploadLimits.chunkBytes).arrayBuffer());
    let binary = ''; for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    const next = offset + bytes.length, chunk = { offset, content: btoa(binary), done: next === file.size };
    let reply: ChunkReply<T> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try { reply = await send(chunk); break; }
      catch (error) {
        signal.throwIfAborted();
        const status = (error as { status?: number } | null)?.status;
        if (attempt === 2 || (!(error instanceof TypeError) && status !== 429 && !(status && status >= 500))) throw error;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500 * (attempt + 1));
          signal.addEventListener('abort', abort, { once: true });
        });
      }
    }
    signal.throwIfAborted();
    if (!reply || reply.nextOffset !== next) throw new Error('上传进度异常，请重新上传这个附件。');
    offset = next; attachment = reply.attachment ?? attachment; progress(Math.round(offset / file.size * 100));
  }
  if (!attachment) throw new Error('附件未保存完成，请重新上传。');
  return attachment;
}
