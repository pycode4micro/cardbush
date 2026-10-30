import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { conversationEntrySchema, assistantReactionsSchema, type AssistantReaction, type ConversationEntry } from '@cardbush/bush-protocol';
import { AssistantModelHistory } from './assistantModelHistory.js';

/** External conversation messages never reserve or alter a foreground Turn sequence. */
export class ConversationJournal {
  private cache = new Map<string, ConversationEntry[]>();
  private histories = new Map<string, AssistantModelHistory>();
  private reactions = new Map<string, Record<string, AssistantReaction>>();
  constructor(private root: string) {}
  private file(sessionId: string) { return join(this.root, createHash('sha256').update(sessionId).digest('hex') + '.jsonl'); }
  modelHistory(sessionId: string) {
    let history = this.histories.get(sessionId);
    if (!history) { history = new AssistantModelHistory(this.file(sessionId).replace(/\.jsonl$/, '.model.jsonl')); this.histories.set(sessionId, history); }
    return history;
  }
  read(sessionId: string): ConversationEntry[] {
    let entries = this.cache.get(sessionId);
    if (!entries) {
      entries = [];
      const file = this.file(sessionId);
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8'), lines = raw.split('\n');
        let repaired = false;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try { entries.push(conversationEntrySchema.parse(JSON.parse(lines[i]))); }
          catch (error) {
            if (i < lines.length - 1) throw error;
            truncateSync(file, Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
            repaired = true;
          }
        }
        if (!repaired && lines.at(-1)?.trim()) appendFileSync(file, '\n');
      }
      this.cache.set(sessionId, entries);
    }
    return entries.map(item => ({ ...item }));
  }
  append(sessionId: string, value: ConversationEntry) {
    const entry = conversationEntrySchema.parse(value), entries = this.read(sessionId);
    if (entry.replyTo && (entry.role !== 'user' || !entries.some(item => item.id === entry.replyTo!.messageId && item.visibility === 'conversation' && !['voice', 'task'].includes(item.source)))) throw Error('assistant_quote_unavailable');
    const old = entries.find(item => item.id === entry.id);
    if (old) {
      if (old.content !== entry.content || old.role !== entry.role || old.source !== entry.source || old.visibility !== entry.visibility || JSON.stringify(old.attachments) !== JSON.stringify(entry.attachments) || JSON.stringify(old.promptContext) !== JSON.stringify(entry.promptContext) || JSON.stringify(old.replyTo) !== JSON.stringify(entry.replyTo)) throw Error('Conversation message ID reused with different content.');
      return old;
    }
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file(sessionId), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
    this.cache.set(sessionId, [...entries, entry]);
    return entry;
  }
  readReactions(sessionId: string): Record<string, AssistantReaction> {
    let state = this.reactions.get(sessionId);
    if (!state) {
      const file = this.file(sessionId) + '.reactions.json';
      state = existsSync(file) ? assistantReactionsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) : {};
      this.reactions.set(sessionId, state);
    }
    return { ...state };
  }
  setReaction(sessionId: string, messageId: string, reaction: AssistantReaction | null) {
    if (!this.read(sessionId).some(item => item.id === messageId && item.visibility === 'conversation' && !['voice', 'task'].includes(item.source))) throw Error('assistant_message_unavailable');
    const state = { ...this.readReactions(sessionId), ...(reaction === null ? {} : { [messageId]: reaction }) };
    if (reaction === null) delete state[messageId];
    const file = this.file(sessionId) + '.reactions.json', temporary = file + '.' + randomUUID() + '.tmp';
    mkdirSync(this.root, { recursive: true });
    try {
      writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600, flush: true });
      renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
    this.reactions.set(sessionId, state);
    return this.readReactions(sessionId);
  }
  forget(sessionId: string) {
    this.modelHistory(sessionId).clear(); rmSync(this.file(sessionId), { force: true }); this.cache.delete(sessionId);
    rmSync(this.file(sessionId) + '.reactions.json', { force: true }); this.reactions.delete(sessionId);
  }
}
