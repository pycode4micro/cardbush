import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type ImportedBookmark = { url: string; title: string; folder?: string };
export type BrowserProfile = { id: string; browser: 'chrome' | 'edge'; name: string };
export type BookmarkImportResult = { bookmarks: ImportedBookmark[]; skipped: number };

export function browserWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const url = new URL(value);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Ignore non-web bookmarks. */ }
}

const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw, code: string) => {
  if (code[0] !== '#') return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' } as Record<string, string>)[code.toLowerCase()] ?? raw;
  const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
  return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : raw;
});

/** Parse data only. Exported HTML is never opened in a browser or executed. */
export function parseBrowserBookmarks(text: string): BookmarkImportResult {
  const bookmarks: ImportedBookmark[] = [], seen = new Set<string>();
  let skipped = 0;
  const add = (input: unknown, title: unknown, folders: string[]) => {
    const url = browserWebUrl(input);
    if (!url || seen.has(url)) { skipped++; return; }
    seen.add(url);
    bookmarks.push({ url, title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 300) : new URL(url).host,
      ...(folders.length ? { folder: folders.join(' / ').slice(0, 1000) } : {}) });
  };
  const source = text.replace(/^\uFEFF/, '').trim();
  if (source.startsWith('{') || source.startsWith('[')) {
    const data = JSON.parse(source);
    if (!data?.roots || typeof data.roots !== 'object') throw Error('请选择 Chrome / Edge 的 Bookmarks 文件或导出的 HTML 收藏夹。Select a Bookmarks or exported HTML file.');
    const pending: Array<{ node: any; folders: string[] }> = Object.values(data.roots).reverse().map(node => ({ node, folders: [] }));
    while (pending.length) {
      const { node, folders } = pending.pop()!;
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'url') add(node.url, node.name, folders);
      else if (Array.isArray(node.children)) {
        const next = typeof node.name === 'string' && node.name ? [...folders, node.name] : folders;
        for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], folders: next.slice(-32) });
      }
    }
  } else {
    if (!/NETSCAPE-Bookmark-file|<DL\b/i.test(source)) throw Error('无法识别收藏夹文件。Unrecognized bookmark file.');
    const folders: string[] = [];
    let pendingFolder = '';
    for (const match of source.matchAll(/<DL\b[^>]*>|<\/DL\s*>|<H3\b[^>]*>([\s\S]*?)<\/H3\s*>|<A\b([^>]*?)>([\s\S]*?)<\/A\s*>/gi)) {
      if (/^<DL\b/i.test(match[0])) { folders.push(pendingFolder); pendingFolder = ''; }
      else if (/^<\/DL/i.test(match[0])) folders.pop();
      else if (match[1] !== undefined) pendingFolder = decode(match[1].replace(/<[^>]*>/g, '')).trim();
      else {
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2]);
        add(decode(href?.[1] ?? href?.[2] ?? href?.[3] ?? ''), decode(match[3].replace(/<[^>]*>/g, '')), folders.filter(Boolean));
      }
    }
  }
  return { bookmarks, skipped };
}

async function readExport(file: string) {
  const info = await stat(file);
  if (!info.isFile() || info.size > 40 * 1024 * 1024) throw Error('收藏夹文件必须小于 40 MB。Bookmark files must be smaller than 40 MB.');
  return readFile(file, 'utf8');
}

export class BrowserBookmarkImporter {
  constructor(private readonly roots: Record<'chrome' | 'edge', string> = process.platform === 'win32'
    ? { chrome: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'), edge: join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data') }
    : process.platform === 'darwin'
      ? { chrome: join(homedir(), 'Library/Application Support/Google/Chrome'), edge: join(homedir(), 'Library/Application Support/Microsoft Edge') }
      : { chrome: join(homedir(), '.config/google-chrome'), edge: join(homedir(), '.config/microsoft-edge') }) {}
  async profiles(): Promise<BrowserProfile[]> {
    const result: BrowserProfile[] = [];
    for (const browser of ['chrome', 'edge'] as const) {
      const root = this.roots[browser];
      let names: Record<string, { name?: string }> = {};
      try { names = JSON.parse(await readExport(join(root, 'Local State')))?.profile?.info_cache ?? {}; } catch { /* Directory scan also supports missing Local State. */ }
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^(Default|Profile \d+)$/.test(entry.name)) continue;
        if (!(await stat(join(root, entry.name, 'Bookmarks')).catch(() => null))?.isFile()) continue;
        result.push({ id: `${browser}:${entry.name}`, browser, name: String(names[entry.name]?.name || entry.name).slice(0, 120) });
      }
    }
    return result;
  }
  async profile(id: string) {
    const match = /^(chrome|edge):(Default|Profile \d+)$/.exec(id);
    if (!match) throw Error('Invalid browser profile.');
    return this.file(join(this.roots[match[1] as 'chrome' | 'edge'], match[2], 'Bookmarks'));
  }
  async file(path: string) { return parseBrowserBookmarks(await readExport(path)); }
}
