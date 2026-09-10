import { ResponseOutputIndex } from './responsesOutputIndex.js';

type TextKind = 'text' | 'refusal' | 'reasoning' | 'summary';
type Delta = { kind: 'text_delta' | 'reasoning_delta'; delta: string };
type Item = { type: string; id?: string; content?: unknown; summary?: unknown };

export class ResponseTextError extends Error {
  readonly code = 'provider_text_changed';
  constructor() { super('The provider changed text that had already been streamed.'); }
}

/** Final text is another observation of the same content part, not a new message. */
export class ResponseText {
  readonly #active = new Map<'text' | 'reasoning', number>();
  readonly #parts = new Map<string, { text: string; done: boolean }>();
  constructor(readonly outputIndex: ResponseOutputIndex) {}

  #part(kind: TextKind, index: number, part: number, text: string, done: boolean, append: (event: Delta) => void): void {
    const key = JSON.stringify([kind, index, part]);
    const previous = this.#parts.get(key) ?? { text: '', done: false };
    if ((done && (!text.startsWith(previous.text) || (previous.done && text !== previous.text))) || (!done && previous.done && text)) {
      throw new ResponseTextError();
    }
    const delta = done ? text.slice(previous.text.length) : text;
    this.#parts.set(key, { text: done ? text : previous.text + text, done });
    if (delta) append({ kind: kind === 'text' || kind === 'refusal' ? 'text_delta' : 'reasoning_delta', delta });
  }

  event(event: { type: string; output_index?: number; item_id?: string; content_index?: number; summary_index?: number; delta?: string; text?: string; refusal?: string },
    append: (event: Delta) => void): void {
    const kind: TextKind = event.type.includes('refusal') ? 'refusal' : event.type.includes('reasoning_summary') ? 'summary'
      : event.type.includes('reasoning_text') ? 'reasoning' : 'text';
    const channel = kind === 'text' || kind === 'refusal' ? 'text' : 'reasoning';
    const index = event.output_index ?? this.outputIndex.index(event.item_id) ?? this.#active.get(channel) ?? 0;
    this.outputIndex.observe(index, event.item_id, channel === 'text' ? 'message' : 'reasoning');
    const done = event.type.endsWith('.done');
    const text = done ? event.text ?? event.refusal : event.delta;
    if (typeof text === 'string') this.#part(kind, index, event.content_index ?? event.summary_index ?? 0, text, done, append);
  }

  item(item: Item, index: number, completed: boolean, append: (event: Delta) => void, snapshot = false): void {
    if (snapshot) index = this.outputIndex.index(item.id) ?? index;
    this.outputIndex.observe(index, item.id, item.type);
    if (item.type === 'message') this.#active.set('text', index);
    if (item.type === 'reasoning') this.#active.set('reasoning', index);
    if (!completed) return;
    if (Array.isArray(item.content)) for (const [partIndex, part] of item.content.entries()) {
      if (part?.type === 'output_text' && typeof part.text === 'string') this.#part('text', index, partIndex, part.text, true, append);
      if (part?.type === 'refusal' && typeof part.refusal === 'string') this.#part('refusal', index, partIndex, part.refusal, true, append);
      if (part?.type === 'reasoning_text' && typeof part.text === 'string') this.#part('reasoning', index, partIndex, part.text, true, append);
    }
    if (Array.isArray(item.summary)) for (const [partIndex, part] of item.summary.entries()) {
      if (part?.type === 'summary_text' && typeof part.text === 'string') this.#part('summary', index, partIndex, part.text, true, append);
    }
  }
}
