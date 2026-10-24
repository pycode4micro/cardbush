import { stripVTControlCharacters } from 'node:util';
import { markdownLinkAt, maxInlineMarkup, terminalHyperlink, type ChatReferenceRenderer } from './agentChatLinks.mjs';

// Adapted from bushserver/cli/native_terminal.py: terminal width, Markdown-lite
// and append-only presentation. Runtime, settings and permissions stay in TS.
export function terminalText(text: string) {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cells(grapheme: string) {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2;
  const cp = grapheme.codePointAt(0)!;
  return cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f || cp >= 0xac00 && cp <= 0xd7a3 ||
    cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe10 && cp <= 0xfe6f ||
    cp >= 0xff01 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000 && cp <= 0x3fffd) ? 2 : 1;
}
export function terminalWidth(value: string) {
  return [...segmenter.segment(terminalText(value))].reduce((width, part) => width + cells(part.segment), 0);
}
export function terminalClip(value: string, columns: number) {
  const plain = terminalText(value).replace(/[\n\t]/g, ' '), limit = Math.max(0, columns);
  if (terminalWidth(plain) <= limit) return plain;
  if (limit < 2) return limit ? '…' : '';
  let result = '', width = 0;
  for (const { segment } of segmenter.segment(plain)) {
    width += cells(segment); if (width > limit - 1) break; result += segment;
  }
  return result + '…';
}
function wrap(value: string, columns: number) {
  const result: string[] = []; let line = '', width = 0;
  for (const { segment } of segmenter.segment(terminalText(value).replace(/[\n\t]/g, ' '))) {
    const size = cells(segment);
    if (width + size > columns && line) { result.push(line); line = ''; width = 0; }
    line += segment; width += size;
  }
  result.push(line); return result;
}
export function terminalRows(value: string, columns: number) {
  return wrap(value, Math.max(1, columns)).length;
}
export function terminalCursor(value: string, columns: number) {
  const width = Math.max(1, columns); let rows = 0, cols = 0;
  for (const { segment } of segmenter.segment(terminalText(value))) {
    if (segment === '\n') { rows++; cols = 0; continue; }
    const size = segment === '\t' ? 8 - cols % 8 : cells(segment);
    if (cols + size > width) { rows++; cols = 0; }
    cols += size;
    if (cols >= width) { rows += Math.floor(cols / width); cols %= width; }
  }
  return { rows, cols };
}
export function terminalStyle(text: string, style: 'blue' | 'dim' | 'bold' | 'error' | 'warning' | 'code', color: boolean) {
  const code = { blue: 94, dim: 90, bold: 1, error: 31, warning: 33, code: 36 }[style];
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Decorate readline's printable input only. Cursor movement and erase commands
 * run with the default background so editing cannot paint the rest of the screen. */
export function chatInputChunk(text: string) {
  let printed = false;
  const decorated = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x00-\x1f\x7f-\x9f]+/g, token => {
    if (token.startsWith('\x1b')) return token === '\x1b[0m' ? '\x1b[37m' : token;
    printed = true;
    return `\x1b[48;5;236m${token}\x1b[49m`;
  });
  return printed ? `\x1b[37m${decorated}\x1b[39;49m` : text;
}
export type ChatIdentity = { name: string; model: string; effort?: string; permission: string; workspace?: string; sessionId: string; local: boolean };
export function chatHeader(value: ChatIdentity, columns: number, color: boolean) {
  const width = Math.max(10, Math.min(columns - 1, 92)), inside = width - 4;
  const title = terminalClip(' CardBush ', width - 4);
  const border = (text: string) => terminalStyle(text, 'dim', color);
  const row = (text: string, style: 'bold' | 'dim' | 'blue' = 'dim') => wrap(text, inside)
    .map(line => border('│ ') + terminalStyle(line, style, color) + ' '.repeat(Math.max(0, inside - terminalWidth(line))) + border(' │')).join('\n');
  return '\n' + border('╭─') + terminalStyle(title, 'blue', color) + border('─'.repeat(Math.max(0, width - terminalWidth(title) - 3)) + '╮') + '\n' + [
    row(value.local ? 'Working in the current directory' : `Connected to ${value.name}`, 'bold'),
    row(`${value.model} · ${value.permission}${value.effort ? ` · Effort: ${value.effort}` : ''}`, 'blue'),
    row(terminalClip(value.workspace ?? '', inside)),
    row(''),
    row('/model model & effort /settings shared App settings'),
    row('/help commands        /quit exit (/exit also works)'),
    row('/artifact turn files  /source supporting evidence'),
    row('/session switch chat  /tools execution details'),
    row('/shell native shell   !command run a local command'),
    row('/ commands & skills   @ workspace files   Tab complete'),
  ].join('\n') + '\n' + border('╰' + '─'.repeat(width - 2) + '╯') + '\n' +
    (value.workspace && terminalWidth(value.workspace) > inside ? terminalStyle(`  Workspace: ${terminalText(value.workspace)}\n`, 'dim', color) : '') +
    terminalStyle(`  Session: ${terminalText(value.sessionId)}\n`, 'dim', color);
}

