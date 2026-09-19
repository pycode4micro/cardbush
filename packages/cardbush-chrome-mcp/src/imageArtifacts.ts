import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { ChromeConnectorError } from './bridgeClient.js';

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
export type BrowserArtifact = { path: string; name: string; type: 'image' | 'document'; mimeType?: string; size: number; display: 'inline' | 'attachment' };

/** Original artifacts are independent of the runtime's smaller vision copies. */
export class BrowserArtifacts {
  constructor(private root = process.env.CARDBUSH_CHROME_ARTIFACTS_DIR?.trim()
    || (process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG
      ? path.join(path.dirname(process.env.CARDBUSH_CHROME_CONNECTOR_CONFIG), 'artifacts')
      : path.join(tmpdir(), 'cardbush-browser-artifacts'))) {}

  private directory(scope: string) { return path.join(this.root, digest(scope).slice(0, 24)); }

  async image(scope: string, input: { data: string; mimeType: string }, signal?: AbortSignal) {
    const encoded = input.data.replace(/\s/g, '');
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
      throw new ChromeConnectorError('image_export_invalid', 'Image is invalid or exceeds 24 MiB. Capture a smaller region.');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.toString('base64') !== encoded) throw new ChromeConnectorError('image_export_invalid', 'Expected complete Base64 image bytes.');
    const decoded = sharp(bytes, { limitInputPixels: 40_000_000 });
    const metadata = await decoded.metadata().catch(() => { throw new ChromeConnectorError('image_export_invalid', 'The returned image could not be decoded. Return a complete image.'); });
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    if (!['png', 'jpg', 'webp'].includes(extension ?? '') || !metadata.width || !metadata.height) {
      throw new ChromeConnectorError('image_export_invalid', 'Expected a PNG, JPEG or WebP image.');
    }
    // Decode, not only the file header: incomplete PNG data is not a finished image.
    await decoded.stats().catch(() => { throw new ChromeConnectorError('image_export_invalid', 'The returned image is incomplete or corrupt.'); });
    signal?.throwIfAborted();
    const mimeType = `image/${metadata.format}`;
    const directory = this.directory(scope);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `${digest(bytes)}.${extension}`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', signal }); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    return { image: { data: encoded, mimeType }, width: metadata.width, height: metadata.height,
      artifact: { path: file, name: `capture.${extension}`, type: 'image', mimeType, size: bytes.length, display: 'inline' } satisfies BrowserArtifact };
  }

  async download(scope: string, taskId: string, source: string) {
    if (!path.isAbsolute(source)) throw new ChromeConnectorError('download_path_invalid', 'Chrome did not return an absolute completed-file path.');
    const directory = path.join(this.directory(scope), digest(taskId).slice(0, 24));
    const file = path.join(directory, path.basename(source));
    const cached = await stat(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined; });
    if (cached?.isFile()) return { path: file, name: path.basename(file), type: 'document', size: cached.size, display: 'attachment' } satisfies BrowserArtifact;
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile()) throw new ChromeConnectorError('download_path_invalid', 'The completed download is not a file.');
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await copyFile(source, temporary); await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
    return { path: file, name: path.basename(file), type: 'document', size: sourceInfo.size, display: 'attachment' } satisfies BrowserArtifact;
  }
}

export function exportedImage(value: unknown): { data: string; mimeType: string } {
  // This is an explicit image-output contract, not a search through arbitrary tool prose.
  for (let count = 0; count < 2 && typeof value === 'string' && !value.startsWith('data:'); count++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (typeof object.data === 'string' && typeof object.mimeType === 'string' && /^image\/(png|jpeg|webp)$/.test(object.mimeType)) return { data: object.data, mimeType: object.mimeType };
    value = object.dataURL ?? object.url;
  }
  if (typeof value === 'string') {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([\s\S]+)$/.exec(value);
    if (match) return { mimeType: match[1]!, data: match[2]! };
  }
  throw new ChromeConnectorError('image_export_invalid', 'Return a PNG/JPEG/WebP data URL or {data, mimeType}. Do not click a download link.');
}

export function digest(value: string | Buffer) { return createHash('sha256').update(value).digest('hex'); }
