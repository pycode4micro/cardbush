import { terminalText, terminalWidth, terminalRows, terminalCursor } from './agentChatPresentation.mjs';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
type Position = { row: number; column: number };
export type ChatFooter = { lines: string[]; cursor: Position };
type OutputChunk = { text: string; output: NodeJS.WritableStream };

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
  #shownColumns = 0;
  #tail = '';
  #tailOutput?: NodeJS.WritableStream;
  #pending: OutputChunk[] = [];
  #timer?: ReturnType<typeof setTimeout>;
  #closed = false;
  constructor(readonly output: NodeJS.WriteStream, readonly footer: () => ChatFooter | undefined) {}
  #width() { return Math.max(2, (this.output.columns || 80) - 1); }
  #erase() {
    const shown = this.#shown;
    if (!shown) return '';
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
    return '\x1b[0m\r' + (up ? `\x1b[${up}A` : '') + '\x1b[0J';
  }
  #append(text: string, output: NodeJS.WritableStream) {
    if (!text) return;
    const last = this.#pending.at(-1);
    if (last?.output === output) last.text += text;
    else this.#pending.push({ text, output });
  }
  #frame(chunks: OutputChunk[]) {
    const writes: OutputChunk[] = [];
    // DECSET 2026 keeps intermediate erase/repaint states off screen, including
    // when a terminal parses one Node write in several rendering batches.
    for (const chunk of [{ text: '\x1b[?2026h\x1b[?25l', output: this.output }, ...chunks, { text: '\x1b[?25h\x1b[?2026l', output: this.output }]) {
      if (!chunk.text) continue;
      // This viewport owns one console cursor. Its stdout/stderr TTY handles
      // must share one write queue; separate Windows pipe writes can interleave.
      // Redirected output keeps its own stream and never joins terminal frames.
      const output = this.output.isTTY && (chunk.output as NodeJS.WriteStream).isTTY ? this.output : chunk.output;
      const last = writes.at(-1);
      if (last?.output === output) last.text += chunk.text;
      else writes.push({ text: chunk.text, output });
    }
    // Never yield with the input erased or the cursor sitting on a status row.
    // Interactive transcript and footer updates are one synchronized write.
    for (const { text, output } of writes) output.write(text);
  }
  #wrapTail() {
    // Long unbroken/code lines must not make the transient area taller than the
    // viewport. Commit complete visual rows and retain the final partial row.
    const width = this.#width();
    if (terminalWidth(this.#tail) <= width) return;
    let row = '', column = 0, style = '', link = ''; const complete: string[] = [];
    for (const part of this.#tail.matchAll(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[\d;]*m|[^\x1b]+/g)) {
      if (part[0].startsWith('\x1b')) {
        row += part[0];
        if (part[0].startsWith('\x1b]8;')) link = /^\x1b\]8;;(?:\x07|\x1b\\)$/.test(part[0]) ? '' : part[0];
        else style = part[0] === '\x1b[0m' ? '' : style + part[0];
        continue;
      }
      for (const { segment } of graphemes.segment(part[0])) {
        const size = terminalWidth(segment);
        if (column + size > width) { complete.push(row + (link ? '\x1b]8;;\x1b\\' : '') + '\x1b[0m'); row = style + link; column = 0; }
        row += segment; column += size;
      }
    }
    if (complete.length && this.#tailOutput) this.#append(complete.join('\n') + '\n', this.#tailOutput);
    this.#tail = row;
  }
  write(text: string, output: NodeJS.WritableStream) {
    if (!text || this.#closed) return;
    if (this.#tail && this.#tailOutput !== output) {
      if (this.#tailOutput) this.#append(this.#tail + '\x1b[0m\n', this.#tailOutput);
      this.#tail = '';
    }
    this.#tailOutput = output;
    // A tab's physical width depends on its column. Expand it only for the TTY
    // view, so a partial code line cannot wrap underneath the input footer.
    let column = 0;
    const value = (this.#tail + text).replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g, part => {
      if (part.startsWith('\x1b')) return part;
      let result = '';
      for (const { segment } of graphemes.segment(part)) {
        if (segment === '\n') { result += segment; column = 0; }
        else if (segment === '\t') { const size = 8 - column % 8; result += ' '.repeat(size); column += size; }
        else { result += segment; column += terminalWidth(segment); }
      }
      return result;
    }), last = value.lastIndexOf('\n');
    if (last >= 0) this.#append(value.slice(0, last + 1), output);
    this.#tail = value.slice(last + 1); this.#wrapTail(); this.schedule();
  }
  schedule() {
    if (!this.#closed && !this.#timer) this.#timer = setTimeout(() => { this.#timer = undefined; this.paint(); }, 32).unref();
  }
  paint() {
    if (this.#closed) return;
    clearTimeout(this.#timer); this.#timer = undefined; this.#wrapTail();
    const footer = this.footer();
    const lines = this.#tail ? [this.#tail, ...(footer?.lines ?? [])] : [...(footer?.lines ?? [])];
    const cursor = footer ? { row: footer.cursor.row + Number(Boolean(this.#tail)), column: footer.cursor.column }
      : { row: 0, column: terminalWidth(this.#tail) };
    const shown = this.#shown, columns = this.output.columns || 80;
    if (shown && lines.length && !this.#pending.length && columns === this.#shownColumns && lines.length <= shown.lines.length) {
      // Keep already allocated rows until the next transcript append. Hints
      // disappearing/reappearing must not repeatedly scroll a bottom-row editor.
      while (lines.length < shown.lines.length) lines.push('');
      let update = '', position = { ...shown.cursor };
      const move = (target: Position) => {
        if (target.row === position.row && target.column === position.column) return;
        const delta = target.row - position.row;
        update += '\r' + (delta ? `\x1b[${Math.abs(delta)}${delta < 0 ? 'A' : 'B'}` : '') +
          (target.column ? `\x1b[${target.column + 1}G` : '');
        position = { ...target };
      };
      for (let row = 0; row < lines.length; row++) {
        if (lines[row] === shown.lines[row]) continue;
        move({ row, column: 0 });
        update += '\x1b[0m\x1b[0K' + lines[row] + '\x1b[0m';
        position.column = terminalWidth(lines[row]);
      }
      move(cursor);
      if (update) this.#frame([{ text: update, output: this.output }]);
    } else {
      const erase = this.#erase();
      const draw = lines.length ? '\x1b[0m' + lines.join('\x1b[0m\r\n') + '\x1b[0m\r' +
        (lines.length - cursor.row - 1 ? `\x1b[${lines.length - cursor.row - 1}A` : '') +
        (cursor.column ? `\x1b[${cursor.column + 1}G` : '') : '';
      if (erase || this.#pending.length || draw) this.#frame([
        { text: erase, output: this.output }, ...this.#pending, { text: draw, output: this.output },
      ]);
      this.#pending = [];
    }
    this.#shown = lines.length ? { lines, cursor } : undefined; this.#shownColumns = columns;
  }
  close() {
    if (this.#closed) return;
    clearTimeout(this.#timer);
    if (this.#tail && this.#tailOutput) this.#append(this.#tail + '\x1b[0m\n', this.#tailOutput);
    const erase = this.#erase();
    if (erase || this.#pending.length) this.#frame([{ text: erase, output: this.output }, ...this.#pending]);
    this.#pending = [];
    this.#tail = ''; this.#closed = true;
  }
}
