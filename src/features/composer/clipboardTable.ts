import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table';
import { gfmTable } from 'micromark-extension-gfm-table';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Root, RootContent, Table, PhrasingContent, TableCell } from 'mdast';
import { pastedTextCharacterThreshold } from './pastedText';

const parseOptions = { extensions: [gfmTable()], mdastExtensions: [gfmTableFromMarkdown()] };
const writeOptions = { extensions: [gfmTableToMarkdown({ tablePipeAlign: false })] };
const maxSource = 128_000;

export function draftTables(source: string) {
  if (source.length > maxSource || !source.includes('|') || !/^[ \t]*[|:]?[ \t]*:?-+[ \t]*[:|]/m.test(source)) return [];
  try { return fromMarkdown(source, parseOptions).children.filter((node): node is Table => node.type === 'table'); }
  catch { return []; }
}

// Only remove export padding when it would otherwise turn a small table into a file.
// Take cell content from the source so URLs, escaping and inline code round-trip.
function withoutTablePadding(source: string, tables: Table[]) {
  const parts: string[] = [];
  let cursor = 0;
  for (const table of tables) {
    const rows = table.children.map(row => '| ' + row.children.map(cell => {
      if (!cell.children.length) return '';
      return source.slice(cell.children[0].position!.start.offset, cell.children.at(-1)!.position!.end.offset);
    }).join(' | ') + ' |');
    const delimiter = table.children[0].children.map((_, i) => {
      const alignment = table.align?.[i];
      return (alignment === 'left' || alignment === 'center' ? ':' : '') + '---' +
        (alignment === 'right' || alignment === 'center' ? ':' : '');
    });
    rows.splice(1, 0, '| ' + delimiter.join(' | ') + ' |');
    parts.push(source.slice(cursor, table.position!.start.offset), rows.join('\n'));
    cursor = table.position!.end.offset!;
  }
  return parts.join('') + source.slice(cursor);
}

function serializeTable(rows: TableCell[][], align?: Table['align']) {
  const width = rows[0].length;
  return toMarkdown({ type: 'table', align, children: rows.map(cells => {
    const children = cells.slice();
    while (children.length < width) children.push({type: 'tableCell', children: []});
    return { type: 'tableRow', children };
  }) }, writeOptions).trimEnd();
}

const text = (value: string): PhrasingContent => ({ type: 'text', value });
const lineBreak = (): PhrasingContent => ({ type: 'html', value: '<br>' });

function inlineContents(node: Node, inCell: boolean): PhrasingContent[] {
  if (node.nodeType === Node.TEXT_NODE) return [text((node.textContent ?? '').replace(/[\r\n\t ]+/g, ' '))];
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  if (['STYLE','SCRIPT','TEMPLATE','NOSCRIPT'].includes(el.tagName)) return [];
  const br: PhrasingContent = inCell ? lineBreak() : {type: 'break'};
  if (el.tagName === 'BR') return [br];
  if (el.tagName === 'IMG') return [text(el.getAttribute('alt') ?? '')];
  if (el.tagName === 'CODE') return [{ type: 'inlineCode', value: el.textContent ?? '' }];
  const children = [...el.childNodes].flatMap(child => inlineContents(child, inCell));
  if (el.tagName === 'A') {
    const url = el.getAttribute('href')?.trim();
    if (url && /^https?:\/\//i.test(url)) return [{ type: 'link', url, children }];
  }
  if (el.tagName === 'B' || el.tagName === 'STRONG') return [{ type: 'strong', children }];
  if (el.tagName === 'I' || el.tagName === 'EM') return [{ type: 'emphasis', children }];
  if ((el.tagName === 'DIV' || el.tagName === 'P') && el.nextElementSibling) children.push(br);
  return children;
}

function tableFromElement(table: HTMLTableElement) {
  if (!table.rows.length) return;
  const rows = [...table.rows].map(row => [...row.cells]);
  if (!rows[0].length || rows.some(row => row.length > rows[0].length || row.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1))) return;
  const align = rows[0].map(cell => {
    const value = cell.style.textAlign || cell.getAttribute('align');
    return value === 'center' || value === 'right' || value === 'left' ? value : null;
  });
  return serializeTable(rows.map(row => row.map(cell => ({
    type: 'tableCell', children: [...cell.childNodes].flatMap(child => inlineContents(child, true)),
  }))), align);
}

