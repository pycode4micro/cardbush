import { app, BrowserWindow, nativeImage, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkOfficePreviewAdmission } from './officePreviewAdmission';

type Request = { path: string; output: string; pages?: number[]; width?: number; columns?: number; expected_sha256?: string };
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export async function runPresentationExport() {
  const at = process.argv.indexOf('--cardbush-presentation-export');
  const [job, receipt] = process.argv.slice(at + 1);
  let window: BrowserWindow | undefined;
  let exitCode = 0;
  const renderErrors: string[] = [];
  const profile = app.getPath('userData');
  try {
    const request: Request = JSON.parse(await fs.readFile(job, 'utf8'));
    const source = path.resolve(request.path), output = path.resolve(request.output);
    if (path.extname(source).toLowerCase() !== '.pptx' || path.extname(output).toLowerCase() !== '.png') {
      throw Error('Presentation export requires a PPTX source and a new PNG output.');
    }
    const width = request.width ?? 1440, columns = request.columns ?? 3, pages = request.pages ?? [1];
    if (!Number.isInteger(width) || width < 320 || width > 3840 || !Number.isInteger(columns) || columns < 1 || columns > 8 ||
        !Array.isArray(pages) || pages.length < 1 || pages.length > 50 || pages.some(page => !Number.isInteger(page) || page < 1) ||
        new Set(pages).size !== pages.length) throw Error('Invalid presentation export dimensions or page selection.');
    await checkOfficePreviewAdmission(source);
    const bytes = await fs.readFile(source), originalHash = hash(bytes);
    if (request.expected_sha256 && request.expected_sha256 !== originalHash) throw Error('Presentation changed since inspection.');
    await app.whenReady();
    const dist = path.resolve(__dirname, '..', 'dist');
    protocol.handle('cardbush-file', async event => {
      const url = new URL(event.url);
      if (url.hostname === 'office-source' && path.resolve(url.searchParams.get('path') ?? '') === source) {
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation' } });
      }
      if (url.hostname !== 'office-preview') return new Response('Not found', { status: 404 });
      const relative = url.pathname.startsWith('/assets/') ? decodeURIComponent(url.pathname).slice(1) : 'office-preview.html';
      const asset = path.resolve(dist, relative), inside = path.relative(dist, asset);
      if (inside.startsWith('..') || path.isAbsolute(inside)) return new Response('Not found', { status: 404 });
      const type = path.extname(asset) === '.html' ? 'text/html' : path.extname(asset) === '.css' ? 'text/css' :
        path.extname(asset) === '.wasm' ? 'application/wasm' : path.extname(asset) === '.js' ? 'text/javascript' : 'application/octet-stream';
      return new Response(new Uint8Array(await fs.readFile(asset)), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
    });
    window = new BrowserWindow({ width, height: 900, show: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    window.webContents.on('console-message', details => {
      if (details.level === 'error') renderErrors.push(details.message.slice(0, 500));
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
    await window.loadURL(`cardbush-file://office-preview/?path=${encodeURIComponent(source)}&export=png`);
    const slides: Array<{ page: number; width: number; height: number }> = await window.webContents.executeJavaScript(`
      (async () => {
        const deadline = Date.now() + 60000;
        while (!window.cardbushPresentationExport) {
          const error = document.querySelector('.office-preview-error:not([hidden])');
          if (error) throw Error(error.textContent);
          if (Date.now() > deadline) throw Error('Presentation render timed out.');
          await new Promise(resolve => setTimeout(resolve, 40));
        }
        return window.cardbushPresentationExport.prepare();
      })()`);
    for (const page of pages) if (!slides[page - 1]) throw Error(`Slide ${page} does not exist.`);
    const heights = pages.map(page => Math.round(width * slides[page - 1].height / slides[page - 1].width));
    const cols = Math.min(columns, pages.length), rows = Math.ceil(pages.length / cols), gap = pages.length === 1 ? 0 : 12;
    const cellHeight = Math.max(...heights), sheetWidth = cols * width + (cols - 1) * gap, sheetHeight = rows * cellHeight + (rows - 1) * gap;
    if (!(sheetWidth > 0 && sheetHeight > 0) || sheetWidth * sheetHeight > 32_000_000) throw Error('PNG export exceeds 32 million pixels; select fewer slides or a smaller width.');
    const bitmap = Buffer.alloc(sheetWidth * sheetHeight * 4, 255);
    for (const [index, page] of pages.entries()) {
      window.setContentSize(width, heights[index]);
      const bounds = await window.webContents.executeJavaScript(`window.cardbushPresentationExport.show(${page},${width})`);
      window.webContents.invalidate();
      const image = await window.webContents.capturePage(bounds);
      if (image.isEmpty() || image.getSize().width !== width || image.getSize().height !== heights[index]) throw Error('Presentation capture returned unexpected dimensions.');
      const pixels = image.toBitmap(), left = (index % cols) * (width + gap), top = Math.floor(index / cols) * (cellHeight + gap);
      for (let row = 0; row < heights[index]; row++) pixels.copy(bitmap, ((top + row) * sheetWidth + left) * 4, row * width * 4, (row + 1) * width * 4);
    }
    if (hash(await fs.readFile(source)) !== originalHash) throw Error('Presentation changed while rendering.');
    const png = nativeImage.createFromBitmap(bitmap, { width: sheetWidth, height: sheetHeight, scaleFactor: 1 }).toPNG();
    await fs.writeFile(output, png, { flag: 'wx' });
    await fs.writeFile(receipt, JSON.stringify({ ok: true, result: { engine: 'CardBush PPTX / Chromium', source_sha256: originalHash,
      pages, slideCount: slides.length, width: sheetWidth, height: sheetHeight, bytes: png.length } }));
    window.destroy(); window = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (receipt) await fs.writeFile(receipt, JSON.stringify({ ok: false, error: [message, ...renderErrors.slice(-3)].join('\n') }));
    exitCode = 1;
  } finally {
    window?.destroy();
    if (path.basename(profile).startsWith('.cardbush-presentation-export-') && path.dirname(path.resolve(profile)) === path.dirname(path.resolve(job))) {
      await fs.rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
    app.exit(exitCode);
  }
}
