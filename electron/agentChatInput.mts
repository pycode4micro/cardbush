import { terminalText } from './agentChatPresentation.mjs';

const start = '\x1b[200~', end = '\x1b[201~';
const maxPaste = 1_000_000;

/** Recognize terminal paste frames before readline can treat embedded newlines
 * as submissions. Keep the old CLI's compact paste idea, not its raw key editor. */
export class ChatPasteDecoder {
  #carry = '';
  #pasting = false;
  #paste = '';
  #overflow = false;
  #accepted = false;
  #carryAccepted = false;
  constructor(readonly forward: (text: string) => void, readonly paste: (text: string) => void,
    readonly reject: () => void, readonly accepting: () => boolean) {}
  feed(text: string) {
    if (!this.#pasting && !this.#carry && !text.includes('\x1b') &&
      (text.length > 1000 || /[\r\n]/.test(text.replace(/\r?\n$|\r$/, '')))) {
      if (this.accepting()) text.length > maxPaste ? this.reject() : this.paste(text);
      return;
    }
    const continuingMarker = Boolean(this.#carry);
    if (!continuingMarker) this.#carryAccepted = this.accepting();
    this.#carry += text;
    while (this.#carry) {
      const marker = this.#pasting ? end : start, index = this.#carry.indexOf(marker);
      if (index >= 0) {
        this.#consume(this.#carry.slice(0, index)); this.#carry = this.#carry.slice(index + marker.length);
        if (this.#pasting) {
          if (this.#accepted) this.#overflow ? this.reject() : this.paste(this.#paste);
          this.#paste = ''; this.#pasting = false; this.#overflow = false;
        } else { this.#pasting = true; this.#accepted = this.#carryAccepted && this.accepting(); }
      } else {
        let retained = Math.min(this.#carry.length, marker.length - 1);
        while (retained && !marker.startsWith(this.#carry.slice(-retained))) retained--;
        // Modified keys can arrive across several reads, just like paste markers.
        // Keep an incomplete CSI until its final byte, without interpreting it as
        // Escape (stop) or inserting the remainder into the user's draft.
        if (!this.#pasting) retained = Math.max(retained, /\x1b(?:\[[0-?]*[ -/]*)?$/.exec(this.#carry)?.[0].length ?? 0);
        this.#consume(this.#carry.slice(0, this.#carry.length - retained));
        this.#carry = retained ? this.#carry.slice(-retained) : '';
        break;
      }
    }
  }
  #consume(text: string) {
    if (!text) return;
    if (!this.#pasting) { this.forward(text); return; }
    if (!this.#accepted || this.#overflow) return;
    if (this.#paste.length + text.length > maxPaste) { this.#overflow = true; this.#paste = ''; }
    else this.#paste += text;
  }
  flushEscape() {
    // A standalone Escape key is not an incomplete bracketed paste.
    if (!this.#pasting && this.#carry === '\x1b') { this.#carry = ''; this.forward('\x1b'); }
  }
  // A partial paste belongs to the prompt where it began, never a later approval.
  invalidate() { this.#accepted = false; this.#carryAccepted = false; }
  close() { this.#carry = ''; this.#paste = ''; this.#pasting = false; }
}

export class ChatPastes {
  #items = new Map<string, string>();
  #sequence = 0;
  #size = 0;
  add(value: string) {
    const text = terminalText(value);
    if (!text) return '';
    if (!text.includes('\n') && text.length <= 1000) return text.replaceAll('\t', '    ');
    if (text.length > maxPaste || this.#size + text.length > 8_000_000) throw new Error('Paste too large. Reference a file instead.');
    const lines = text.split('\n').length;
    const token = `[Paste ${++this.#sequence} · ${lines} line${lines === 1 ? '' : 's'} · ${text.length} chars]`;
    this.#items.set(token, text); this.#size += text.length; return token;
  }
  expand(line: string) {
    // One pass: literal markers inside a pasted document never expand recursively.
    return line.replace(/\[Paste \d+ · \d+ lines? · \d+ chars\]/g, marker => this.#items.get(marker) ?? marker);
  }
}
