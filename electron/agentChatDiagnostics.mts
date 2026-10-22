import { appendRotatingLog } from './rotatingLog.js';
import { redactTroubleshootingText } from './pluginTroubleshooting.mjs';
import type { AgentRuntimeDiagnosticSink } from './agentRuntimeHost.mjs';

const maxLine = 32_768;

/** Diagnostics are bounded independently of chat output and readline's input.
 * Assemble lines before redacting, including secrets split between chunks. */
export class AgentChatDiagnostics {
  readonly #lines = { stdout: { text: '', oversized: false }, stderr: { text: '', oversized: false } };
  #error?: string;
  #closed = false;
  constructor(readonly path: string) {}
  get error() { return this.#error; }

  readonly write: AgentRuntimeDiagnosticSink = (stream, text) => {
    if (this.#closed || this.#error) return;
    const line = this.#lines[stream];
    for (let offset = 0; offset < text.length;) {
      const newline = text.indexOf('\n', offset), end = newline < 0 ? text.length : newline;
      if (!line.oversized) {
        if (line.text.length + end - offset > maxLine) { line.text = ''; line.oversized = true; }
        else line.text += text.slice(offset, end);
      }
      if (newline < 0) break;
      this.#flush(stream); offset = end + 1;
    }
  };

  #flush(stream: 'stdout' | 'stderr') {
    const line = this.#lines[stream];
    let message = line.oversized ? '[oversized diagnostic line omitted]' : line.text.trim();
    line.text = ''; line.oversized = false;
    if (!message || this.#error) return;
    try {
      // MCP stderr is already wrapped in JSON; redact its decoded message before
      // escaping it again, so quoted credentials do not bypass the shared filter.
      try {
        const record = JSON.parse(message);
        if (record && typeof record.message === 'string') {
          record.message = redactTroubleshootingText(record.message);
          message = JSON.stringify(record);
        }
      } catch { /* Plain worker diagnostics use the same text filter. */ }
      appendRotatingLog(this.path, { time: new Date().toISOString(), stream, message: redactTroubleshootingText(message) });
    } catch (error) {
      // Never fall back to printing raw plugin output into an active input line.
      // The CLI reports this once, at its next prompt boundary.
      const code = (error as NodeJS.ErrnoException).code;
      this.#error = code && /^[A-Z0-9_]+$/.test(code) ? code : 'LOG_WRITE_FAILED';
    }
  }

  close() {
    if (this.#closed) return;
    this.#flush('stdout'); this.#flush('stderr'); this.#closed = true;
  }
}
