// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// Libraries are loaded only inside a document job, not in the agent or MCP handshake.
export async function libraries(kind) {
  const [{ default: JSZip }, xml] = await Promise.all([import('jszip'), import('@xmldom/xmldom')]);
  const common = { JSZip, ...xml, fs: await import('node:fs/promises') };
  if (kind === 'xlsx') return { ...common, ExcelJS: (await import('exceljs')).default };
  if (kind === 'pptx') return { ...common, PptxGenJS: (await import('pptxgenjs')).default };
  if (kind === 'docx') return { ...common, docx: await import('docx') };
  if (kind === 'pdf') return { ...common, PDFLib: await import('pdf-lib'), fontkit: (await import('@pdf-lib/fontkit')).default };
  throw new Error(`Unsupported document kind: ${kind}`);
}

export async function pdfReader(bytes) {
  const canvas = await import('@napi-rs/canvas');
  for (const key of ['DOMMatrix', 'ImageData', 'Path2D']) globalThis[key] ??= canvas[key];
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  // PDF.js's Node factories read local paths; no CDN/font/codec downloads at render time.
  const asset = name => join(root, name) + '/';
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true,
    cMapUrl: asset('cmaps'), cMapPacked: true, standardFontDataUrl: asset('standard_fonts'), wasmUrl: asset('wasm'),
    disableFontFace: true, verbosity: 0 });
  try { return { document: await loading.promise, canvas, close: () => loading.destroy() }; }
  catch (error) { await loading.destroy(); throw error; }
}
