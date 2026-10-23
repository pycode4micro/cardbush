import { fileURLToPath, pathToFileURL } from 'node:url';
import { posix, win32 } from 'node:path';

export type ChatInlineReference = { text: string; href?: string };
export type ChatReferenceRenderer = {
  link(label: string, target: string): ChatInlineReference | undefined;
  source?(number: number): void;
};
export const maxInlineMarkup = 2048;

/** Read a complete inline destination, including quoted Windows paths and
 * balanced URL parentheses. Incomplete provider chunks remain buffered. */
export function markdownLinkAt(text: string, start: number) {
  let i = start, image = false;
  if (text[i] === '!') { image = true; i++; }
  if (text[i++] !== '[') return;
  const labelStart = i; let depth = 1;
  for (; i < text.length && i - start <= maxInlineMarkup; i++) {
    if (text[i] === '\\' && /[\\[\]]/.test(text[i + 1] ?? '')) { i++; continue; }
    if (text[i] === '[') depth++;
    if (text[i] === ']' && --depth === 0) break;
  }
  if (depth || text[i + 1] !== '(') return;
  const label = text.slice(labelStart, i).replace(/\\([\\[\]])/g, '$1');
  i += 2; while (text[i] === ' ') i++;
  const angled = text[i] === '<'; if (angled) i++;
  const targetStart = i; depth = 0;
  for (; i < text.length && i - start <= maxInlineMarkup; i++) {
    const char = text[i];
    if (char === '\n') return;
    if (char === '\\' && /[()<> ]/.test(text[i + 1] ?? '')) { i++; continue; }
    if (angled) { if (char === '>') break; }
    else if (char === '(') depth++;
    else if (char === ')') { if (!depth) break; depth--; }
    else if (/\s/.test(char) && !depth) break;
  }
  const target = text.slice(targetStart, i).replace(/\\([()<> ])/g, '$1');
  if (!target || i - start > maxInlineMarkup || depth) return;
  if (angled) { if (text[i++] !== '>') return; }
  while (text[i] === ' ') i++;
  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i++];
    while (i < text.length && text[i] !== quote && i - start <= maxInlineMarkup) { if (text[i] === '\\') i++; i++; }
    if (text[i++] !== quote) return;
    while (text[i] === ' ') i++;
  }
  if (text[i] !== ')' || i - start > maxInlineMarkup) return;
  return { label: image ? `Image: ${label || 'image'}` : label, target, end: i + 1 };
}

export function terminalSupportsHyperlinks(env: NodeJS.ProcessEnv) {
  return env.TERM !== 'dumb' && Boolean(env.WT_SESSION || env.TERM_PROGRAM &&
    /^(?:vscode|iTerm\.app|WezTerm|ghostty)$/i.test(env.TERM_PROGRAM) ||
    env.TERM?.includes('kitty') || Number(env.VTE_VERSION) >= 5000);
}

export function terminalHyperlink(text: string, href?: string) {
  // Only application-created links may emit OSC. Model-provided terminal
  // sequences are stripped before parsing, and custom command URIs stay inert.
  if (!href || /[\x00-\x20\x7f-\x9f]/.test(href) || !/^(?:https?|file):\/\//i.test(href)) return text;
  return `\x1b]8;;${href}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export type ChatLinkTarget = { kind: 'url' | 'file'; target: string; href: string; line?: number; column?: number };
export function chatLinkTarget(value: string, workspace?: string, platform: string = process.platform): ChatLinkTarget | undefined {
  if (!value || value.length > 32768 || /[\x00-\x1f\x7f-\x9f]/.test(value)) return;
  if (/^https?:\/\//i.test(value)) {
    try { const url = new URL(value); return { kind: 'url', target: url.href, href: url.href }; } catch { return; }
  }
  let path = value;
  // Locations are syntax in the original destination, not in a decoded file
  // name (a literal %23L12 belongs to the filename).
  const location = /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?)$/.exec(path);
  if (path.startsWith('#')) return;
  // A numeric custom URI is still a URI, not a file with a line number.
  // Bare filenames such as report.md:12 remain valid local references.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(path);
  if (scheme && !/^[a-z]:[\\/]/i.test(path) && !/^(?:file:\/\/|cardbush-local-file:)/i.test(path) &&
    !(location?.index === scheme[1].length && /\.[a-z0-9]+$/i.test(scheme[1]))) return;
  if (location) path = path.slice(0, location.index);
  if (!path) return;
  try {
    if (path.startsWith('cardbush-local-file:')) path = decodeURIComponent(path.slice('cardbush-local-file:'.length));
    else if (/^file:\/\//i.test(path)) path = fileURLToPath(path, { windows: platform === 'win32' });
    else { try { path = decodeURIComponent(path); } catch { /* Literal percent signs in native file names. */ } }
  } catch { return; }
  // Accept the /C:/ form commonly produced by Markdown authors too.
  if (/^\/[a-z]:[\\/]/i.test(path)) path = path.slice(1);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path) || path.startsWith('#')) return;
  const paths = platform === 'win32' ? win32 : posix;
  // A server path must never be resolved using the client's filesystem rules.
  if (platform !== 'win32' && (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\'))) return;
  if (platform === 'win32' && path.startsWith('/') && !path.startsWith('//')) return;
  if (!paths.isAbsolute(path) && !workspace) return;
  path = paths.resolve(workspace ?? '', path);
  if (/[\x00-\x1f\x7f-\x9f]/.test(path)) return;
  return { kind: 'file', target: path, href: pathToFileURL(path, { windows: platform === 'win32' }).href,
    ...(location ? { line: Number(location[1] ?? location[3]), ...(location[2] || location[4] ? { column: Number(location[2] ?? location[4]) } : {}) } : {}) };
}
