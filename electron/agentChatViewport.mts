import { terminalText, terminalWidth, terminalRows, terminalCursor } from './agentChatPresentation.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
type Position = { row: number; column: number };
export type ChatFooter = { lines: string[]; cursor: Position };

/** A bounded view of readline's buffer. Editing, history and key bindings stay
 * in readline; this function only chooses the visible rows around its caret. */
export function chatInputViewport(prompt: string, line: string, cursor: number, width: number, height = 4) {
  const columns = Math.max(2, width), lines = ['']; let column = 0;
  let caret: Position = { row: 0, column: 0 };
  const value = terminalText(prompt) + line, offset = terminalText(prompt).length + cursor;
  for (const part of graphemes.segment(value)) {
    const size = terminalWidth(part.segment);
    if (part.segment !== '\n' && column + size > columns) { lines.push(''); column = 0; }
    if (part.index <= offset) caret = { row: lines.length - 1, column };
    if (part.segment === '\n') { lines.push(''); column = 0; }
    else { lines[lines.length - 1] += part.segment; column += size; }
    if (part.index + part.segment.length <= offset) caret = { row: lines.length - 1, column };
  }
  if (caret.column >= columns) {
    caret = { row: caret.row + 1, column: 0 };
    if (caret.row === lines.length) lines.push('');
  }
  const start = Math.max(0, caret.row - height + 1);
  return { lines: lines.slice(start, start + height), cursor: { row: caret.row - start, column: caret.column },
    clipped: start > 0 || lines.length > start + height };
}

/** Owns only the unfinished output line and the small input footer in the main
 * terminal buffer. Completed lines are appended once, never repainted. */
export class ChatLiveViewport {
  #shown?: ChatFooter;
  #tail = '';
  #tailOutput?: NodeJS.WritableStream;
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(readonly output: NodeJS.WriteStream, readonly footer: () => ChatFooter | undefined) {}
  #width() { return Math.max(2, (this.output.columns || 80) - 1); }
  #erase() {
    const shown = this.#shown;
    if (!shown) return;
    this.#shown = undefined;
    // Recompute physical rows at the current width: the terminal may have
    // reflowed the old footer before emitting its resize event.
    const columns = this.output.columns || 80;
    const previous = shown.lines.slice(0, shown.cursor.row).reduce((rows, line) => rows + terminalRows(line, columns), 0);
    let prefix = '', cells = 0;
    for (const { segment } of graphemes.segment(terminalText(shown.lines[shown.cursor.row] ?? ''))) {
      const size = terminalWidth(segment);
      if (cells + size > shown.cursor.column) break;
      prefix += segment; cells += size;
    }
    const current = terminalCursor(prefix, columns);
    const up = previous + current.rows;
    this.output.write('\x1b[0m\r' + (up ? `\x1b[${up}A` : '') + '\x1b[0J');
  }
  #wrapTail() {
    // Long unbroken/code lines must not make the transient area taller than the
    // viewport. Commit complete visual rows and retain the final partial row.
    const width = this.#width();
    if (terminalWidth(this.#tail) <= width) return;
    let row = '', column = 0, style = ''; const complete: string[] = [];
    for (const part of this.#tail.matchAll(/\x1b\[[\d;]*m|[^\x1b]+/g)) {
      if (part[0].startsWith('\x1b')) { row += part[0]; style = part[0] === '\x1b[0m' ? '' : style + part[0]; continue; }
      for (const { segment } of graphemes.segment(part[0])) {
        const size = terminalWidth(segment);
        if (column + size > width) { complete.push(row + '\x1b[0m'); row = style; column = 0; }
        row += segment; column += size;
      }
    }
    if (complete.length) this.#tailOutput?.write(complete.join('\n') + '\n');
    this.#tail = row;
  }
  write(text: string, output: NodeJS.WritableStream) {
    if (!text || this.#closed) return;
    this.#erase();
    if (this.#tail && this.#tailOutput !== output) {
      this.#tailOutput?.write(this.#tail + '\x1b[0m\n'); this.#tail = '';
    }
    this.#tailOutput = output;
    // A tab's physical width depends on its column. Expand it only for the TTY
    // view, so a partial code line cannot wrap underneath the input footer.
    let column = 0;
    const value = (this.#tail + text).replace(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g, part => {
      if (part.startsWith('\x1b')) return part;
      let result = '';
      for (const { segment } of graphemes.segment(part)) {
        if (segment === '\n') { result += segment; column = 0; }
        else if (segment === '\t') { const size = 8 - column % 8; result += ' '.repeat(size); column += size; }
        else { result += segment; column += terminalWidth(segment); }
      }
      return result;
    }), last = value.lastIndexOf('\n');
    if (last >= 0) output.write(value.slice(0, last + 1));
    this.#tail = value.slice(last + 1); this.#wrapTail(); this.schedule();
  }
  schedule() {
    if (!this.#closed && !this.#timer) this.#timer = setTimeout(() => { this.#timer = undefined; this.paint(); }, 32).unref();
  }
  paint() {
    if (this.#closed) return;
    clearTimeout(this.#timer); this.#timer = undefined; this.#erase(); this.#wrapTail();
    const footer = this.footer();
    const lines = this.#tail ? [this.#tail, ...(footer?.lines ?? [])] : [...(footer?.lines ?? [])];
    if (!lines.length) return;
    const cursor = footer ? { row: footer.cursor.row + Number(Boolean(this.#tail)), column: footer.cursor.column }
      : { row: 0, column: terminalWidth(this.#tail) };
    this.output.write('\x1b[0m' + lines.join('\x1b[0m\r\n') + '\x1b[0m\r' +
      (lines.length - cursor.row - 1 ? `\x1b[${lines.length - cursor.row - 1}A` : '') +
      (cursor.column ? `\x1b[${cursor.column + 1}G` : ''));
    this.#shown = { lines, cursor };
  }
  close() {
    clearTimeout(this.#timer); this.#erase();
    if (this.#tail) this.#tailOutput?.write(this.#tail + '\x1b[0m\n');
    this.#tail = ''; this.#closed = true;
  }
}
