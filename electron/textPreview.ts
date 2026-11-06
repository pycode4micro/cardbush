import { uiText } from '@cardbush/platform/i18n';
import { renderHtmlTemplate } from '@cardbush/platform/templates';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { readHandleBytes } from './fileRead';

export const maxPreviewBytes = 2 * 1024 * 1024;
type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'utf-32le' | 'utf-32be' | 'gb18030';

export class TextPreviewError extends Error {
  constructor(readonly code: 'text_preview_binary' | 'text_preview_encoding', message: string) {
    super(`[${code}] ${message}`);
  }
}

function binaryError(): never {
  throw new TextPreviewError('text_preview_binary', 'Preview target is not a text file.');
}

function encodingError(): never {
  throw new TextPreviewError('text_preview_encoding', 'The text encoding is unsupported or the file contains invalid encoded characters.');
}

function hasBinarySignature(bytes: Buffer): boolean {
  return [
    '89504e470d0a1a0a', 'ffd8ff', '474946383761', '474946383961', // PNG/JPEG/GIF
    '504b0304', '504b0506', '504b0708', '255044462d', // ZIP/PDF
    'd0cf11e0a1b11ae1', '7f454c46', '1f8b08', '52617221', '377abcaf271c',
  ].some(hex => bytes.subarray(0, hex.length / 2).toString('hex') === hex);
}

function assertText(content: string): void {
  // Check decoded characters, not UTF-16/32 code-unit padding.
  if (content.includes('\0')) binaryError();
  const controls = content.match(/[\u0001-\u0008\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g)?.length ?? 0;
  if (controls > Math.max(0, content.length * 0.01)) binaryError();
}

function bomEncoding(bytes: Buffer): TextEncoding | undefined {
  if (bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0]))) return 'utf-32le';
  if (bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff]))) return 'utf-32be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  return undefined;
}

function bomlessUtf16Encoding(bytes: Buffer): TextEncoding | undefined {
  const pairs = Math.floor(Math.min(bytes.length, 8192) / 2);
  if (pairs < 4) return undefined;
  let evenZeros = 0, oddZeros = 0;
  for (let index = 0; index < pairs * 2; index += 2) {
    if (bytes[index] === 0) evenZeros += 1;
    if (bytes[index + 1] === 0) oddZeros += 1;
  }
  // Only infer the endian order when one byte lane has a strong zero-padding signal.
  if (oddZeros >= 4 && oddZeros / pairs >= 0.3 && evenZeros / pairs <= 0.1) return 'utf-16le';
  if (evenZeros >= 4 && evenZeros / pairs >= 0.3 && oddZeros / pairs <= 0.1) return 'utf-16be';
  return undefined;
}

function decode(bytes: Buffer, encoding: TextEncoding, truncated: boolean): string {
  if (encoding === 'utf-32le' || encoding === 'utf-32be') {
    if (!truncated && bytes.length % 4 !== 0) encodingError();
    const characters: string[] = [];
    for (let index = 4; index + 4 <= bytes.length; index += 4) {
      const code = encoding === 'utf-32le' ? bytes.readUInt32LE(index) : bytes.readUInt32BE(index);
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) encodingError();
      characters.push(String.fromCodePoint(code));
    }
    return characters.join('');
  }
  // Streaming mode withholds an incomplete last character only at the preview limit.
  // A genuinely malformed complete file remains an error instead of silent U+FFFD.
  return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: truncated });
}

function permitsLegacyText(filePath: string): boolean {
  return /\.(?:txt|log|md|markdown|csv|tsv|json|jsonl|xml|html?|ini|conf|cfg|properties|ya?ml|toml|sql|ps1|bat|cmd|py|[cm]?[jt]sx?|css)$/i.test(filePath)
    || /^(?:readme|license|changelog)$/i.test(path.basename(filePath));
}

export function decodeTextPreview(bytes: Buffer, filePath: string, truncated = false) {
  if (hasBinarySignature(bytes)) binaryError();
  const detected = bomEncoding(bytes) ?? bomlessUtf16Encoding(bytes);
  // NUL bytes in non-Unicode-padded content are binary, even if decoding would
  // fail first. Do not misreport binary files as damaged text.
  if (!detected && bytes.includes(0)) binaryError();
  let encoding: TextEncoding = detected ?? 'utf-8';
  let content: string;
  try {
    content = decode(bytes, encoding, truncated);
  } catch {
    // Do not override an explicit Unicode BOM or treat arbitrary binary as ANSI.
    if (detected || !permitsLegacyText(filePath)) encodingError();
    encoding = 'gb18030';
    try { content = decode(bytes, encoding, truncated); } catch { encodingError(); }
  }
  assertText(content);
  return { content, encoding };
}

async function readPreviewBytes(filePath: string) {
  const handle = await open(filePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('Preview target is not a file.');
    // One extra byte distinguishes an actual preview boundary from a complete file.
    const bytes = await readHandleBytes(handle, Math.min(stats.size, maxPreviewBytes + 1));
    return {
      bytes: bytes.subarray(0, maxPreviewBytes),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      truncated: bytes.length > maxPreviewBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function readTextPreview(filePath: string) {
  const { bytes, ...metadata } = await readPreviewBytes(filePath);
  return { path: filePath, ...decodeTextPreview(bytes, filePath, metadata.truncated), ...metadata };
}

/** Expected preview limitations cross IPC as data, preserving their error code. */
export async function readTextPreviewResult(filePath: string) {
  try {
    return { ok: true as const, value: await readTextPreview(filePath) };
  } catch (error) {
    if (!(error instanceof TextPreviewError)) throw error;
    return { ok: false as const, error: { code: error.code, message: error.message } };
  }
}

export async function renderTextFilePreview(filePath: string, previewError = '', language = 'en') {
  const nativeText = () => uiText(language);
  const { bytes, truncated } = await readPreviewBytes(filePath);
  let text: string;
  let notice: string;
  try {
    const decoded = decodeTextPreview(bytes, filePath, truncated);
    text = decoded.content;
    notice = [decoded.encoding.toUpperCase(), truncated ? nativeText()("template.textTruncated") : nativeText()("template.textPreview")].join(' · ');
  } catch (error) {
    if (!(error instanceof TextPreviewError)) throw error;
    text = Array.from(bytes.subarray(0, 4096))
      .map((value, index) => `${index % 16 === 0 ? `\n${index.toString(16).padStart(8, '0')}  ` : ''}${value.toString(16).padStart(2, '0')} `)
      .join('').trim();
    notice = error.code === 'text_preview_binary'
      ? nativeText()("template.binary")
      : nativeText()("template.undecodable");
  }
  if (previewError) notice = nativeText()('template.previewFailed', { error: previewError, notice });
  return renderHtmlTemplate('text-preview', { title: path.basename(filePath),
    path: filePath,
    notice,
    content: text,
    language: language });
}
