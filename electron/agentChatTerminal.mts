import { createInterface, type Interface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { providerStreamActivity, providerActivityLabel, summarizeTaskPlanWaiting, type RuntimeEvent, type TaskPlan, type CommittedTurn } from '@cardbush/bush-protocol';
import type { ChatTerminal } from './agentChatCli.mjs';
import { ChatMarkdown, chatHeader, chatInputChunk, terminalClip, terminalCursor, terminalRows, terminalStyle, terminalText, terminalWidth, type ChatIdentity } from './agentChatPresentation.mjs';
import { ChatPasteDecoder, ChatPastes } from './agentChatInput.mjs';
import { applyChatSuggestion, choiceSuggestions, commandSuggestions, type ChatInputOptions, type ChatSuggestions, type ChatSuggestionSource } from './agentChatCompletion.mjs';
import { ChatLiveViewport, chatInputViewport, type ChatFooter } from './agentChatViewport.mjs';
import { terminalSupportsHyperlinks, type ChatReferenceRenderer } from './agentChatLinks.mjs';
import { runChatShell } from './agentChatShell.mjs';
import { ChatToolActivity, isChatToolEvent } from './agentChatTools.mjs';

type Input = NodeJS.ReadStream;
type Output = NodeJS.WriteStream;
type Options = { input?: Input; output?: Output; status?: Output; env?: NodeJS.ProcessEnv; shell?: typeof runChatShell };
type ActiveSuggestions = { line: string; cursor: number; value: ChatSuggestions; selected: number; navigated?: boolean };

/** Readline owns editing/history/wrapping. Only transient status and suggestion
 * rows are rewritten; completed text stays in native terminal scrollback. */
export class NativeChatTerminal implements ChatTerminal {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly hyperlinks: boolean;
  get selectionMenus() { return this.#controls; }
  readonly #input: Input;
  readonly #output: Output;
  readonly #status: Output;
  readonly #controls: boolean;
  readonly #styledAnswers: boolean;
  #reader?: Interface;
  #keys?: PassThrough;
  #promptOutput?: Writable;
  #waiting?: (value: string | null) => void;
  #closed = false;
  #chatPrompt = false;
  #inputOptions: ChatInputOptions = {};
  #detailOffset = 0;
  #suggestionSource?: ChatSuggestionSource;
  #suggestions?: ActiveSuggestions;
  #hintPosition?: { below: number; cols: number };
  #hintTimer?: ReturnType<typeof setTimeout>;
  #hintAbort?: AbortController;
  #inputRevision = 0;
  #history: string[] = [];
  #models: string[] = [];
  #identity?: ChatIdentity;
  #markdown: ChatMarkdown;
  #pastes = new ChatPastes();
  #decoder?: ChatPasteDecoder;
  #escapeTimer?: ReturnType<typeof setTimeout>;
  #ticker?: ReturnType<typeof setInterval>;
  #started = 0;
  #runtimeStarted?: number;
  #runtimeCompleted?: number;
  #turn = false;
  #answerOpen = false;
  #statusVisible = false;
  #statusLabel = '';
  #activity = 'Working';
  #compacting = false;
  #tools = new ChatToolActivity();
  #summaries = new ChatToolActivity();
  #replyPhase: 'execution' | 'pending' | 'final' = 'execution';
  #planSummary = '';
  #utf8 = new StringDecoder('utf8');
  #live?: ChatLiveViewport;
  #runningInput?: (text: string) => void;
  #pendingInput: string[] = [];
  #suspended = 0;
  #savedDraft?: { line: string; cursor: number };
  #queued = 0;
  #guidance = new Set<string>();
  #references?: ChatReferenceRenderer;
  #external = false;
  readonly #shell: typeof runChatShell;
  constructor(readonly interrupt: () => void, options: Options = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#status = options.status ?? process.stderr;
    this.#shell = options.shell ?? runChatShell;
    const env = options.env ?? process.env;
    this.interactive = Boolean(this.#input.isTTY && this.#status.isTTY);
    this.#controls = this.interactive && env.TERM !== 'dumb';
    this.color = this.#controls && env.NO_COLOR === undefined;
    this.hyperlinks = this.#controls && terminalSupportsHyperlinks(env);
    this.#styledAnswers = this.interactive && Boolean(this.#output.isTTY) && env.TERM !== 'dumb';
    this.#markdown = new ChatMarkdown(text => { this.#clearStatus(); this.#emit(text, this.#output); }, this.color,
      () => this.#output.columns || this.#status.columns || 80,
      { link: (label, target) => this.#references?.link(label, target), path: value => this.#references?.path?.(value),
        source: number => this.#references?.source?.(number) });
    if (!this.interactive) return;
    const source = this.#input;
    this.#keys = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (raw: boolean) => { source.setRawMode?.(raw); return this.#keys; } });
    // Readline's resize handler must not repaint a reply or tool status while
    // no input prompt is active. Forward only prompt resizes to readline.
    this.#promptOutput = new Writable({ write: (chunk, _encoding, done) => {
      if (this.#live) { this.#live.schedule(); done(); return; }
      this.#hideHints();
      const text = chunk.toString();
      if (this.#chatPrompt && this.color) {
        // clearLine emits CRLF after moving to the end. Fill only the remaining
        // cells of this submitted input row, without padding/wrapping spaces.
        // At the right margin EL would erase the last glyph, so omit it there.
        if (text === '\r\n' && this.#reader?.line.trim() && this.#reader.getCursorPos().cols > 0) {
          this.#status.write('\x1b[48;5;236m\x1b[K\x1b[49m');
        }
        this.#status.write(chatInputChunk(text));
      } else this.#status.write(text);
      done();
    } });
    Object.defineProperty(this.#promptOutput, 'columns', { get: () => this.#status.columns });
    this.#reader = createInterface({ input: this.#keys, output: this.#promptOutput, terminal: true,
      historySize: 100, removeHistoryDuplicates: true,
      // Tab only fills the selected suggestion. Readline still owns editing,
      // wrapping and history; displaying hints never executes a command.
      completer: () => [[], ''],
    });
    this.#reader.on('history', history => {
      if (this.#chatPrompt) this.#history = [...history];
      else history.splice(0, history.length, ...this.#history);
    });
    this.#reader.on('line', line => {
      if (this.#live && this.#editing() && !this.#chatPrompt && !this.#inputOptions.transient) {
        const prompt = this.#reader!.getPrompt();
        this.#markdown.flush();
        this.#emit('\n' + prompt + terminalText(line) + '\n', this.#status);
      }
      const expanded = this.#pastes.expand(line);
      if (this.#waiting) this.#waiting(expanded);
      else if (this.#live && !this.#suspended && line.trim()) {
        if (this.#turn) this.#runningInput?.(expanded);
        else if (this.#pendingInput.length < 32) this.#pendingInput.push(expanded);
        else this.status('Input queue is full; this message was not submitted. Use input history to retry.\n');
      }
      if (this.#live) { this.#invalidateHints(); this.#live.schedule(); }
    });
    this.#reader.on('close', () => { this.#closed = true; this.#waiting?.(null); interrupt(); });
    this.#reader.on('SIGINT', interrupt);
    this.#keys.on('keypress', (_text, key) => {
      if (key?.name === 'escape' && this.#editing()) this.#clearDraft();
      if (key?.name === 'tab' && this.#editing()) void this.#completeInput();
      else this.#scheduleHints();
    });
    this.#decoder = new ChatPasteDecoder(text => {
      // Input packets may contain typed text and Enter (or arrows and Enter).
      // Handle these keys in order, after the decoder has isolated pasted text.
      for (const key of text.split(/(\x1b\[[0-?]*[ -/]*[@-~]|\r\n|[\r\n\t])/).filter(Boolean)) this.#handleInput(key);
    }, text => {
      try { if (this.#editing()) {
        this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); this.#suggestions = undefined;
        this.#keys!.write(this.#pastes.add(text));
      } }
      catch (error) { this.#inputNotice(error instanceof Error ? error.message : 'Cannot paste.'); }
    }, () => this.#inputNotice('Paste exceeds 1,000,000 characters. Reference a file instead.'), () => this.#editing());
    this.#input.on('data', this.#onData); this.#input.once('end', this.#onEnd);
    this.#status.on('resize', this.#resize);
    if (this.#controls) this.#status.write('\x1b[?2004h');
    this.#input.resume();
  }
  #handleInput(text: string) {
    // Windows sends LF for Ctrl+Enter (also Ctrl+J). Other terminals may
    // report CSI-u or modifyOtherKeys. CRLF remains one ordinary Enter.
    const immediate = text === '\n' || /^\x1b\[13;5(?::[12])?u$/.test(text) || text === '\x1b[27;5;13~';
    if (text === '\x1b[13;5:3u') return; // A key release must never submit twice.
    if (immediate && this.#editing()) {
      if (this.#turn && this.#chatPrompt && !this.#suspended && this.#reader!.line.trim() && !this.#reader!.line.trimStart().startsWith('/')) {
        // Use the existing durable guidance path, including receipt recovery and
        // the race where a running task finishes before guidance arrives.
        this.#replaceDraft('/steer ' + this.#reader!.line);
      }
      text = '\r';
    }
    if (this.#live && this.#turn && (text === '\x03' || text === '\x1b' && !(this.#waiting && this.#inputOptions.picker))) {
      if (text === '\x1b' && /^\s*\/(?:artifact|source)\s/.test(this.#reader!.line)) {
        this.#clearDraft(); this.#invalidateHints(); this.#live.schedule(); return;
      }
      this.interrupt(); return;
    }
    if (this.#editing()) {
      if (this.#inputOptions.details?.length && ['\x1b[5~', '\x1b[6~'].includes(text)) {
        this.#detailOffset = Math.max(0, this.#detailOffset + (text === '\x1b[6~' ? 5 : -5));
        this.#drawHints(); return;
      }
      // The paste decoder has already distinguished a standalone Escape from
      // an arrow sequence. Do not make readline wait a second ambiguity timer,
      // which could consume the next slash as Alt+/ instead of cancelling.
      if (text === '\x1b') {
        const cancel = this.#inputOptions.picker?.cancelValue;
        this.#hideHints(); this.#clearDraft(); this.#invalidateHints();
        if (cancel !== undefined) this.#waiting?.(cancel);
        this.#live?.schedule(); return;
      }
      if (text === '\t') { void this.#completeInput(); return; }
      if (this.#suggestions?.value.items.length && ['\x1b[A', '\x1b[B', '\x1b[Z'].includes(text)) {
        const choice = this.#suggestions, direction = text === '\x1b[B' ? 1 : -1;
        if (!choice.navigated && !this.#inputOptions.picker && !this.#chatPrompt && !choice.line.trim()) {
          choice.selected = direction > 0 ? 0 : choice.value.items.length - 1;
        } else choice.selected = (choice.selected + direction + choice.value.items.length) % choice.value.items.length;
        choice.navigated = true;
        this.#drawHints(); return;
      }
      if (/^[\r\n]+$/.test(text) && this.#confirmSuggestion()) return;
      this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer);
      this.#suggestions = undefined; this.#keys!.write(text);
      if (this.#editing() && this.#reader && (this.#reader.line || this.#inputOptions.choices?.length)) {
        const value = this.#localHints();
        if (value) this.#suggestions = { line: this.#reader.line, cursor: this.#reader.cursor, value, selected: this.#initialSelection(value) };
      }
    }
    else if (text.includes('\x03') || text === '\x1b') this.interrupt();
  }
  #onData = (data: Buffer | string) => {
    if (this.#external) return;
    this.#decoder!.feed(typeof data === 'string' ? data : this.#utf8.write(data));
    // Readline may emit several writes for one key/paste. Paint once after it
    // finishes editing, instead of leaving the caret a frame behind the input.
    this.#live?.paint();
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = setTimeout(() => this.#decoder?.flushEscape(), 60).unref();
  };
  #onEnd = () => { this.#decoder?.close(); this.#keys?.end(); };
  #resize = () => {
    if (this.#external) return;
    if (this.#live) { this.#live.paint(); return; }
    if (this.#waiting) {
      // Readline redraws its own input and clears below it after a reflow. Do not
      // use the old hint coordinates with the new terminal width.
      this.#hintPosition = undefined; this.#promptOutput?.emit('resize'); this.#drawHints();
    }
    else if (this.#statusVisible) { this.#clearStatus(); this.#drawStatus(); }
  };
  #width() { return Math.max(10, (this.#status.columns || 80) - 1); }
  #style(text: string, style: Parameters<typeof terminalStyle>[1]) { return terminalStyle(text, style, this.color); }
  #emit(text: string, output = this.#status) {
    if (this.#live && output.isTTY) this.#live.write(text, output);
    else output.write(text);
  }
  #editing() { return !this.#external && Boolean(this.#waiting || this.#live && !this.#suspended); }
  get runningShell() { return this.#external; }
  async runShell(command: string, cwd: string, signal: AbortSignal) {
    if (!this.interactive || !this.#reader) throw new Error('Native shell commands require an interactive terminal.');
    if (this.#turn || this.#external || this.#waiting) throw new Error('Finish the current task or prompt before opening a shell.');
    signal.throwIfAborted();
    const resume = this.suspendInput(), live = Boolean(this.#live), raw = this.#input.isRaw ?? true;
    this.#hideHints(); this.#invalidateHints(); this.#markdown.flush(); this.#clearStatus();
    this.#decoder?.invalidate(); this.#decoder?.close(); clearTimeout(this.#escapeTimer);
    this.#live?.close(); this.#live = undefined;
    this.#external = true;
    this.#input.off('data', this.#onData); this.#reader.pause(); this.#input.pause();
    this.#input.setRawMode?.(false);
    if (this.#controls) this.#status.write('\x1b[0m\x1b[?25h\x1b[?2004l');
    try { return await this.#shell(command, cwd, signal); }
    finally {
      this.#external = false;
      if (!this.#closed) {
        this.#input.setRawMode?.(raw);
        if (this.#controls) this.#status.write('\x1b[0m\x1b[?25h\x1b[?2004h\r\n');
        if (live) this.#live = new ChatLiveViewport(this.#status, () => this.#footer());
        this.#input.on('data', this.#onData); this.#reader.resume(); this.#input.resume();
        resume(); this.#live?.paint();
      }
    }
  }
  #invalidateHints() {
    this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer); this.#suggestions = undefined;
  }
  /** Enable a persistent editor after model setup. Plain/redirected terminals
   * retain the sequential readline interface. */
  enableLiveInput(onInput: (text: string) => void) {
    if (!this.#controls || !this.#reader) return;
    this.#runningInput = onInput;
    this.#live = new ChatLiveViewport(this.#status, () => this.#footer());
    this.#chatPrompt = true; this.#inputOptions = { chat: true };
    this.#reader.setPrompt('❯ '); this.#live.paint();
  }
  setQueued(count: number) { this.#queued = count; this.#live?.schedule(); }
  clearDraftIf(text: string) {
    if (this.#reader && this.#pastes.expand(this.#reader.line) === text) this.#clearDraft();
  }
  flushPendingInput() {
    // Only the controller can hand buffered input to an active job. Starting
    // the turn's renderer alone must leave deferred messages available to ask().
    if (this.#turn && this.#live && !this.#suspended) for (const text of this.#pendingInput.splice(0)) this.#runningInput?.(text);
  }
  /** The controller commits chat input when its turn starts (or a local command
   * runs). Enter only submits it; queued input must not split the current reply. */
  commitInput(text: string) {
    if (!this.#live || !text.trim()) return;
    // Reuse the submitted display, including folded paste markers. Resumed jobs
    // may have no local input history, so keep their prompt preview bounded.
    const line = this.#history.find(line => this.#pastes.expand(line) === text)
      ?? terminalClip(terminalText(text).replaceAll('\n', ' '), 1000);
    this.#markdown.flush(); this.#flushToolGroup();
    const prompt = '❯ ' + terminalText(line);
    this.#emit('\n' + (this.color ? chatInputChunk(prompt) : prompt) + '\n', this.#status);
  }
  trackGuidance(messageId: string) { this.#guidance.add(messageId); }
  guidanceQueued(messageId: string) { if (this.#guidance.has(messageId)) this.status('[Queued] Guidance sent to the current task.\n'); }
  forgetGuidance(messageId: string) { this.#guidance.delete(messageId); }
  suspendInput() {
    if (!this.#live || !this.#reader) return () => {};
    if (!this.#suspended++) {
      this.#savedDraft = { line: this.#reader.line, cursor: this.#reader.cursor };
      this.#invalidateHints(); this.#decoder?.invalidate(); this.#clearDraft(); this.#chatPrompt = false;
      this.#live.schedule();
    }
    let resumed = false;
    return () => {
      if (resumed) return; resumed = true;
      if (--this.#suspended || this.#closed) return;
      this.#invalidateHints(); this.#decoder?.invalidate(); this.#chatPrompt = true; this.#inputOptions = { chat: true };
      this.#reader!.setPrompt('❯ ');
      const draft = this.#savedDraft; this.#savedDraft = undefined;
      if (draft) this.#replaceDraft(draft.line, draft.cursor);
      this.#scheduleHints(); this.#live?.schedule();
    };
  }
  restoreDraft(text: string) {
    if (!this.#live || !this.#reader || this.#suspended || this.#reader.line) return;
    this.#replaceDraft(this.#pastes.add(text)); this.#scheduleHints();
  }
  #replaceDraft(line: string, cursor = line.length) {
    this.#clearDraft(); this.#reader!.write(line);
    while (this.#reader!.cursor > cursor) {
      const before = this.#reader!.cursor; this.#reader!.write(null, { name: 'left' });
      if (before === this.#reader!.cursor) break;
    }
  }
  #footer(): ChatFooter | undefined {
    if (this.#closed || !this.#reader) return;
    const width = Math.max(2, (this.#status.columns || 80) - 1), rows = this.#status.rows || 24;
    const lines: string[] = [];
    if (this.#turn) lines.push(this.#style(terminalClip(this.#activityLabel() + (this.#queued ? ` · ${this.#queued} queued` : ''), width), 'dim'));
    if (!this.#editing()) return lines.length ? { lines, cursor: { row: lines.length - 1, column: 0 } } : undefined;
    if (rows >= 8) lines.push(this.#style('─'.repeat(Math.min(width, 104)), 'dim'));
    if (this.#inputOptions.picker) lines.push(this.#style(terminalClip(this.#inputOptions.picker.title, width), 'bold'));
    lines.push(...this.#promptDetails(width, Math.max(2, rows - lines.length - 8)));
    const input = chatInputViewport(this.#chatPrompt ? '❯ ' : this.#reader.getPrompt(), this.#reader.line, this.#reader.cursor,
      width, Math.max(1, Math.min(4, rows - lines.length - 5)));
    const cursor = { row: lines.length + input.cursor.row, column: input.cursor.column };
    lines.push(...input.lines.map(line => this.#chatPrompt && this.color ? chatInputChunk(line) + '\x1b[48;5;236m\x1b[K\x1b[49m' : line));
    const suggestions = this.#suggestions;
    if (suggestions && suggestions.line === this.#reader.line && suggestions.cursor === this.#reader.cursor) {
      const capacity = Math.max(0, Math.min(this.#inputOptions.picker ? 9 : 3, rows - lines.length - 3));
      lines.push(...this.#suggestionRows(suggestions, capacity, width));
      lines.push(this.#style(terminalClip(suggestions.value.notice ?? (suggestions.value.items.length
        ? this.#hintHelp(suggestions) : '  No matches; keep typing to filter'), width), 'dim'));
    } else if (this.#chatPrompt) lines.push(this.#style(terminalClip(this.#turn
      ? '  Enter queue · Ctrl+Enter guide now · /steer · Esc stop'
      : '  Enter send · / commands · @ files · Tab complete', width), 'dim'));
    return { lines, cursor };
  }
  setSuggestionSource(source: ChatSuggestionSource) { this.#suggestionSource = source; }
  setReferenceRenderer(references: ChatReferenceRenderer) { this.#references = references; }
  #promptDetails(width: number, capacity: number) {
    const details = this.#inputOptions.details;
    if (!details?.length) return [];
    const lines = chatInputViewport('', details.map(terminalText).join('\n'), 0, width, Number.MAX_SAFE_INTEGER).lines;
    if (lines.length <= capacity) { this.#detailOffset = 0; return lines; }
    const visible = Math.max(1, capacity - 1);
    this.#detailOffset = Math.min(this.#detailOffset, lines.length - visible);
    return [...lines.slice(this.#detailOffset, this.#detailOffset + visible),
      this.#style(terminalClip(`Details ${this.#detailOffset + 1}–${this.#detailOffset + visible}/${lines.length} · PgUp/PgDn scroll`, width), 'dim')];
  }
  #initialSelection(value: ChatSuggestions) {
    return this.#reader?.line.trim() ? 0 : Math.max(0, value.items.findIndex(item => item.value === this.#inputOptions.picker?.selected));
  }
  #suggestionRows(suggestions: ActiveSuggestions, capacity: number, width: number) {
    const { value, selected } = suggestions;
    const start = Math.max(0, Math.min(selected - capacity + 1, value.items.length - capacity));
    const picker = Boolean(this.#inputOptions.picker);
    const labelWidth = Math.min(42, Math.floor(width * 0.5));
    return value.items.slice(start, start + capacity).map((item, index) => {
      const active = index + start === selected && Boolean(picker || this.#chatPrompt || suggestions.line.trim() || suggestions.navigated);
      const label = item.label ?? item.value.trim();
      const clipped = terminalClip(label, labelWidth);
      const name = picker && width >= 60 ? clipped + ' '.repeat(Math.max(0, labelWidth - terminalWidth(clipped))) : label;
      const text = terminalClip(`  ${active ? '›' : ' '} ${name}${item.description && (!picker || width >= 60) ? '  ' + item.description : ''}`, width);
      return picker && active && this.color ? `\x1b[48;5;24;97m${text}${' '.repeat(Math.max(0, width - terminalWidth(text)))}\x1b[0m`
        : this.#style(text, active ? 'blue' : 'dim');
    });
  }
  #hideHints() {
    const position = this.#hintPosition;
    if (!position) return;
    this.#hintPosition = undefined;
    this.#status.write(`\r\x1b[${position.below}B\x1b[0J\x1b[${position.below}A\x1b[${position.cols + 1}G`);
  }
  #drawHints() {
    if (this.#live) { this.#live.schedule(); return; }
    this.#hideHints();
    if (!this.#controls || !this.#waiting || !this.#reader || !this.#suggestions) return;
    const { line, cursor, value } = this.#suggestions;
    if (line !== this.#reader.line || cursor !== this.#reader.cursor) return;
    const position = this.#reader.getCursorPos(), columns = this.#status.columns || 80;
    const end = terminalCursor(this.#reader.getPrompt() + line, columns);
    const picker = this.#inputOptions.picker;
    const details = this.#promptDetails(columns - 1, Math.max(2, (this.#status.rows || 24) - end.rows - 8));
    const capacity = Math.min(picker ? 9 : 3, (this.#status.rows || 24) - end.rows - (picker ? 4 : 3) - details.length);
    if (capacity < 1) return;
    const lines = [...(picker ? [this.#style(terminalClip(picker.title, columns - 1), 'bold')] : []),
      ...details,
      ...this.#suggestionRows(this.#suggestions, capacity, columns - 1)];
    lines.push(this.#style(terminalClip(value.notice ?? (value.items.length ? this.#hintHelp(this.#suggestions) : '  No matches; keep typing to filter'), columns - 1), 'dim'));
    const below = Math.max(1, end.rows - position.rows + 1);
    // Newlines reserve actual rows even at the bottom of the viewport. Only
    // this small prompt-owned footer is removed, never transcript history.
    this.#status.write('\r' + '\n'.repeat(below) + lines.join('\r\n') + `\r\x1b[${below + lines.length - 1}A\x1b[${position.cols + 1}G`);
    this.#hintPosition = { below, cols: position.cols };
  }
  #scheduleHints() {
    clearTimeout(this.#hintTimer);
    if (this.#editing()) this.#hintTimer = setTimeout(() => { void this.#loadHints(); }, 60).unref();
  }
  #hintHelp(suggestion: ActiveSuggestions) {
    if (this.#inputOptions.picker) return `  ↑/↓ select · Enter confirm · Esc ${this.#inputOptions.picker.cancelLabel ?? 'back'} · Tab complete · ${suggestion.selected + 1}/${suggestion.value.items.length}`;
    const enter = !this.#chatPrompt && !suggestion.line.trim() && !suggestion.navigated ? 'default' : suggestion.value.submitOnEnter ? 'confirm' : 'complete';
    return `  Enter ${enter} · Tab complete · ↑/↓ select · ${suggestion.selected + 1}/${suggestion.value.items.length}`;
  }
  #localHints() {
    const { line, cursor } = this.#reader!;
    if (this.#inputOptions.picker && line.trimStart().startsWith('/')) {
      return choiceSuggestions(line, cursor, [
        { value: '/cancel', description: 'Return to chat without changes' },
        ...(this.#inputOptions.picker.cancelValue === '/cancel' ? [] : [{ value: this.#inputOptions.picker.cancelValue, description: 'Back' }]),
      ]);
    }
    return this.#chatPrompt ? commandSuggestions(line, cursor, this.#models.map(id => ({ id, modelName: id })))
      : choiceSuggestions(line, cursor, this.#inputOptions.choices ?? []);
  }
  async #loadHints() {
    if (!this.#editing() || !this.#reader || this.#closed) return;
    const line = this.#reader.line, cursor = this.#reader.cursor, revision = this.#inputRevision;
    this.#hintAbort?.abort(); const controller = this.#hintAbort = new AbortController();
    const valid = () => !controller.signal.aborted && this.#editing() && !this.#closed && revision === this.#inputRevision && this.#reader?.line === line && this.#reader.cursor === cursor;
    const local = this.#localHints();
    if (local && valid() && (this.#suggestions?.line !== line || this.#suggestions.cursor !== cursor)) {
      this.#suggestions = { line, cursor, value: local, selected: this.#initialSelection(local) }; this.#drawHints();
    }
    try {
      const value = this.#chatPrompt && this.#suggestionSource ? await this.#suggestionSource(line, cursor, controller.signal) : local;
      if (!valid()) return;
      const current = this.#suggestions;
      const selectedValue = current?.value.items[current.selected]?.value
        ?? /^\s*\/(?:artifact|source)\s+([1-9]\d*)\s*$/.exec(line)?.[1];
      const selected = Math.max(0, value?.items.findIndex(item => item.value === selectedValue) ?? 0);
      this.#suggestions = value ? { line, cursor, value, selected, navigated: current?.navigated } : undefined; this.#drawHints();
      return this.#suggestions;
    } catch { if (valid()) { this.#suggestions = undefined; this.#hideHints(); } }
  }
  async #completeInput() {
    if (!this.#editing() || !this.#reader) return;
    clearTimeout(this.#hintTimer);
    const revision = this.#inputRevision;
    const suggestion = this.#suggestions ?? await this.#loadHints();
    if (!this.#editing() || revision !== this.#inputRevision || !suggestion ||
      suggestion.line !== this.#reader.line || suggestion.cursor !== this.#reader.cursor) return;
    const choice = /^\s*\/(?:artifact|source)\s+([1-9]\d*)\s*$/.exec(this.#reader.line);
    const selected = choice && suggestion.value.items[suggestion.selected]?.value === choice[1]
      ? (suggestion.selected + 1) % suggestion.value.items.length : suggestion.selected;
    const applied = applyChatSuggestion(this.#reader.line, suggestion.value, selected);
    if (!applied) return;
    this.#applySuggestion(applied);
    this.#scheduleHints();
  }
  #confirmSuggestion() {
    if (!this.#controls || !this.#reader) return false;
    const { line, cursor } = this.#reader;
    const current = this.#suggestions;
    const suggestion = current?.line === line && current.cursor === cursor ? current : undefined;
    // Empty input keeps a text prompt's default. Arrow navigation is an explicit
    // choice and must submit the highlighted item, just like a dedicated picker.
    if (!line.trim() && !this.#inputOptions.picker && !suggestion?.navigated) return false;
    // Built-in commands work even before the hint debounce or a remote catalog
    // request finishes. Enter never waits for a remote result to change input.
    const value = suggestion?.value ?? (!this.#chatPrompt || /^\s*\/\S*$/.test(line) ? this.#localHints() : undefined);
    if (!value) return false;
    const applied = applyChatSuggestion(line, value, suggestion?.selected ?? this.#initialSelection(value));
    if (!applied || applied.line === line && applied.cursor === cursor) return false;
    this.#applySuggestion(applied);
    if (value.submitOnEnter) return false;
    // A file/path is inserted into the draft; a second Enter sends the message.
    this.#scheduleHints(); return true;
  }
  #applySuggestion(applied: { line: string; cursor: number }) {
    this.#hideHints(); this.#invalidateHints();
    // Use public readline editing operations, not its private refresh methods or
    // mutable internals. The suffix after the caret is restored as authored.
    this.#replaceDraft(applied.line, applied.cursor);
  }
  #clearDraft() {
    if (!this.#reader?.line) return;
    this.#reader.write(null, { ctrl: true, name: 'u' }); this.#reader.write(null, { ctrl: true, name: 'k' });
  }
  #inputNotice(text: string) { this.status('\n' + text + '\n'); this.#reader?.prompt(true); this.#scheduleHints(); }
  #clearStatus() {
    if (this.#statusVisible) {
      const rows = terminalRows(this.#statusLabel, this.#status.columns || 80);
      this.#status.write('\r' + (rows > 1 ? `\x1b[${rows - 1}A\x1b[0J` : '\x1b[2K'));
      this.#statusVisible = false; this.#statusLabel = '';
    }
  }
  #drawStatus() {
    if (this.#live) { this.#live.schedule(); return; }
    if (!this.#controls || !this.#turn || this.#answerOpen || this.#waiting || this.#closed) return;
    const label = terminalClip(this.#activityLabel() + ' · Esc / Ctrl+C to stop', Math.min(76, this.#width()));
    this.#status.write('\r\x1b[2K' + this.#style(label, 'dim')); this.#statusVisible = true; this.#statusLabel = label;
  }
  #activityLabel() {
    const elapsedMs = this.#elapsed(), elapsed = elapsedMs / 1000;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const group = this.#tools.current();
    const activity = group && !this.#compacting ? this.#toolGroupLabel(group, this.#width() - 14) : this.#activity;
    // Keep a margin at the right edge; resize compensation only clears this
    // owned status row. Completed transcript rows are never repainted.
    // Streaming chunks and keystrokes may repaint faster than the ticker; they
    // must not advance the spinner or dirty an otherwise unchanged status row.
    return `${frames[Math.floor(elapsedMs / 120) % frames.length]} ${activity}${this.#runtimeStarted !== undefined ? ` · ${elapsed.toFixed(1)}s` : ''}`;
  }
  #toolGroupLabel(group: NonNullable<ReturnType<ChatToolActivity['current']>>, width: number) {
    const suffix = ` · ${group.count} tool${group.count === 1 ? '' : 's'}` +
      (group.failed ? ` · ${group.failed} failed` : '') + (group.cancelled ? ` · ${group.cancelled} cancelled` : '') + ' · /tools';
    return terminalClip(group.selected.title, Math.max(8, width - terminalWidth(suffix))) + suffix;
  }
  #flushToolGroup() {
    const group = this.#tools.takeGroup();
    if (!group || !this.#controls) return;
    this.#clearStatus();
    const pending = group.pending ? ` · ${group.pending} pending` : '';
    this.#emit(this.#style(terminalClip(`  ${group.failed ? '!' : '·'} ${this.#toolGroupLabel(group, this.#width() - 4 - pending.length)}${pending}`, this.#width()), 'dim') + '\n');
  }
  #section(title: string) {
    this.#markdown.end(); this.#answerOpen = false; this.#clearStatus();
    if (!this.#controls || !this.#output.isTTY) return;
    const label = `── ${title} `, width = Math.min(this.#width() - 2, 100);
    this.#emit('\n' + this.#style('  ' + terminalClip(label + '─'.repeat(Math.max(0, width - terminalWidth(label))), width), 'blue') + '\n\n');
  }
  identify(identity: ChatIdentity, models: string[]) {
    this.#identity = identity; this.#models = models;
    if (this.interactive) this.#emit(chatHeader(identity, this.#status.columns || 80, this.color));
    else this.status(`\n${identity.name} · ${identity.model} · ${identity.permission}${identity.effort ? ` · Effort: ${identity.effort}` : ''}\n${identity.workspace ? `Workspace: ${identity.workspace}\n` : ''}Session: ${identity.sessionId}\n`);
  }
  updateModel(model: string, models: string[], effort?: string) { if (this.#identity) { this.#identity.model = model; this.#identity.effort = effort; } this.#models = models; }
  resetSession() {
    this.#markdown.end(); this.#tools.reset(); this.#summaries.reset(); this.#replyPhase = 'execution'; this.#planSummary = ''; this.#guidance.clear();
    this.#queued = 0; this.#pendingInput = []; this.#savedDraft = undefined; this.#answerOpen = false;
    this.#clearDraft(); this.#invalidateHints(); this.#live?.schedule();
  }
  /** Replay final prose without starting a timer or manufacturing live events. */
  historyTurn(turn: CommittedTurn) {
    this.status(`\nTurn ${turn.turnSequence} · ${turn.status} · /tools --turn ${turn.turnSequence}\n`);
    for (const entry of turn.messages) {
      if (entry.message.role === 'user') this.commitInput(entry.message.content);
      else if (entry.message.role === 'assistant') {
        if (this.#styledAnswers) { this.#markdown.write(entry.message.content); this.#markdown.end(); }
        else this.#emit(terminalText(entry.message.content) + '\n', this.#output);
      }
    }
    if (!turn.messages.some(entry => entry.message.role === 'assistant')) this.status('[No final reply in this turn]\n');
  }
  #elapsed() {
    return Math.max(0, this.#runtimeStarted === undefined ? performance.now() - this.#started : (this.#runtimeCompleted ?? Date.now()) - this.#runtimeStarted);
  }
  beginTurn(input?: string) {
    if (input !== undefined) this.commitInput(input);
    this.#turn = true; this.#started = performance.now(); this.#runtimeStarted = undefined; this.#runtimeCompleted = undefined;
    this.#compacting = false;
    this.#tools.reset(); this.#summaries.reset(); this.#replyPhase = 'execution'; this.#activity = 'Waiting to start'; this.#planSummary = '';
    if (this.interactive) {
      this.#emit('\n');
      if (!this.#controls) this.status('[Working]\n');
      else { this.#drawStatus(); this.#ticker = setInterval(() => this.#drawStatus(), 120).unref(); }
    }
  }
  finishTurn(outcome: 'completed' | 'stopped' | 'failed' | 'detached' | 'interrupted') {
    this.#markdown.end(); this.#answerOpen = false; this.#flushToolGroup();
    this.#clearStatus(); clearInterval(this.#ticker); this.#ticker = undefined; this.#turn = false;
    if (this.interactive) {
      const duration = (this.#elapsed() / 1000).toFixed(1);
      const summary = `${outcome === 'completed' ? '✓ Completed' : outcome === 'stopped' ? '· Stopped' : outcome === 'detached' ? '· Observation paused' : outcome === 'interrupted' ? '· Interrupted' : '! Task failed'} · ${duration}s` +
        (this.#tools.count ? ` · ${this.#tools.count} tool call${this.#tools.count === 1 ? '' : 's'}` : '') + (this.#tools.failures ? ` · ${this.#tools.failures} failure${this.#tools.failures === 1 ? '' : 's'}` : '');
      this.#emit(this.#style(summary, outcome === 'completed' ? 'blue' : outcome === 'failed' ? 'error' : 'dim') + '\n');
    }
  }
  write(text: string) {
    if (text.trim() && this.#replyPhase === 'pending') { this.#replyPhase = 'final'; this.#section('Final reply'); }
    if (text.trim()) this.#flushToolGroup();
    this.#clearStatus();
    if (this.#turn && this.#styledAnswers) this.#markdown.write(text);
    else this.#emit(terminalText(text), this.#output);
    this.#answerOpen = !text.endsWith('\n');
  }
  status(text: string) {
    this.#hideHints(); this.#markdown.flush(); this.#flushToolGroup(); this.#clearStatus();
    this.#emit(terminalText(text));
  }
  event(event: RuntimeEvent) {
    if (event.kind === 'guidance_applied' && this.#replyPhase === 'pending') this.#replyPhase = 'execution';
    if (event.kind === 'guidance_applied' && this.#guidance.delete(event.payload.messageId)) {
      this.status('[Applied] Guidance received by the current task.\n'); return;
    }
    if (event.kind === 'turn_started') {
      const time = Date.parse(event.createdAt); if (Number.isFinite(time)) this.#runtimeStarted = time;
      this.#activity = 'Working';
    } else if (event.kind === 'turn_terminal') {
      const time = Date.parse(event.createdAt); if (Number.isFinite(time)) this.#runtimeCompleted = time;
    } else if (event.kind === 'assistant_segment_completed') {
      this.#markdown.end(); this.#answerOpen = false; this.#activity = 'Working';
    } else if (event.kind === 'reasoning_segment_started') this.#activity = 'Thinking';
    else if (event.kind === 'reasoning_segment_completed') this.#activity = 'Working';
    else if (isChatToolEvent(event)) {
      if (event.payload.toolName === 'summary_for_user') {
        if (!this.#summaries.update(event)) return;
        if (['tool_queued', 'tool_running'].includes(event.kind) || event.kind === 'tool_returned' && !event.payload.resultError) {
          if (event.kind === 'tool_returned' && !this.#tools.tools.some(tool => tool.state === 'queued' || tool.state === 'running')) {
            this.#flushToolGroup(); this.#replyPhase = 'pending';
          }
          this.#activity = 'Preparing final reply';
          if (this.#turn) this.#drawStatus();
          return;
        }
      }
      if (!this.#tools.update(event)) return;
      if (this.#replyPhase === 'final') this.#section('Tool activity');
      this.#replyPhase = 'execution';
      this.#markdown.flush(); this.#clearStatus();
      // Redirected/dumb terminals remain append-only diagnostics. Interactive
      // terminals keep the changing group inside their existing owned footer.
      if (!this.#controls) {
        const tool = this.#tools.tools.find(item => item.id === event.payload.toolCallId)!;
        const name = terminalText(tool.title);
        if (event.kind === 'tool_running') this.status(`[Tool] ${name}\n`);
        else if (tool.error) this.status(`[Tool failed] ${name}: ${tool.error.message}\n`);
        else if (tool.state === 'cancelled') this.status(`[Tool cancelled] ${name}\n`);
      }
    } else if (event.kind === 'context_compaction_started') { this.#compacting = true; this.#activity = 'Compacting context'; }
    else if (['context_compaction_completed', 'context_compaction_failed', 'context_compaction_cancelled'].includes(event.kind)) {
      this.#compacting = false; this.#activity = 'Working';
    } else if (event.kind === 'provider_stream_diagnostic') {
      const activity = providerStreamActivity(event.payload);
      this.#activity = this.#compacting ? 'Compacting context' : activity ? providerActivityLabel(activity) : 'Working';
    } else if (event.kind === 'provider_retry') {
      this.#activity = this.#compacting ? 'Compacting context · waiting to retry' : 'Waiting to retry';
      this.status(`[Provider] ${terminalText(event.payload.code)}; retry in ${Math.ceil(event.payload.nextRetryMs / 1000)}s.\n`);
    }
    else return;
    if (this.#turn) this.#drawStatus();
  }
  plan(plan: TaskPlan | null, detailed = false) {
    if (!plan) { if (detailed) this.status('No plan for this session.\n'); return; }
    const completed = plan.nodes.filter(node => node.status === 'completed').length;
    const current = plan.nodes.find(node => node.status === 'in_progress');
    const waiting = summarizeTaskPlanWaiting(plan);
    const summary = `Plan ${completed}/${plan.nodes.length}${current ? ` · ${current.step}` : waiting ? ` · Waiting: ${waiting.reason}` : ''}`;
    if (!detailed && (summary === this.#planSummary || !this.interactive)) return;
    this.#planSummary = summary; this.#flushToolGroup(); this.#clearStatus();
    this.#emit(this.#style('  ' + terminalClip(summary, this.#width() - 2), 'blue') + '\n');
    if (detailed) {
      for (const [index, node] of plan.nodes.entries()) this.status(`  ${node.status === 'completed' ? '✓' : node.status === 'in_progress' ? '›' : '○'} ${index + 1}. ${node.step}${node.waitingFor ? ` (${node.waitingFor})` : ''}\n`);
    }
  }
  ask(prompt: string, signal: AbortSignal, options: boolean | ChatInputOptions = {}): Promise<string | null> {
    if (!this.#reader || this.#closed || signal.aborted) return Promise.resolve(null);
    const input = typeof options === 'boolean' ? { chat: options } : options, chat = Boolean(input.chat);
    if (chat && this.#pendingInput.length) return Promise.resolve(this.#pendingInput.shift()!);
    const resume = !chat ? this.suspendInput() : () => {};
    this.#hideHints(); this.#markdown.flush(); this.#clearStatus();
    if (!this.#live || !chat) this.#clearDraft();
    this.#chatPrompt = chat; this.#inputOptions = input; this.#detailOffset = 0;
    const temporaryViewport = Boolean(input.transient && this.#controls && !this.#live);
    if (temporaryViewport) this.#live = new ChatLiveViewport(this.#status, () => this.#footer());
    if (chat && this.interactive && !this.#live) this.#status.write('\n');
    return new Promise(resolve => {
      const finish = (value: string | null) => {
        this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer); this.#suggestions = undefined;
        this.#waiting = undefined; signal.removeEventListener('abort', abort); this.#reader?.setPrompt('');
        if (temporaryViewport) { this.#live?.close(); this.#live = undefined; }
        this.#decoder?.invalidate(); this.#chatPrompt = Boolean(this.#live && !this.#suspended);
        if (this.#chatPrompt) this.#reader?.setPrompt('❯ ');
        resume(); this.#inputOptions = this.#chatPrompt ? { chat: true } : {}; this.#live?.schedule(); resolve(value);
      };
      const abort = () => finish(null);
      this.#waiting = finish; signal.addEventListener('abort', abort, { once: true });
      this.#reader!.setPrompt(chat ? this.#style('❯ ', 'blue') : terminalText(prompt)); this.#reader!.prompt(Boolean(this.#live));
      if (input.picker || input.choices?.length) {
        const value = this.#localHints();
        if (value) this.#suggestions = { line: this.#reader!.line, cursor: this.#reader!.cursor, value, selected: this.#initialSelection(value) };
        this.#drawHints();
      }
      this.#scheduleHints();
    });
  }
  close() {
    this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer); this.#suggestions = undefined;
    this.#closed = true; clearInterval(this.#ticker); clearTimeout(this.#escapeTimer); this.#markdown.end(); this.#flushToolGroup(); this.#clearStatus();
    this.#input.off('data', this.#onData); this.#input.off('end', this.#onEnd); this.#status.off('resize', this.#resize);
    this.#decoder?.close(); this.#reader?.removeAllListeners('close'); this.#waiting?.(null); this.#reader?.close(); this.#keys?.destroy(); this.#promptOutput?.destroy();
    this.#live?.close();
    this.#input.pause();
    if (this.#controls) this.#status.write('\x1b[?2004l');
  }
}
