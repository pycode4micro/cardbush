import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CANVAS_FILE_NAME, CANVAS_MAX_BYTES, creationCanvasSchema, emptyCanvas, serializeCanvas, type CanvasSnapshot, type CreationCanvas } from '@cardbush/bush-protocol';
import { withCanvasFileLock } from '@cardbush/bush-runtime';
import { replaceFileWithRetry } from './atomicJsonFile.mjs';

export type CanvasFileRequest =
  | { action: 'create'; root: string; document?: CreationCanvas }
  | { action: 'read'; path: string }
  | { action: 'save'; path: string; expectedRevision: string; document: CreationCanvas }
  | { action: 'image'; path: string; data: string }
  | { action: 'open' }
  | { action: 'export'; path: string; expectedRevision: string };
export type CanvasFileResponse = CanvasSnapshot | { path: string } | null;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const serialize = serializeCanvas;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export async function readCanvas(file: string): Promise<CanvasSnapshot> {
  if (!path.isAbsolute(file) || !file.endsWith('.canvas.json')) throw Error('Choose a .canvas.json file.');
  if ((await fs.stat(file)).size > CANVAS_MAX_BYTES) throw Error('Canvas exceeds the 8 MiB limit.');
  const raw = await fs.readFile(file, 'utf8');
  const document = creationCanvasSchema.parse(JSON.parse(raw));
  const versions = await Promise.all(document.items.map(async item => {
    if (item.kind !== 'file' || /^(?:https?:|ssh:|data:)/i.test(item.source)) return [];
    try {
      const target = /^file:/i.test(item.source) ? fileURLToPath(item.source) : path.resolve(path.dirname(file), item.source);
      const stats = await fs.stat(target); return [[item.id, `${stats.mtimeMs}:${stats.size}`]];
    } catch { return [[item.id, 'missing']]; }
  }));
  return { path: file, revision: digest(raw), document, resources: Object.fromEntries(versions.flat()) };
}

