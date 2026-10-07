import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { conversationEntrySchema, type ConversationEntry } from '@cardbush/bush-protocol';
import { AssistantModelHistory } from './assistantModelHistory.js';

/** External conversation messages never reserve or alter a foreground Turn sequence. */
export class ConversationJournal {
  private cache = new Map<string, ConversationEntry[]>();
  private histories = new Map<string, AssistantModelHistory>();
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
    const old = entries.find(item => item.id === entry.id);
    if (old) {
      if (old.content !== entry.content || old.role !== entry.role || old.source !== entry.source || old.visibility !== entry.visibility || JSON.stringify(old.attachments) !== JSON.stringify(entry.attachments)) throw Error('Conversation message ID reused with different content.');
      return old;
    }
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file(sessionId), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
    this.cache.set(sessionId, [...entries, entry]);
    return entry;
  }
  forget(sessionId: string) { this.modelHistory(sessionId).clear(); rmSync(this.file(sessionId), { force: true }); this.cache.delete(sessionId); }
}