function htmlTable(html: string) {
  if (html.length > 2_000_000 || !/<table[\s>]/i.test(html)) return;
  // Template contents stay detached and inert, including external images and scripts.
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = template.content;
  fragment.querySelectorAll('style,script,link,meta,title').forEach(node => node.remove());
  const tables = fragment.querySelectorAll('table');
  if (!tables.length || fragment.querySelector('table table')) return;
  const blocks: string[] = [];
  const range = document.createRange();
  range.selectNodeContents(fragment);
  const appendProse = () => {
    const children = [...range.cloneContents().childNodes].flatMap(child => inlineContents(child, false));
    if (!children.length) return;
    const markdown = toMarkdown({type: 'paragraph', children}).trim();
    if (markdown) blocks.push(markdown);
  };
  for (const table of tables) {
    const markdown = tableFromElement(table);
    if (!markdown) return;
    range.setEndBefore(table);
    appendProse();
    if (table.caption) blocks.push(toMarkdown({type: 'paragraph', children: inlineContents(table.caption, false)}).trim());
    blocks.push(markdown);
    range.setStartAfter(table);
  }
  range.setEnd(fragment, fragment.childNodes.length);
  appendProse();
  return blocks.filter(Boolean).join('\n\n');
}

/** Clipboard TSV uses quoted fields for line breaks and doubled quotes within a field. */
function tabSeparatedTable(source: string, explicit: boolean) {
  if (!source.includes('\t') || !/[\r\n]/.test(source) || source.length > maxSource) return;
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, closed = false;
  const finishField = () => { row.push(field); field = ''; closed = false; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (source[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === '\t') finishField();
    else if (char === '\r' || char === '\n') {
      finishField(); rows.push(row); row = [];
      if (char === '\r' && source[i + 1] === '\n') i++;
    } else if (closed) return;
    else if (char === '"' && !field) quoted = true;
    else field += char;
  }
  if (quoted) return;
  if (field || closed || row.length) { finishField(); rows.push(row); }
  if (rows.length < 2 || rows[0].length < 2 || rows.some(row => row.length > rows[0].length)) return;
  if (!explicit && (rows[0].some(cell => !cell.trim()) || rows.some(row => row.length < 2))) return;
  return serializeTable(rows.map(row => row.map(value => ({
    type: 'tableCell', children: value.split(/\r\n?|\n/).flatMap((line, i) => i ? [lineBreak(), text(line)] : [text(line)]),
  }))));
}

export function separatePastedTable(table: string, draft: string, start: number, end: number) {
  const before = draft.slice(0, start), after = draft.slice(end);
  const leading = !before.trimEnd() || /\n[ \t]*\n[ \t]*$/.test(before) ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trailing = !after.trimStart() || /^[ \t]*\n[ \t]*\n/.test(after) ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  return leading + table + trailing;
}

/** In code, the clipboard's literal source belongs to the example being edited. */
export function pastingIntoCode(draft: string, start: number, end: number) {
  if (!draft || draft.length > maxSource) return false;
  if (!draft.includes('`') && !draft.includes('~~~') && !/^(?: {4}|\t)/m.test(draft)) return false;
  const probe = draft.slice(0, start) + 'x' + draft.slice(end);
  function contains(node: Root | RootContent): boolean {
    const pos = node.position;
    if (pos && (start < pos.start.offset! || start >= pos.end.offset!)) return false;
    if (node.type === 'inlineCode' || node.type === 'code') return true;
    return 'children' in node && node.children.some(contains);
  }
  try { return contains(fromMarkdown(probe)); }
  catch { return true; }
}

export function clipboardTableSource(clipboard: DataTransfer): string | undefined {
  const markdown = clipboard.getData('text/markdown');
  const plain = clipboard.getData('text/plain');
  for (const source of markdown && markdown !== plain ? [markdown, plain] : [plain]) {
    const tables = draftTables(source);
    if (tables.length) {
      if (source.length <= pastedTextCharacterThreshold) return source;
      const compact = withoutTablePadding(source, tables);
      return compact.length <= pastedTextCharacterThreshold ? compact : source;
    }
  }
  try {
    const html = htmlTable(clipboard.getData('text/html'));
    if (html) return html;
    const tsv = clipboard.getData('text/tab-separated-values');
    return tabSeparatedTable(tsv || plain, Boolean(tsv));
  } catch {
    // An unsupported clipboard structure can still be pasted as ordinary text.
    return undefined;
  }
}
