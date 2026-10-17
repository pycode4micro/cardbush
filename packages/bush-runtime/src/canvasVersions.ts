import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canvasContent, replaceCanvasContent, type CanvasItem } from '@cardbush/bush-protocol';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { parse, postprocess, preprocess } from 'micromark';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes } from 'mdast';

/** IO is supplied by the host. Agent calls use permission-checked, reviewable file tools. */
export type CanvasVersionIO = { read: (path: string) => Promise<Buffer>; write: (path: string, data: Buffer) => Promise<void> };
export async function captureCanvasVersion(item: CanvasItem, manifest: string, io: CanvasVersionIO): Promise<CanvasItem> {
  if (item.fixed) return item;
  const folder = `canvas-versions/${randomUUID()}`, root = dirname(manifest), copied = new Map<string, string>();
  const revisions = new Map<string, string>(), digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  let bytes = 0;
  const localPath = (source: string, base: string) => {
    if (/^file:/i.test(source)) return fileURLToPath(source);
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(source) && !/^[a-z]:[\\/]/i.test(source))
      throw Error('请先保存为本地文件或引用选区快照，再固定版本。 / Save external content locally or capture an excerpt before freezing.');
    return resolve(base, source);
  };
  const copy = async (source: string, base: string): Promise<string> => {
    const original = localPath(source, base);
    if (copied.has(original)) return copied.get(original)!;
    const destination = `${copied.size + 1}-${basename(original)}`;
    if (copied.size >= 200) throw Error('Version exceeds 200 files.');
    copied.set(original, destination);
    const data = await io.read(original); bytes += data.length;
    if (bytes > 128 * 1024 * 1024) throw Error('Version exceeds 128 MiB.');
    revisions.set(original, digest(data));
    const extension = extname(original).toLowerCase();
    const captured = ['.html', '.htm', '.css', '.md', '.markdown', '.js', '.mjs'].includes(extension)
      ? Buffer.from(await rewriteCanvasResources(data.toString('utf8'), (value, usage) => resource(value, dirname(original), false, usage), resourceFormat(extension))) : data;
    await io.write(resolve(root, folder, destination), captured);
    return destination;
  };
  const resource = async (value: string, base: string, inline: boolean, usage?: 'link' | 'asset') => {
    if (!value || /^(?:#|data:|mailto:|tel:)/i.test(value)) return value;
    if (usage === 'link' && /^(?:https?:|\/\/)/i.test(value)) return value;
    const [file, suffix = ''] = value.split(/(?=[?#])/s, 2);
    const target = await copy(decodeURIComponent(file), base);
    return (inline ? `${folder}/` : '') + encodeURIComponent(target) + suffix;
  };
  let content = canvasContent(item);
  if (item.kind === 'file' && !/^data:/i.test(item.source)) content = { kind: 'file', source: `${folder}/${await copy(item.source, root)}` };
  if (item.kind === 'markdown') content = { kind: 'markdown', markdown: await rewriteCanvasResources(item.markdown, (value, usage) => resource(value, root, true, usage), 'markdown') };
  for (const [path, revision] of revisions) if (digest(await io.read(path)) !== revision)
    throw Error('CANVAS_SOURCE_CHANGED: source changed while capturing. Retry to keep a consistent version.');
  let original = canvasContent(item);
  // Provenance must still refer to the original after exporting or moving the canvas.
  if (original.kind === 'file' && !/^data:/i.test(original.source)) original = { kind: 'file', source: localPath(original.source, root) };
  if (original.kind === 'markdown') original = { kind: 'markdown', markdown: await rewriteCanvasResources(original.markdown, async value => {
    if (!value || /^(?:#|https?:|data:|mailto:|tel:|\/\/)/i.test(value)) return value;
    const [file, suffix = ''] = value.split(/(?=[?#])/s, 2);
    return pathToFileURL(localPath(decodeURIComponent(file), root)).href + suffix;
  }, 'markdown') };
  // HTML components are already self-contained, isolated documents. Freeze their source version.
  return { ...replaceCanvasContent(item, content), fixed: { capturedAt: new Date().toISOString(), original } };
}
export function releaseCanvasVersion(item: CanvasItem): CanvasItem {
  if (!item.fixed) return item;
  const result = replaceCanvasContent(item, item.fixed.original);
  delete result.fixed;
  return result;
}

/** Shared by portable export and fixed versions; explicit dependencies only, never directory copies. */
type ResourceRewriter = (value: string, usage?: 'link' | 'asset') => Promise<string>;
export function resourceFormat(extension: string): 'markdown' | 'javascript' | 'web' {
  return /\.(md|markdown)$/i.test(extension) ? 'markdown' : /\.m?js$/i.test(extension) ? 'javascript' : 'web';
}

/** Syntax examples, escaped markup and unused definitions are not file dependencies.
 * AST nodes identify real resources; tokenizer offsets let us change only their URLs,
 * preserving labels, titles, code examples and all surrounding document formatting. */
async function rewriteMarkdownResources(text: string, replace: ResourceRewriter) {
  // Match the renderer's GFM grammar, especially footnotes (not link definitions).
  const options = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };
  const tree = fromMarkdown(text, options), resources: Array<{ start: number; end: number; url: string; usage: 'link' | 'asset' }> = [];
  const definitions = new Map<string, Extract<Nodes, { type: 'definition' }>>();
  const references = new Map<string, 'link' | 'asset'>(), html: Array<{ start: number; end: number }> = [];
  const visit = (node: Nodes) => {
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'definition') { if (!definitions.has(node.identifier)) definitions.set(node.identifier, node); }
    if (node.type === 'imageReference' || node.type === 'linkReference')
      references.set(node.identifier, node.type === 'imageReference' || references.get(node.identifier) === 'asset' ? 'asset' : 'link');
    if (node.type === 'image' || node.type === 'link') resources.push({ start, end, url: node.url, usage: node.type === 'image' ? 'asset' : 'link' });
    if (node.type === 'html') html.push({ start, end });
    if ('children' in node) node.children.forEach(visit);
  };
  visit(tree);
  for (const [identifier, usage] of references) {
    const node = definitions.get(identifier);
    if (node) resources.push({ start: node.position!.start.offset!, end: node.position!.end.offset!, url: node.url, usage });
  }
  const edits: Array<{ start: number; end: number; value: string }> = [];
  resources.sort((a, b) => a.start - b.start || b.end - a.end);
  const owners: typeof resources = []; let nextResource = 0;
  const events = postprocess(parse(options).document().write(preprocess()(text, 'utf8', true)));
  for (const [event, token] of events) {
    if (event !== 'enter' || !['resourceDestinationString', 'definitionDestinationString'].includes(token.type)) continue;
    // An image can itself be the label of a link; the innermost node owns its URL.
    // Both streams are ordered; avoid rescanning every link in large documents.
    while (owners.length && owners.at(-1)!.end < token.end.offset) owners.pop();
    while (nextResource < resources.length && resources[nextResource].start <= token.start.offset) {
      const node = resources[nextResource++];
      if (node.end >= token.end.offset) owners.push(node);
    }
    const resource = owners.at(-1);
    if (!resource) continue;
    const value = await replace(resource.url, resource.usage);
    if (value !== resource.url) edits.push({ start: token.start.offset, end: token.end.offset, value: value.replace(/[<>\s\\()]/g, char => char === '(' ? '%28' : char === ')' ? '%29' : encodeURIComponent(char)) });
  }
  for (const range of html) {
    const source = text.slice(range.start, range.end);
    // HTML comments also occur in Markdown tutorials.
    if (source.startsWith('<!--')) continue;
    const value = await rewriteCanvasResources(source, replace, 'web');
    if (value !== source) edits.push({ ...range, value });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
  return text;
}

export async function rewriteCanvasResources(text: string, replace: ResourceRewriter, format: 'markdown' | 'javascript' | 'web' = 'web'): Promise<string> {
  if (format === 'markdown') return rewriteMarkdownResources(text, replace);
  const javascript = format === 'javascript';
  const pattern = javascript
    ? /(?:\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s+)?|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
    : /(?:\b(?:src|href|poster)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^\s)'";]+)["']?\s*\)|@import\s+["']([^"']+)["'])/gi;
  const matches = [...text.matchAll(pattern)];
  for (const match of matches.reverse()) {
    const value = match[1] ?? match[2] ?? match[3];
    const link = /^href\b/i.test(match[0]) && /^<a\b/i.test(text.slice(text.lastIndexOf('<', match.index), match.index));
    let result = await replace(value, link ? 'link' : 'asset');
    if (javascript && !/^(?:\.{1,2}\/|\/|[a-z][\w+.-]*:)/i.test(result)) result = './' + result;
    text = text.slice(0, match.index) + match[0].replace(value, () => result) + text.slice(match.index! + match[0].length);
  }
  if (!javascript) for (const match of [...text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)].reverse()) {
    if (/data:/i.test(match[1])) continue;
    const entries = await Promise.all(match[1].split(',').map(async entry => { const [url, ...descriptor] = entry.trim().split(/\s+/); return [await replace(url), ...descriptor].join(' '); }));
    text = text.slice(0, match.index) + match[0].replace(match[1], () => entries.join(', ')) + text.slice(match.index! + match[0].length);
  }
  return text;
}