export class CreationCanvasFiles {
  constructor(private choose: (action: 'open' | 'export') => Promise<string | undefined>) {}
  async command(input: CanvasFileRequest): Promise<CanvasFileResponse> {
    if (!input || typeof input !== 'object') throw Error('Invalid canvas request.');
    if (input.action === 'open') { const selected = await this.choose('open'); return selected ? readCanvas(selected) : null; }
    if (input.action === 'create') {
      if (!path.isAbsolute(input.root) || !(await fs.stat(input.root)).isDirectory()) throw Error('Canvas workspace is unavailable.');
      const target = path.join(input.root, CANVAS_FILE_NAME);
      try { await fs.writeFile(target, serialize(input.document ?? emptyCanvas()), { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return readCanvas(target);
    }
    if (input.action === 'read') return readCanvas(input.path);
    if (input.action === 'save') {
      const content = serialize(input.document);
      return withCanvasFileLock(input.path, async () => {
        const current = await readCanvas(input.path);
        if (current.revision !== input.expectedRevision) throw Error('CANVAS_REVISION_CONFLICT: 画板已有新修改，请刷新后重试。');
        const temporary = `${input.path}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, content, { flag: 'wx' }); await replaceFileWithRetry(temporary, input.path, async () => {
          if (digest(await fs.readFile(input.path, 'utf8')) !== input.expectedRevision) throw Error('CANVAS_REVISION_CONFLICT: 画板已有新修改，请刷新后重试。');
        }); }
        finally { await fs.unlink(temporary).catch(() => {}); }
        return readCanvas(input.path);
      });
    }
    if (input.action === 'image') {
      await readCanvas(input.path);
      if (typeof input.data !== 'string' || input.data.length > 28 * 1024 * 1024 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(input.data)) throw Error('Invalid PNG snapshot.');
      const bytes = Buffer.from(input.data.slice(input.data.indexOf(',') + 1), 'base64');
      if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('Invalid PNG snapshot.');
      const directory = path.join(path.dirname(input.path), 'canvas-assets'); await fs.mkdir(directory, { recursive: true });
      const target = path.join(directory, `${randomUUID()}.png`); await fs.writeFile(target, bytes, { flag: 'wx' }); return { path: target };
    }
    if (input.action === 'export') {
      const current = await readCanvas(input.path);
      if (current.revision !== input.expectedRevision) throw Error('CANVAS_REVISION_CONFLICT: 请刷新画板后重新导出。');
      const directory = await this.choose('export');
      return directory ? { path: await exportCanvas(current, directory) } : null;
    }
    throw Error('Unknown canvas action.');
  }
}

/** Copies only referenced files and their explicit local resource dependencies. */
export async function exportCanvas(snapshot: CanvasSnapshot, parent: string) {
  if (!path.isAbsolute(parent)) throw Error('Choose an export folder.');
  const name = (snapshot.document.title || '创作空间').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60).replace(/[. ]+$/, '') || 'Canvas';
  const folder = await fs.mkdtemp(path.join(parent, name + '-'));
  const assets = path.join(folder, 'assets'); await fs.mkdir(assets);
  const copied = new Map<string, string>(); let bytes = 0;
  const copy = async (source: string, relativeTo: string): Promise<string> => {
    if (/^https?:\/\//i.test(source)) return source;
    if (/^data:/i.test(source)) return source;
    if (/^file:/i.test(source)) source = fileURLToPath(source);
    if (/^[a-z][\w+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw Error(`Unsupported file reference: ${source}`);
    const original = await fs.realpath(path.resolve(relativeTo, source));
    if (copied.has(original)) return copied.get(original)!;
    const info = await fs.stat(original);
    if (!info.isFile()) throw Error(`Not a file: ${source}`);
    bytes += info.size;
    if (copied.size >= 500 || bytes > 1024 * 1024 * 1024) throw Error('Export exceeds 500 files or 1 GiB.');
    const basename = `${copied.size + 1}-${path.basename(original).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}`;
    const destination = 'assets/' + basename; copied.set(original, destination);
    const extension = path.extname(original).toLowerCase();
    if (['.html', '.htm', '.css', '.md', '.markdown', '.js', '.mjs'].includes(extension) && info.size < 4 * 1024 * 1024) {
      const text = await fs.readFile(original, 'utf8');
      const portable = await rewriteResources(text, async value => {
        if (!value || /^(?:#|https?:|data:|mailto:|tel:|\/\/)/i.test(value)) return value;
        const [file, suffix = ''] = value.split(/(?=[?#])/s, 2);
        const result = await copy(decodeURIComponent(file), path.dirname(original));
        return result.startsWith('assets/') ? result.slice(7).split('/').map(encodeURIComponent).join('/') + suffix : result;
      }, extension === '.js' || extension === '.mjs');
      await fs.writeFile(path.join(folder, destination), portable);
    } else await fs.copyFile(original, path.join(folder, destination));
    return destination;
  };
  try {
    const document = structuredClone(snapshot.document);
    for (const item of document.items) {
      if (item.kind === 'file') item.source = await copy(item.source, path.dirname(snapshot.path));
      if (item.kind === 'markdown') item.markdown = await rewriteResources(item.markdown, async value => {
        if (!value || /^(?:#|https?:|data:|mailto:|tel:|\/\/)/i.test(value)) return value;
        const [file, suffix = ''] = value.split(/(?=[?#])/s, 2);
        return (await copy(decodeURIComponent(file), path.dirname(snapshot.path))).split('/').map(encodeURIComponent).join('/') + suffix;
      });
      if (item.reference) item.reference.source = await copy(item.reference.source, path.dirname(snapshot.path));
    }
    await fs.writeFile(path.join(folder, CANVAS_FILE_NAME), serialize(document));
    await fs.writeFile(path.join(folder, 'index.html'), canvasExportHtml(document));
    await fs.writeFile(path.join(folder, 'README.txt'), '在 CardBush 创作中打开 space.canvas.json 可继续编辑完整画板。\nindex.html 可在浏览器查看 HTML、图片、PDF 和媒体；Office 文件请在 CardBush 中查看。\n外部网页仍需要联网。文件选区为带来源信息的快照。\n');
    return folder;
  } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
}

async function rewriteResources(text: string, replace: (value: string) => Promise<string>, javascript = false) {
  const pattern = javascript
    ? /(?:\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s+)?|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
    : /(?:\b(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)["']?\s*\)|!?\[[^\]]*\]\(([^\s)]+)\)|@import\s+["']([^"']+)["'])/gi;
  const matches = [...text.matchAll(pattern)];
  for (const match of matches.reverse()) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4];
    let result = await replace(value);
    if (javascript && !/^(?:\.{1,2}\/|\/|[a-z][\w+.-]*:)/i.test(result)) result = './' + result;
    text = text.slice(0, match.index) + match[0].replace(value, result) + text.slice(match.index! + match[0].length);
  }
  if (!javascript) for (const match of [...text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)].reverse()) {
    if (/data:/i.test(match[1])) continue;
    const entries = await Promise.all(match[1].split(',').map(async entry => { const [url, ...descriptor] = entry.trim().split(/\s+/); return [await replace(url), ...descriptor].join(' '); }));
    text = text.slice(0, match.index) + match[0].replace(match[1], entries.join(', ')) + text.slice(match.index! + match[0].length);
  }
  return text;
}
function canvasExportHtml(document: CreationCanvas) {
  const items = document.items.map(item => {
    const frame = item.frame;
    const url = item.kind === 'file' ? escapeHtml(/^(?:https?:|data:)/i.test(item.source) ? item.source : item.source.split('/').map(encodeURIComponent).join('/')) : '';
    const extension = item.kind === 'file' ? path.extname(item.source).toLowerCase() : '';
    const content = item.kind === 'html' ? `<iframe sandbox="allow-scripts" srcdoc="${escapeHtml(item.html)}"></iframe>`
      : item.kind === 'markdown' ? `<pre>${escapeHtml(item.markdown)}</pre>`
      : /\.(png|jpe?g|webp|gif|svg|avif)$/.test(extension) ? `<img src="${url}" alt="${escapeHtml(item.title)}">`
      : /\.(mp4|webm|mov)$/.test(extension) ? `<video controls src="${url}"></video>`
      : /\.(mp3|wav|ogg|m4a|flac)$/.test(extension) ? `<audio controls src="${url}"></audio>`
      : /\.(pdf|html?)$/.test(extension) ? `<iframe sandbox="allow-scripts" src="${url}"></iframe>`
      : `<a href="${url}">${escapeHtml(item.title || '打开文件 / Open file')}</a>`;
    return `<section style="left:${frame.x}px;top:${frame.y}px;width:${frame.width}px;height:${frame.height}px">${content}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(document.title)}</title><style>body{margin:0;background:${document.background};color:#eee;font:16px system-ui}main{position:relative;width:${document.width}px;height:${document.height}px}section{position:absolute;overflow:auto}iframe,img,video{width:100%;height:100%;object-fit:contain;border:0}pre{white-space:pre-wrap;margin:20px}a{color:#9cc7ff}</style></head><body><main>${items}</main></body></html>`;
}