type TextStyle = Parameters<typeof terminalStyle>[1];
type TextRun = { text: string; style?: TextStyle; href?: string };
function inlineMarkdown(text: string, references?: ChatReferenceRenderer): TextRun[] {
  const runs: TextRun[] = []; let offset = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (!'`*[!<'.includes(text[i])) continue;
    const tail = text.slice(i, i + maxInlineMarkup + 1);
    const code = text[i] === '`' ? /^(`+)([^`\n]+)\1/.exec(tail) : undefined;
    const bold = text.startsWith('**', i) ? /^\*\*([^*\n]+)\*\*/.exec(tail) : undefined;
    const link = markdownLinkAt(text, i);
    const auto = text[i] === '<' ? /^<((?:https?|file):\/\/[^<>\n]+)>/.exec(tail) : undefined;
    const source = text[i] === '[' && !/[\\!A-Za-z0-9_\[]/.test(text[i - 1] ?? '')
      ? /^\[([1-9]\d{0,8})\](?![A-Za-z0-9_\](])/.exec(tail) : undefined;
    if (!code && !bold && !link && !auto && !source) continue;
    runs.push({ text: text.slice(offset, i) });
    let length: number;
    if (code) { length = code[0].length; runs.push({ text: code[2], style: 'code' }); }
    else if (bold) { length = bold[0].length; runs.push(...inlineMarkdown(bold[1], references).map(run => ({ ...run, style: run.style ?? 'bold' as const }))); }
    else if (link || auto) {
      const label = link?.label ?? auto![1], target = link?.target ?? auto![1];
      length = link ? link.end - i : auto![0].length;
      const rendered = references?.link(label, target);
      if (rendered) runs.push({ ...rendered, style: 'blue' });
      else runs.push({ text: label, style: 'blue' }, { text: ` (${target})` });
    } else { length = source![0].length; references?.source?.(Number(source![1])); runs.push({ text: source![0], style: references ? 'blue' : undefined }); }
    i += length - 1; offset = i + 1;
  }
  runs.push({ text: text.slice(offset) }); return runs;
}
function stablePrefix(text: string) {
  // Keep a split inline delimiter until its pair arrives. Bound unfinished markup
  // so a malformed model response cannot suppress all subsequent visible output.
  let open = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (!open && (text[i] === '[' || text[i] === '!')) {
      const link = markdownLinkAt(text, i);
      if (link) { i = link.end - 1; continue; }
      const source = /^\[[1-9]\d{0,8}\](?!\()/.exec(text.slice(i));
      if (source && i + source[0].length < text.length) { i += source[0].length - 1; continue; }
      if ((text[i] === '[' || text[i + 1] === '[') && text.length - i <= maxInlineMarkup) return i;
    }
    const token = text[i] === '`' ? '`' : text.slice(i, i + 2) === '**' ? '**' : text[i] === '<' ? '<' : '';
    if (open === '<') { if (text[i] === '>') open = ''; continue; }
    if (!token) continue;
    if (!open) { open = token; start = i; } else if (token === open) open = '';
    if (token === '**') i++;
  }
  // A trailing single '*' can become '**' in the next provider delta.
  return open && text.length - start <= maxInlineMarkup ? start
    : text.endsWith('*') && !text.endsWith('**') ? text.length - 1 : text.length;
}

/** Word-aware flow for prose. Buffer only the current word, so a streamed tool
 * name moves to the next row as a whole instead of breaking at the terminal edge.
 * Code blocks bypass this flow and keep their original whitespace/soft wrapping. */
