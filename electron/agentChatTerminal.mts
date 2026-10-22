import { createInterface, type Interface } from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { runtimeToolLifecycle, summarizeTaskPlanWaiting, type RuntimeEvent, type TaskPlan } from '@cardbush/bush-protocol';
import type { ChatTerminal } from './agentChatCli.mjs';
import { ChatMarkdown, chatHeader, chatInputChunk, terminalClip, terminalCursor, terminalRows, terminalStyle, terminalText, type ChatIdentity } from './agentChatPresentation.mjs';
import { ChatPasteDecoder, ChatPastes } from './agentChatInput.mjs';
import { applyChatSuggestion, choiceSuggestions, commandSuggestions, type ChatInputOptions, type ChatSuggestions, type ChatSuggestionSource } from './agentChatCompletion.mjs';
import { ChatLiveViewport, chatInputViewport, type ChatFooter } from './agentChatViewport.mjs';

type Input = NodeJS.ReadStream;
type Output = NodeJS.WriteStream;
type Options = { input?: Input; output?: Output; status?: Output; env?: NodeJS.ProcessEnv };

/** Readline owns editing/history/wrapping. Only transient status and suggestion
 * rows are rewritten; completed text stays in native terminal scrollback. */
export class NativeChatTerminal implements ChatTerminal {
  readonly interactive: boolean;
  readonly color: boolean;
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
  #suggestionSource?: ChatSuggestionSource;
  #suggestions?: { line: string; cursor: number; value: ChatSuggestions; selected: number };
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
  #frame = 0;
  #tools = new Map<string, string>();
  #toolCount = 0;
  #failedCount = 0;
  #seenTools = new Set<string>();
  #finishedTools = new Set<string>();
  #planSummary = '';
  #utf8 = new StringDecoder('utf8');
  #live?: ChatLiveViewport;
  #runningInput?: (text: string) => void;
  #pendingInput: string[] = [];
  #suspended = 0;
  #savedDraft?: { line: string; cursor: number };
  #queued = 0;
  #guidance = new Set<string>();
  constructor(readonly interrupt: () => void, options: Options = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#status = options.status ?? process.stderr;
    const env = options.env ?? process.env;
    this.interactive = Boolean(this.#input.isTTY && this.#status.isTTY);
    this.#controls = this.interactive && env.TERM !== 'dumb';
    this.color = this.#controls && env.NO_COLOR === undefined;
    this.#styledAnswers = this.interactive && Boolean(this.#output.isTTY) && env.TERM !== 'dumb';
    this.#markdown = new ChatMarkdown(text => { this.#clearStatus(); this.#emit(text, this.#output); }, this.color,
      () => this.#output.columns || this.#status.columns || 80);
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
      // wrapping and history; hints never execute a command or submit a choice.
      completer: () => [[], ''],
    });
    this.#reader.on('history', history => {
      if (this.#chatPrompt) this.#history = [...history];
      else history.splice(0, history.length, ...this.#history);
    });
    this.#reader.on('line', line => {
      if (this.#live && this.#editing()) {
        const prompt = this.#chatPrompt ? '❯ ' : this.#reader!.getPrompt();
        this.#markdown.flush();
        this.#emit('\n' + (this.#chatPrompt && this.color ? chatInputChunk(prompt + line) : prompt + line) + '\n', this.#status);
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
      if (this.#live && this.#turn && (text === '\x03' || text === '\x1b')) { interrupt(); return; }
      if (this.#editing()) {
        if (text === '\t') { void this.#completeInput(); return; }
        if (this.#suggestions?.value.items.length && ['\x1b[A', '\x1b[B', '\x1b[Z'].includes(text)) {
          const choice = this.#suggestions, direction = text === '\x1b[B' ? 1 : -1;
          choice.selected = (choice.selected + direction + choice.value.items.length) % choice.value.items.length;
          this.#drawHints(); return;
        }
        this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer);
        this.#suggestions = undefined; this.#keys!.write(text);
      }
      else if (text.includes('\x03') || text === '\x1b') interrupt();
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
  #onData = (data: Buffer | string) => {
    this.#decoder!.feed(typeof data === 'string' ? data : this.#utf8.write(data));
    clearTimeout(this.#escapeTimer);
    this.#escapeTimer = setTimeout(() => this.#decoder?.flushEscape(), 60).unref();
  };
  #onEnd = () => { this.#decoder?.close(); this.#keys?.end(); };
  #resize = () => {
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
  #editing() { return Boolean(this.#waiting || this.#live && !this.#suspended); }
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
    const input = chatInputViewport(this.#chatPrompt ? '❯ ' : this.#reader.getPrompt(), this.#reader.line, this.#reader.cursor,
      width, Math.max(1, Math.min(4, rows - lines.length - 5)));
    const cursor = { row: lines.length + input.cursor.row, column: input.cursor.column };
    lines.push(...input.lines.map(line => this.#chatPrompt && this.color ? chatInputChunk(line) + '\x1b[48;5;236m\x1b[K\x1b[49m' : line));
    const suggestions = this.#suggestions;
    if (suggestions && suggestions.line === this.#reader.line && suggestions.cursor === this.#reader.cursor) {
      const capacity = Math.max(0, Math.min(3, rows - lines.length - 3)), start = Math.max(0, suggestions.selected - capacity + 1);
      lines.push(...suggestions.value.items.slice(start, start + capacity).map((item, index) => this.#style(
        terminalClip(`  ${index + start === suggestions.selected ? '›' : ' '} ${item.label ?? item.value.trim()}${item.description ? '  ' + item.description : ''}`, width), index + start === suggestions.selected ? 'blue' : 'dim')));
      lines.push(this.#style(terminalClip(suggestions.value.notice ?? (suggestions.value.items.length
        ? `  Tab complete · ↑/↓ select · ${suggestions.selected + 1}/${suggestions.value.items.length}` : '  No matches; keep typing to filter'), width), 'dim'));
    } else if (this.#chatPrompt) lines.push(this.#style(terminalClip(this.#turn
      ? '  Enter queue · /steer guide · Esc / Ctrl+C stop'
      : '  Enter send · / commands · @ files · Tab complete', width), 'dim'));
    return { lines, cursor };
  }
  setSuggestionSource(source: ChatSuggestionSource) { this.#suggestionSource = source; }
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
    const { line, cursor, value, selected } = this.#suggestions;
    if (line !== this.#reader.line || cursor !== this.#reader.cursor) return;
    const position = this.#reader.getCursorPos(), columns = this.#status.columns || 80;
    const end = terminalCursor(this.#reader.getPrompt() + line, columns);
    const capacity = Math.min(3, (this.#status.rows || 24) - end.rows - 3);
    if (capacity < 1) return;
    const start = Math.max(0, selected - capacity + 1), lines = value.items.slice(start, start + capacity).map((item, index) =>
      this.#style(terminalClip(`  ${start + index === selected ? '›' : ' '} ${item.label ?? item.value.trim()}${item.description ? '  ' + item.description : ''}`, columns - 1), start + index === selected ? 'blue' : 'dim'));
    lines.push(this.#style(terminalClip(value.notice ?? (value.items.length ? `  Tab complete · ↑/↓ select · ${selected + 1}/${value.items.length} · Enter submit input` : '  No matches; keep typing to filter'), columns - 1), 'dim'));
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
  async #loadHints() {
    if (!this.#editing() || !this.#reader || this.#closed) return;
    const line = this.#reader.line, cursor = this.#reader.cursor, revision = this.#inputRevision;
    this.#hintAbort?.abort(); const controller = this.#hintAbort = new AbortController();
    const valid = () => !controller.signal.aborted && this.#editing() && !this.#closed && revision === this.#inputRevision && this.#reader?.line === line && this.#reader.cursor === cursor;
    const local = this.#chatPrompt ? commandSuggestions(line, cursor, this.#models.map(id => ({ id, modelName: id })))
      : choiceSuggestions(line, cursor, this.#inputOptions.choices ?? []);
    if (local && valid()) { this.#suggestions = { line, cursor, value: local, selected: 0 }; this.#drawHints(); }
    try {
      const value = this.#chatPrompt && this.#suggestionSource ? await this.#suggestionSource(line, cursor, controller.signal) : local;
      if (!valid()) return;
      const selectedValue = this.#suggestions?.value.items[this.#suggestions.selected]?.value;
      const selected = Math.max(0, value?.items.findIndex(item => item.value === selectedValue) ?? 0);
      this.#suggestions = value ? { line, cursor, value, selected } : undefined; this.#drawHints();
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
    const applied = applyChatSuggestion(this.#reader.line, suggestion.value, suggestion.selected);
    if (!applied) return;
    this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); this.#suggestions = undefined;
    // Use public readline editing operations, not its private refresh methods or
    // mutable internals. The suffix after the caret is restored as authored.
    this.#reader.write(null, { ctrl: true, name: 'u' }); this.#reader.write(null, { ctrl: true, name: 'k' });
    this.#reader.write(applied.line);
    for (const _char of applied.line.slice(applied.cursor)) this.#reader.write(null, { name: 'left' });
    this.#scheduleHints();
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
    const elapsed = this.#elapsed() / 1000;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const activity = this.#tools.size ? [...this.#tools.values()].at(-1)! + (this.#tools.size > 1 ? ` · ${this.#tools.size} tools` : '') : this.#activity;
    // Keep a margin at the right edge; resize compensation only clears this
    // owned status row. Completed transcript rows are never repainted.
    return `${frames[this.#frame++ % frames.length]} ${activity}${this.#runtimeStarted !== undefined ? ` · ${elapsed.toFixed(1)}s` : ''}`;
  }
  identify(identity: ChatIdentity, models: string[]) {
    this.#identity = identity; this.#models = models;
    if (this.interactive) this.#emit(chatHeader(identity, this.#status.columns || 80, this.color));
    else this.status(`\n${identity.name} · ${identity.model} · ${identity.permission}\n${identity.workspace ? `Workspace: ${identity.workspace}\n` : ''}Session: ${identity.sessionId}\n`);
  }
  updateModel(model: string, models: string[]) { if (this.#identity) this.#identity.model = model; this.#models = models; }
  #elapsed() {
    return Math.max(0, this.#runtimeStarted === undefined ? performance.now() - this.#started : (this.#runtimeCompleted ?? Date.now()) - this.#runtimeStarted);
  }
  beginTurn() {
    this.#turn = true; this.#started = performance.now(); this.#runtimeStarted = undefined; this.#runtimeCompleted = undefined;
    this.#tools.clear(); this.#seenTools.clear(); this.#finishedTools.clear(); this.#toolCount = 0; this.#failedCount = 0; this.#activity = 'Waiting to start'; this.#planSummary = '';
    if (this.interactive) {
      this.#emit('\n');
      if (!this.#controls) this.status('[Working]\n');
      else { this.#drawStatus(); this.#ticker = setInterval(() => this.#drawStatus(), 120).unref(); }
    }
  }
  finishTurn(outcome: 'completed' | 'stopped' | 'failed') {
    this.#markdown.end(); this.#answerOpen = false;
    this.#clearStatus(); clearInterval(this.#ticker); this.#ticker = undefined; this.#turn = false;
    if (this.interactive) {
      const duration = (this.#elapsed() / 1000).toFixed(1);
      const summary = `${outcome === 'completed' ? '✓ Completed' : outcome === 'stopped' ? '· Stopped' : '! Task failed'} · ${duration}s` +
        (this.#toolCount ? ` · ${this.#toolCount} tool call${this.#toolCount === 1 ? '' : 's'}` : '') + (this.#failedCount ? ` · ${this.#failedCount} failure${this.#failedCount === 1 ? '' : 's'}` : '');
      this.#emit(this.#style(summary, outcome === 'completed' ? 'blue' : outcome === 'failed' ? 'error' : 'dim') + '\n');
    }
  }
  write(text: string) {
    this.#clearStatus();
    if (this.#turn && this.#styledAnswers) this.#markdown.write(text);
    else this.#emit(terminalText(text), this.#output);
    this.#answerOpen = !text.endsWith('\n');
  }
  status(text: string) {
    this.#hideHints(); this.#markdown.flush(); this.#clearStatus();
    this.#emit(terminalText(text));
  }
  event(event: RuntimeEvent) {
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
    else if (event.kind === 'tool_running' || event.kind === 'tool_returned' || event.kind === 'tool_failed' || event.kind === 'tool_cancelled') {
      this.#markdown.flush(); this.#clearStatus();
      const tool = runtimeToolLifecycle(event), name = terminalText(tool.title);
      if (this.#finishedTools.has(tool.id)) return;
      if (!this.#seenTools.has(tool.id)) { this.#seenTools.add(tool.id); this.#toolCount++; }
      if (tool.state === 'running') {
        this.#tools.set(tool.id, name);
        if (!this.#controls) this.status(`[Tool] ${name}\n`);
      } else {
        this.#tools.delete(tool.id); this.#finishedTools.add(tool.id);
        if (tool.error) { this.#failedCount++; this.status(`[Tool failed] ${name}: ${tool.error.message}\n`); }
        else if (this.interactive) this.#emit(this.#style(`  ${tool.state === 'cancelled' ? '· Cancelled' : '✓'} ${terminalClip(name, this.#width() - 12)}`, 'dim') + '\n');
      }
    } else if (event.kind === 'context_compaction_started') this.#activity = 'Compacting context';
    else if (event.kind === 'context_compaction_completed') this.#activity = 'Working';
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
    this.#planSummary = summary; this.#clearStatus();
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
    this.#chatPrompt = chat; this.#inputOptions = input;
    if (chat && this.interactive && !this.#live) this.#status.write('\n');
    return new Promise(resolve => {
      const finish = (value: string | null) => {
        this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer); this.#suggestions = undefined;
        this.#waiting = undefined; signal.removeEventListener('abort', abort); this.#reader?.setPrompt('');
        this.#decoder?.invalidate(); this.#chatPrompt = Boolean(this.#live && !this.#suspended);
        if (this.#chatPrompt) this.#reader?.setPrompt('❯ ');
        resume(); this.#live?.schedule(); resolve(value);
      };
      const abort = () => finish(null);
      this.#waiting = finish; signal.addEventListener('abort', abort, { once: true });
      this.#reader!.setPrompt(chat ? this.#style('❯ ', 'blue') : terminalText(prompt)); this.#reader!.prompt(Boolean(this.#live));
      this.#scheduleHints();
    });
  }
  close() {
    this.#hideHints(); this.#inputRevision++; this.#hintAbort?.abort(); clearTimeout(this.#hintTimer); this.#suggestions = undefined;
    this.#closed = true; clearInterval(this.#ticker); clearTimeout(this.#escapeTimer); this.#markdown.end(); this.#clearStatus();
    this.#input.off('data', this.#onData); this.#input.off('end', this.#onEnd); this.#status.off('resize', this.#resize);
    this.#decoder?.close(); this.#reader?.removeAllListeners('close'); this.#waiting?.(null); this.#reader?.close(); this.#keys?.destroy(); this.#promptOutput?.destroy();
    this.#live?.close();
    this.#input.pause();
    if (this.#controls) this.#status.write('\x1b[?2004l');
  }
}
