import type { ChatMessage } from '../../types';

export function visibleVoiceMessages(messages: ChatMessage[]): ChatMessage[] {
  const visible = (message: ChatMessage) => message.metadata?.visibility !== 'internal' && !message.metadata?.__bush_superseded && !message.metadata?.superseded && !message.metadata?.is_superseded && !message.metadata?.isSuperseded;
  return messages.flatMap(message => visible(message) ? [...(message.loopHistory ?? []).filter(visible), message] : []);
}

export function spokenText(text: string) {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '').replace(/[`*_#>|~]/g, '').replace(/\s+/g, ' ').trim();
}
/** Buffer prose into bounded phrases while excluding fenced code. */
export class SpeechPhrases {
  private pending = '';
  private code = false;
  append(delta: string, complete = false): string[] {
    this.pending += delta;
    const out: string[] = [];
    for (;;) {
      const fence = this.pending.indexOf('```');
      if (this.code) {
        if (fence < 0) { this.pending = complete ? '' : this.pending.slice(-2); break; }
        this.pending = this.pending.slice(fence + 3); this.code = false; continue;
      }
      const boundary = this.pending.search(/[。！？!?\n]|\.(?=\s|$)/);
      if (fence >= 0 && fence <= 240 && (boundary < 0 || fence < boundary)) {
        const phrase = spokenText(this.pending.slice(0, fence)); if (phrase) out.push(phrase);
        this.pending = this.pending.slice(fence + 3); this.code = true; continue;
      }
      let end = boundary >= 0 ? boundary + 1 : complete ? this.pending.length : -1;
      if ((end < 0 || end > 240) && this.pending.length > 240) {
        const match = /[，,；;、\s]/g; let found: RegExpExecArray | null; let cut = -1;
        while ((found = match.exec(this.pending.slice(0, 240)))) cut = found.index + 1;
        end = cut > 0 ? cut : 240;
        // Preserve a possible opening fence and surrogate pair across chunk boundaries.
        while (end > 0 && this.pending[end - 1] === '`') end--;
        if (end > 0 && /[\uD800-\uDBFF]/.test(this.pending[end - 1])) end--;
      }
      if (end <= 0) break;
      const phrase = spokenText(this.pending.slice(0, end)); this.pending = this.pending.slice(end);
      if (phrase) out.push(phrase);
    }
    return out;
  }
}
export class SpokenTranscript {
  private seen = new Map<string, { text: string; phrases: SpeechPhrases; muted: boolean; tools: Set<string> }>();
  private priorTurns = new Set<string>();
  private startedAt = 0;
  reset(messages: ChatMessage[]) {
    messages = visibleVoiceMessages(messages);
    this.seen.clear(); this.priorTurns = new Set(messages.flatMap(message => message.turnId ? [message.turnId] : []));
    this.startedAt = Date.now();
    for (const message of messages) if (message.role === 'assistant') this.seen.set(message.id, { text: message.content, phrases: new SpeechPhrases(), muted: false, tools: new Set(message.toolExecutions?.map(tool => tool.id)) });
  }
  skip(messages: ChatMessage[]) {
    messages = visibleVoiceMessages(messages);
    for (const message of messages) if (message.role === 'assistant') this.seen.set(message.id, { text: message.content, phrases: new SpeechPhrases(), muted: true, tools: new Set(message.toolExecutions?.map(tool => tool.id)) });
  }
  update(messages: ChatMessage[], activeTurnId: string | null | undefined, sending: boolean): string[] {
    messages = visibleVoiceMessages(messages);
    const out: string[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || message.metadata?.visibility === 'internal' || message.metadata?.__bush_superseded || message.metadata?.superseded || message.metadata?.is_superseded || message.metadata?.isSuperseded) continue;
      if (!this.seen.has(message.id) && message.turnId !== activeTurnId &&
        (message.turnId && this.priorTurns.has(message.turnId) || message.createdAt && Date.parse(message.createdAt) < this.startedAt)) continue;
      const previous = this.seen.get(message.id) ?? { text: '', phrases: new SpeechPhrases(), muted: false, tools: new Set<string>() };
      const toolBoundary = message.toolExecutions?.some(tool => !previous.tools.has(tool.id));
      for (const tool of message.toolExecutions ?? []) previous.tools.add(tool.id);
      if (!message.content.startsWith(previous.text)) { previous.muted = true; previous.phrases = new SpeechPhrases(); }
      if (!previous.muted) out.push(...previous.phrases.append(message.content.slice(previous.text.length),
        !sending || Boolean(toolBoundary) || Boolean(activeTurnId && message.turnId && message.turnId !== activeTurnId)));
      previous.text = message.content; this.seen.set(message.id, previous);
    }
    return out;
  }
  revised(messages: ChatMessage[]) {
    messages = visibleVoiceMessages(messages);
    return messages.some(message => {
      const previous = this.seen.get(message.id);
      return previous && !previous.muted && !message.content.startsWith(previous.text);
    });
  }
}