class ChatTextFlow {
  #word: TextRun[] = [];
  #kind = '';
  #space = false;
  #column = 0;
  #content = false;
  #prefix = '';
  #continuation = '';
  constructor(readonly output: (text: string) => void, readonly color: boolean, readonly columns: () => number) {}
  limit() { return Math.max(8, Math.min(104, (this.columns() || 80) - 2)); }
  start(prefix: string, continuation = prefix) {
    this.#prefix = prefix; this.#continuation = continuation;
    this.#column = 0; this.#content = false; this.#space = false;
  }
  #append(text: string, style?: TextStyle, href?: string) {
    const last = this.#word.at(-1);
    if (last && last.style === style && last.href === href) last.text += text;
    else this.#word.push({ text, style, href });
  }
  write(text: string, style?: TextStyle, href?: string) {
    if (style === 'code') {
      // Inline commands/paths are literal too: keep their internal spaces and
      // place the entire span together whenever it fits on a row.
      this.flush(); this.#append(text, style, href); this.#kind = 'code'; return;
    }
    for (const { segment } of segmenter.segment(text)) {
      if (/^\s+$/u.test(segment)) { this.flush(); this.#space = true; continue; }
      const last = this.#word.at(-1)?.text ?? '';
      // Preserve graphemes split across provider deltas (combining marks, ZWJ,
      // skin tones and flag pairs). Nothing already committed is repainted.
      if (/^[\p{Mark}\p{Cf}\p{Emoji_Modifier}]+$/u.test(segment) || last.endsWith('\u200d') ||
        /^\p{Regional_Indicator}$/u.test(last) && /^\p{Regional_Indicator}$/u.test(segment)) {
        this.#append(segment, style, href); continue;
      }
      const word = /^[\p{Letter}\p{Number}_$@./\\:?#%&=+~\-]+$/u.test(segment) && cells(segment) <= 1;
      if (/^[,;!，。；：！？、）\]】》」』”’]+$/u.test(segment)) {
        this.#append(segment, style, href); this.#kind = 'punctuation'; continue;
      }
      if (!(word && this.#kind === 'word') && this.#kind !== 'opening') this.flush();
      this.#append(segment, style, href);
      this.#kind = /^[（(\[【《「『“‘]+$/u.test(segment) ? 'opening' : word ? 'word' : 'symbol';
      // Malformed/huge identifiers still stream with bounded memory.
      if (this.#word.reduce((length, run) => length + run.text.length, 0) >= 2048) this.flush();
    }
  }
  #beginRow() {
    if (this.#column) return;
    const prefix = terminalClip(this.#prefix, Math.max(0, this.limit() - 4));
    this.output(terminalStyle(prefix, 'dim', this.color)); this.#column = terminalWidth(prefix);
  }
  #wrap() {
    this.output('\n'); this.#column = 0; this.#content = false; this.#space = false;
    this.#prefix = this.#continuation; this.#beginRow();
  }
  flush() {
    if (!this.#word.length) return;
    const width = terminalWidth(this.#word.map(run => run.text).join(''));
    this.#beginRow();
    if (this.#content && this.#column + Number(this.#space) + width > this.limit()) this.#wrap();
    if (this.#space && this.#content) { this.output(' '); this.#column++; }
    this.#space = false;
    for (const run of this.#word) {
      let part = '';
      const emit = () => { if (part) this.output(terminalHyperlink(run.style ? terminalStyle(part, run.style, this.color) : part, run.href)); part = ''; };
      for (const { segment } of segmenter.segment(run.text)) {
        const size = cells(segment);
        if (this.#column + size > this.limit() && this.#content) { emit(); this.#wrap(); }
        part += segment; this.#column += size; this.#content = true;
      }
      emit();
    }
    this.#word = []; this.#kind = '';
  }
  newline() { this.flush(); this.output('\n'); this.#column = 0; this.#content = false; this.#space = false; }
}

const maxTableLine = 16_384;
type TableAlignment = 'left' | 'center' | 'right';
type MarkdownTable = { headers: string[]; align: TableAlignment[]; rows: number;
  layout?: { limit: number; widths: number[]; stacked: boolean } };

/** Split structural pipes only; escaped pipes and pipes inside code stay in their
 * cell. Recognition still requires a matching Markdown delimiter row. */
function tableCells(line: string): string[] | undefined {
  if (!line.includes('|')) return;
  if (/^ {4}|^\s{0,3}(?:#{1,6}\s|>|`{3}|~{3}|[-*+]\s|\d+[.)]\s)/.test(line)) return;
  const parts: string[] = []; let cell = '', code = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && i + 1 < line.length) {
      cell += line[i + 1] === '|' ? '|' : char + line[i + 1]; i++; continue;
    }
    if (char === '`') {
      let end = i + 1; while (line[end] === '`') end++;
      const size = end - i;
      if (code === size) code = 0;
      else if (!code && line.indexOf('`'.repeat(size), end) >= 0) code = size;
      cell += line.slice(i, end); i = end - 1; continue;
    }
    if (char === '|' && !code) { parts.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  if (!parts.length) return;
  parts.push(cell.trim());
  if (!parts[0]) parts.shift();
  if (!parts.at(-1)) parts.pop();
  return parts.length ? parts : undefined;
}
function tableAlignments(line: string, count: number): TableAlignment[] | undefined {
  const parts = tableCells(line);
  if (parts?.length !== count || parts.some(cell => !/^:?-+:?$/.test(cell))) return;
  return parts.map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'center' : 'right' : 'left');
}
function tableCellLines(cell: string, width: number, color: boolean, header = false, references?: ChatReferenceRenderer) {
  let output = '';
  const flow = new ChatTextFlow(text => { output += text; }, color, () => width + 2);
  for (const part of cell.split(/<br\s*\/?\s*>/i)) {
    flow.start('');
    for (const run of inlineMarkdown(part, references)) flow.write(run.text, run.style ?? (header ? 'bold' : undefined), run.href);
    flow.newline();
  }
  return output.slice(0, -1).split('\n');
}

type MarkdownBlock = { kind: 'paragraph' | 'heading' | 'list' | 'quote' | 'code' | 'table'; indent?: number; hanging?: number };

/** Lines are committed once; no repaint of transcript history or typing delay. */
export class ChatMarkdown {
  #pending = '';
  #continued = false;
  #heading = false;
  #fence = '';
  #blank = false;
  #printed = false;
  #previous?: MarkdownBlock;
  #tableHeader?: { raw: string; cells: string[] };
  #table?: MarkdownTable;
  #flow: ChatTextFlow;
  #timer?: ReturnType<typeof setTimeout>;
  constructor(readonly output: (text: string) => void, readonly color: boolean, columns: () => number = () => 80, readonly references?: ChatReferenceRenderer) {
    this.#flow = new ChatTextFlow(output, color, columns);
  }
  write(text: string) {
    this.#pending += terminalText(text);
    let newline: number;
    while ((newline = this.#pending.indexOf('\n')) >= 0) {
      this.#line(this.#pending.slice(0, newline), true);
      this.#pending = this.#pending.slice(newline + 1);
    }
    if (!this.#timer && this.#pending) this.#timer = setTimeout(() => { this.#timer = undefined; this.flush(false); }, 80).unref();
  }
  #block(block: MarkdownBlock, prefix = '  ', continuation = prefix, newItem = false) {
    const previous = this.#previous;
    const separate = this.#blank || block.kind === 'heading' || previous?.kind === 'heading' ||
      block.kind === 'code' && previous?.kind !== 'code' || previous?.kind === 'code' && block.kind !== 'code' ||
      newItem && (previous?.kind !== 'list' || block.indent! <= previous.indent!) ||
      previous?.kind === 'list' && block.kind !== 'list' ||
      block.kind === 'table' || previous?.kind === 'table' ||
      previous?.kind === 'quote' && block.kind !== 'quote' || block.kind === 'quote' && previous?.kind !== 'quote';
    if (this.#printed && separate) this.output('\n');
    this.#flow.start(prefix, continuation); this.#previous = block; this.#blank = false; this.#printed = true;
  }
  #tableRule(table: MarkdownTable, left: string, middle: string, right: string) {
    this.output(terminalStyle('  ' + left + table.layout!.widths.map(width => '─'.repeat(width + 2)).join(middle) + right, 'dim', this.color) + '\n');
  }
  #tableRow(table: MarkdownTable, values: string[], header = false) {
    const widths = table.layout!.widths;
    const cells = widths.map((width, index) => tableCellLines(values[index] ?? '', width, this.color, header, this.references));
    for (let row = 0; row < Math.max(...cells.map(cell => cell.length)); row++) {
      this.output('  ' + terminalStyle('│', 'dim', this.color));
      for (const [index, width] of widths.entries()) {
        const text = cells[index][row] ?? '', padding = Math.max(0, width - terminalWidth(text));
        const left = table.align[index] === 'right' ? padding : table.align[index] === 'center' ? Math.floor(padding / 2) : 0;
        this.output(' ' + ' '.repeat(left) + text + ' '.repeat(padding - left) + ' ' + terminalStyle('│', 'dim', this.color));
      }
      this.output('\n');
    }
  }
  #tableLayout(table: MarkdownTable, sample: string[]) {
    const limit = this.#flow.limit();
    if (table.layout?.limit === limit) return;
    if (!table.layout) this.#block({ kind: 'table' });
    else {
      // A resize starts a new section at the current width. Never rewrite rows
      // already in scrollback or print an old, wider border into a narrow view.
      if (!table.layout.stacked && table.layout.limit <= limit) this.#tableRule(table, '╰', '┴', '╯');
      this.output('\n');
    }
    const available = limit - 2 - (table.headers.length * 3 + 1);
    const stacked = available < table.headers.length * 8;
    const preferred = table.headers.map((header, index) => Math.max(8, ...[header, sample[index] ?? ''].flatMap(value =>
      value.split(/<br\s*\/?\s*>/i).map(part => terminalWidth(inlineMarkdown(part).map(run => run.text).join(''))))));
    const widths = table.headers.map(() => 8);
    if (!stacked) {
      let remaining = available - widths.length * 8;
      while (remaining > 0 && widths.some((width, index) => width < preferred[index])) {
        for (let i = 0; i < widths.length && remaining > 0; i++) if (widths[i] < preferred[i]) { widths[i]++; remaining--; }
      }
      // Keep room for later streamed rows. Give spare space to the columns with
      // the largest sample instead of freezing a short first row at tiny widths.
      const largest = Math.max(...preferred);
      while (remaining > 0) for (let i = 0; i < widths.length && remaining > 0; i++) {
        if (preferred[i] === largest) { widths[i]++; remaining--; }
      }
    }
    table.layout = { limit, widths, stacked };
    if (!stacked) { this.#tableRule(table, '╭', '┬', '╮'); this.#tableRow(table, table.headers, true); this.#tableRule(table, '├', '┼', '┤'); }
  }
  #tableData(table: MarkdownTable, cells: string[]) {
    // Missing cells are empty. Preserve extra data in the final column instead
    // of silently discarding it, even when the model emits an uneven row.
    const values = table.headers.map((_, index) => index === table.headers.length - 1 ? cells.slice(index).join(' | ') : cells[index] ?? '');
    const sameLayout = table.layout?.limit === this.#flow.limit();
    this.#tableLayout(table, values);
    if (table.layout!.stacked) {
      if (table.rows && sameLayout) this.output('\n');
      for (const [index, header] of table.headers.entries()) {
        this.#flow.start('  ', '    ');
        for (const run of inlineMarkdown(header, this.references)) this.#flow.write(run.text, run.style ?? 'bold', run.href);
        this.#flow.write(': ');
        const parts = values[index].split(/<br\s*\/?\s*>/i);
        for (const [line, part] of parts.entries()) {
          if (line) { this.#flow.newline(); this.#flow.start('    '); }
          for (const run of inlineMarkdown(part, this.references)) this.#flow.write(run.text, run.style, run.href);
        }
        this.#flow.newline();
      }
    } else {
      if (table.rows && sameLayout) this.#tableRule(table, '├', '┼', '┤');
      this.#tableRow(table, values);
    }
    table.rows++;
  }
  #finishTable() {
    const table = this.#table;
    if (!table) return;
    this.#tableLayout(table, []);
    if (!table.layout!.stacked) this.#tableRule(table, '╰', '┴', '╯');
    else if (!table.rows) {
      this.#flow.start('  '); this.#flow.write(table.headers.join(' · '), 'bold'); this.#flow.newline();
    }
    this.#table = undefined;
  }
  #line(body: string, newline: boolean) {
    if (this.#fence || this.#continued) { this.#render(body, newline); return; }
    const cells = body.length <= maxTableLine ? tableCells(body) : undefined;
    if (this.#table) {
      if (cells) { this.#tableData(this.#table, cells); return; }
      this.#finishTable();
    }
    if (this.#tableHeader) {
      const header = this.#tableHeader; this.#tableHeader = undefined;
      const align = body.length <= maxTableLine ? tableAlignments(body, header.cells.length) : undefined;
      if (align) { this.#table = { headers: header.cells, align, rows: 0 }; return; }
      this.#render(header.raw, true);
    }
    if (cells && newline) this.#tableHeader = { raw: body, cells };
    else this.#render(body, newline);
  }
  #render(body: string, newline: boolean) {
    if (!this.#continued) {
      const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(body);
      if (fence && (!this.#fence || fence[1][0] === this.#fence[0] && fence[1].length >= this.#fence.length && !fence[2].trim())) {
        const closing = Boolean(this.#fence); this.#fence = closing ? '' : fence[1];
        if (!closing) this.#block({ kind: 'code' });
        this.output(terminalStyle(closing ? '  ╰─' : terminalClip(`  ╭─ ${fence[2].trim() || 'code'}`, this.#flow.limit()), 'dim', this.color) + (newline ? '\n' : ''));
        this.#continued = !newline;
        return;
      }
      if (!this.#fence) {
        if (!body.trim()) { if (newline) this.#blank = true; return; }
        const heading = /^\s{0,3}#{1,6}\s+/.exec(body);
        const list = /^( *)([-*+]|\d{1,9}[.)])\s+/.exec(body);
        const quote = /^(?: {0,3}> ?)+/.exec(body);
        this.#heading = Boolean(heading);
        if (heading) { body = body.slice(heading[0].length); this.#block({ kind: 'heading' }); }
        else if (list) {
          const indent = Math.min(list[1].length, Math.floor(this.#flow.limit() / 2)), marker = /^\d/.test(list[2]) ? list[2] : '•';
          const prefix = ' '.repeat(2 + indent) + marker + ' ', hanging = list[0].length;
          this.#block({ kind: 'list', indent, hanging }, prefix, ' '.repeat(terminalWidth(prefix)), true);
          body = body.slice(list[0].length);
        } else if (quote) { body = body.slice(quote[0].length); this.#block({ kind: 'quote' }, '  ' + '│ '.repeat(Math.min(8, quote[0].split('>').length - 1))); }
        else if (this.#previous?.kind === 'list' && (!this.#blank || body.startsWith(' '.repeat(this.#previous.hanging!)))) {
          const previous = this.#previous;
          this.#block(previous, ' '.repeat(2 + previous.hanging!)); body = body.trimStart();
        } else this.#block({ kind: 'paragraph' });
      }
    }
    if (this.#fence) this.output((!this.#continued && body ? '  ' : '') + body + (newline ? '\n' : ''));
    else {
      for (const run of inlineMarkdown(body, this.references)) this.#flow.write(run.text, run.style ?? (this.#heading ? 'bold' : undefined), run.href);
      if (newline) this.#flow.newline();
    }
    this.#continued = !newline;
    if (newline) this.#heading = false;
  }
  flush(final = true) {
    clearTimeout(this.#timer); this.#timer = undefined;
    // Hold a possible table row through provider chunks until its delimiter or
    // newline arrives. Bound the hold so malformed output still becomes visible.
    if (!final && !this.#continued && !this.#fence && this.#pending.length <= maxTableLine &&
      (this.#table || this.#tableHeader || /^\s{0,3}\|/.test(this.#pending) || tableCells(this.#pending))) return;
    // Wait for the end of a fence/heading prefix instead of changing old rows.
    if (!final && !this.#continued && this.#pending.length <= 2048 &&
      (/^\s{0,3}([`~]|#{1,6}(?:\s|$))/.test(this.#pending) || /^\s*(?:[-*+>]?|\d{1,9}[.)]?)\s*$/.test(this.#pending))) return;
    const length = final || this.#fence ? this.#pending.length : stablePrefix(this.#pending);
    if (length) {
      this.#line(this.#pending.slice(0, length), false); this.#pending = this.#pending.slice(length);
    }
    if (final) {
      if (this.#tableHeader) { const header = this.#tableHeader; this.#tableHeader = undefined; this.#render(header.raw, true); }
      this.#finishTable();
      if (!this.#fence) this.#flow.flush();
    }
  }
  end() {
    this.flush();
    if (this.#printed) this.output(this.#continued ? '\n\n' : '\n');
    this.#continued = false; this.#heading = false; this.#fence = '';
    this.#blank = false; this.#printed = false; this.#previous = undefined;
  }
}
