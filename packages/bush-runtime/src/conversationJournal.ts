import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conversationEntrySchema, isAssistantPageMessage, assistantReactionsSchema, assistantProfileSchema, runtimeSessionTurnRequestSchema,
  type AssistantReaction, type ConversationEntry } from '@cardbush/bush-protocol';
import { AssistantModelHistory } from './assistantModelHistory.js';

const submissionSchema = z.object({ parent: runtimeSessionTurnRequestSchema, profile: assistantProfileSchema });
const journalEntrySchema = conversationEntrySchema.extend({ submission: submissionSchema.optional() });
type JournalEntry = z.infer<typeof journalEntrySchema>;
type QueuedSubmission = z.infer<typeof submissionSchema>;

function visibleEntry({ submission: _submission, ...entry }: JournalEntry): ConversationEntry { return entry; }

/** External conversation messages never reserve or alter a foreground Turn sequence. */
export class ConversationJournal {
  private cache = new Map<string, JournalEntry[]>();
  private histories = new Map<string, AssistantModelHistory>();
  private reactions = new Map<string, Record<string, AssistantReaction>>();
  private replyPositions = new Map<string, { byId: Map<string, { index: number; at: string }>; latest?: { id: string; at: string } }>();
  constructor(private root: string, private onAppend?: (sessionId: string, entry: ConversationEntry) => void) {}
  private file(sessionId: string) { return join(this.root, createHash('sha256').update(sessionId).digest('hex') + '.jsonl'); }
  modelHistory(sessionId: string) {
    let history = this.histories.get(sessionId);
    if (!history) { history = new AssistantModelHistory(this.file(sessionId).replace(/\.jsonl$/, '.model.jsonl')); this.histories.set(sessionId, history); }
    return history;
  }
  private entries(sessionId: string): JournalEntry[] {
    let entries = this.cache.get(sessionId);
    if (!entries) {
      entries = [];
      const file = this.file(sessionId);
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8'), lines = raw.split('\n');
        let repaired = false;
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try { entries.push(journalEntrySchema.parse(JSON.parse(lines[i]))); }
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
    return entries;
  }
  read(sessionId: string): ConversationEntry[] {
    return this.entries(sessionId).map(visibleEntry);
  }
  queuedSubmission(sessionId: string, entryId: string): QueuedSubmission | undefined {
    const submission = this.entries(sessionId).find(item => item.id === entryId)?.submission;
    return submission && structuredClone(submission);
  }
  hasQueuedSubmission(sessionId: string, entryId: string): boolean {
    return this.entries(sessionId).some(item => item.id === entryId && item.submission !== undefined);
  }
  private indexReply(sessionId: string, entry: ConversationEntry) {
    const positions = this.replyPositions.get(sessionId);
    if (!positions || entry.role !== 'assistant' || !isAssistantPageMessage(entry)) return;
    positions.byId.set(entry.id, { index: positions.byId.size, at: entry.createdAt });
    positions.latest = { id: entry.id, at: entry.createdAt };
  }
  replyStatus(sessionId: string, after?: { id: string; at: string }) {
    let positions = this.replyPositions.get(sessionId);
    if (!positions) {
      const entries = this.entries(sessionId);
      positions = { byId: new Map() };
      this.replyPositions.set(sessionId, positions);
      for (const entry of entries) this.indexReply(sessionId, entry);
    }
    const { byId, latest } = positions;
    const position = after && byId.get(after.id);
    const unread = !after ? 0 : position ? byId.size - position.index - 1
      : !after.at ? byId.size : Array.from(byId.values()).filter(item => item.at > after.at).length;
    return { unread, ...(!after && latest ? { latest: { ...latest } } : {}) };
  }
  append(sessionId: string, value: ConversationEntry, submission?: QueuedSubmission) {
    const entry = journalEntrySchema.parse({ ...value, submission }), entries = this.entries(sessionId);
    if (entry.replyTo && (entry.role !== 'user' || !entries.some(item => item.id === entry.replyTo!.messageId && isAssistantPageMessage(item) && item.source !== 'task'))) throw Error('assistant_quote_unavailable');
    const old = entries.find(item => item.id === entry.id);
    if (old) {
      if (old.content !== entry.content || old.role !== entry.role || old.source !== entry.source || old.visibility !== entry.visibility || old.voiceMode !== entry.voiceMode || JSON.stringify(old.attachments) !== JSON.stringify(entry.attachments) || JSON.stringify(old.promptContext) !== JSON.stringify(entry.promptContext) || JSON.stringify(old.replyTo) !== JSON.stringify(entry.replyTo)) throw Error('Conversation message ID reused with different content.');
      return visibleEntry(old);
    }
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.file(sessionId), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
    this.cache.set(sessionId, [...entries, entry]);
    this.indexReply(sessionId, entry);
    const visible = visibleEntry(entry);
    this.onAppend?.(sessionId, visible);
    return visible;
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
    if (!this.read(sessionId).some(item => item.id === messageId && isAssistantPageMessage(item) && item.source !== 'task')) throw Error('assistant_message_unavailable');
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
    this.replyPositions.delete(sessionId);
    this.modelHistory(sessionId).clear(); rmSync(this.file(sessionId), { force: true }); this.cache.delete(sessionId);
    rmSync(this.file(sessionId) + '.reactions.json', { force: true }); this.reactions.delete(sessionId);
  }
}
