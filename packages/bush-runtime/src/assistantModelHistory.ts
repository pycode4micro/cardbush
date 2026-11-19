import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { z } from 'zod';
import { modelMessageSchema, type ModelMessage } from '@cardbush/bush-protocol';
import { taskResultReferenceSchema, type TaskResultReference } from './taskResultDelivery.js';
import { modelToolCallIds } from './modelReplay.js';
import { assistantHistoryLocator, checkpointEvidence, type AssistantHistoryEvidence, type ReceiptProjection } from './assistantHistoryProjection.js';
import { visibleHistoryMessage, type HistoryReadInput } from './conversationHistory.js';

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('append'), messages: z.array(modelMessageSchema), entryIds: z.array(z.string()), taskResults: z.array(taskResultReferenceSchema).default([]), replyInputs: z.array(z.string()).optional() }),
  z.object({ type: z.literal('checkpoint'), through: z.number().int().nonnegative(), summary: z.string(), entryIds: z.array(z.string()).default([]),
    generation: z.string().uuid().optional(), evidence: z.array(z.object({ index: z.number().int().nonnegative(),
      role: z.enum(['user', 'tool']), text: z.string(), excerpt: z.literal(true).optional() })).optional() }),
  z.object({ type: z.literal('project'), generation: z.string().uuid(), updates: z.array(z.object({
    index: z.number().int().nonnegative(), callId: z.string(), content: z.string() })) }),
]);
type HistoryEvent = z.infer<typeof eventSchema>;

/** Host-only, append-only model exchanges. UI/voice transcripts are a separate projection. */
export class AssistantModelHistory {
  private loaded = false;
  private records: ModelMessage[] = [];
  private consumed = new Set<string>();
  private taskResults = new Map<string, TaskResultReference>();
  private callIds = new Set<string>();
  private activeReplyInputs?: string[];
  private through = 0;
  private summary = '';
  private generation: string = randomUUID();
  private hasArchiveLocator = false;
  private evidence: AssistantHistoryEvidence[] = [];
  constructor(private readonly path: string) {}

  read() {
    if (!this.loaded) {
      this.records = []; this.consumed.clear(); this.taskResults.clear(); this.callIds.clear(); this.activeReplyInputs = undefined; this.through = 0; this.summary = '';
      this.hasArchiveLocator = false; this.evidence = [];
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf8'), lines = raw.split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index]!.trim()) continue;
          let event: HistoryEvent;
          try { event = eventSchema.parse(JSON.parse(lines[index]!)); }
          catch (error) {
            if (index < lines.length - 1) throw error;
            // An interrupted append may lose its last event, never an earlier exchange.
            truncateSync(this.path, Buffer.byteLength(raw.slice(0, raw.lastIndexOf('\n') + 1)));
            break;
          }
          this.apply(event);
          if (index === lines.length - 1) appendFileSync(this.path, '\n');
        }
      }
      this.loaded = true;
      // Older checkpoints already have their original append records. Pin their
      // range on first open without rewriting the summary or calling a model.
      if (this.through && !this.hasArchiveLocator) {
        try { this.write({ type: 'checkpoint', through: this.through, summary: this.summary, entryIds: [], generation: this.generation }); }
        catch (error) { this.loaded = false; throw error; }
      }
    }
    return { messages: structuredClone(this.records), entryIds: new Set(this.consumed),
      taskResults: [...this.taskResults.values()],
      through: this.through, summary: this.summary, memory: this.memoryText() };
  }
  private memoryText() {
    if (!this.through || !this.hasArchiveLocator) return this.summary;
    return [this.summary, 'Original visible records: ' + assistantHistoryLocator(this.generation, 0, this.through - 1),
      ...(this.evidence.length ? ['Historical records in original order. To reread one record, use its index for both endpoints: ' +
        JSON.stringify(this.evidence)] : [])].join('\n');
  }
  archiveGeneration() { if (!this.loaded) this.read(); return this.generation; }
  replyInputs(): string[] | undefined {
    if (!this.loaded) this.read();
    return this.activeReplyInputs && [...this.activeReplyInputs];
  }
  toolCallIds(): string[] { return [...this.callIds]; }
  append(messages: ModelMessage[], entryIds: string[] = [], taskResults: TaskResultReference[] = [], replyInputs?: string[]) {
    if (messages.length || entryIds.length || taskResults.length || replyInputs !== undefined)
      this.write({ type: 'append', messages, entryIds, taskResults, ...(replyInputs !== undefined ? { replyInputs } : {}) });
  }
  checkpoint(through: number, summary: string, entryIds: string[] = [], evidenceBudget = 0) {
    if (!this.loaded) this.read();
    const evidence = checkpointEvidence(this.evidence, this.records.slice(0, through - this.through), this.through, evidenceBudget);
    this.write({ type: 'checkpoint', through, summary, entryIds, generation: this.generation, evidence });
  }
  project(updates: ReceiptProjection[]) { this.write({ type: 'project', generation: this.archiveGeneration(), updates }); }
  async readOriginal(sessionId: string, input: HistoryReadInput, signal?: AbortSignal) {
    const generation = this.archiveGeneration();
    const match = /^conversation-history:\/\/turns\/assistant-([\da-f-]+)\.(\d+)\/assistant-([\da-f-]+)\.(\d+)$/.exec(input.locator);
    const first = Number(match?.[2]), last = Number(match?.[4]);
    if (!match || match[1] !== generation || match[3] !== generation || first > last ||
      last >= this.through + this.records.length || input.revision !== undefined && input.revision !== last + 1)
      throw Error('Assistant history range is unavailable.');
    signal?.throwIfAborted();
    const stream = createReadStream(this.path, { encoding: 'utf8', signal });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let index = 0, size = 0, text = '';
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type !== 'append') continue;
        for (const message of event.messages as ModelMessage[]) {
          const position = index++;
          if (position < first) continue;
          if (position > last) break;
          if (!['assistant', 'tool', 'user'].includes(message.role) || ('visibility' in message && message.visibility === 'internal')) continue;
          const row = JSON.stringify({ index: position, message: visibleHistoryMessage(message) }) + '\n';
          const offset = Math.max(0, input.offset - size);
          if (text.length < input.maxChars) text += row.slice(offset, offset + input.maxChars - text.length);
          size += row.length;
        }
        if (index > last) break;
      }
      if (generation !== this.generation || index <= last) throw Error('Assistant history changed during the read.');
    } finally { lines.close(); stream.destroy(); }
    const offset = Math.min(size, input.offset), next = offset + text.length;
    return { locator: input.locator, session_id: sessionId, revision: last + 1, offset, text, total_chars: size,
      next_offset: next < size ? next : null };
  }
  private write(event: HistoryEvent) {
    if (!this.loaded) this.read();
    const parsed = eventSchema.parse(event);
    this.validate(parsed);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(parsed) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
    this.apply(parsed);
  }
  private validate(event: HistoryEvent) {
    if (event.type === 'checkpoint' && (event.through < this.through || event.through > this.through + this.records.length))
      throw Error('Invalid assistant model history checkpoint.');
    if (event.type !== 'append' && event.generation && this.hasArchiveLocator && event.generation !== this.generation)
      throw Error('Assistant history generation changed.');
    if (event.type === 'project') for (const update of event.updates) {
      const original = this.records[update.index - this.through];
      if (original?.role !== 'tool' || original.toolCallId !== update.callId) throw Error('Invalid Assistant receipt projection.');
    }
  }
  private apply(event: HistoryEvent) {
    this.validate(event);
    if (event.type === 'append') {
      this.records.push(...event.messages);
      for (const id of modelToolCallIds(event.messages)) this.callIds.add(id);
      if (event.replyInputs !== undefined) this.activeReplyInputs = [...event.replyInputs];
      for (const reference of event.taskResults) this.taskResults.set(JSON.stringify([reference.sessionId, reference.taskId]), reference);
    } else if (event.type === 'project') {
      this.generation = event.generation; this.hasArchiveLocator = true;
      for (const update of event.updates) {
        const index = update.index - this.through;
        this.records[index] = { ...this.records[index]!, content: update.content };
      }
      return;
    } else {
      // Retain source events on disk without keeping compacted tool output in RAM.
      this.records = this.records.slice(event.through - this.through);
      this.through = event.through; this.summary = event.summary;
      if (event.generation) { this.generation = event.generation; this.hasArchiveLocator = true; }
      this.evidence = event.evidence ?? [];
    }
    event.entryIds.forEach(id => this.consumed.add(id));
  }
  clear() {
    rmSync(this.path, { force: true });
    this.generation = randomUUID(); this.hasArchiveLocator = false; this.evidence = [];
    this.records = []; this.consumed.clear(); this.taskResults.clear(); this.callIds.clear(); this.activeReplyInputs = undefined; this.through = 0; this.summary = ''; this.loaded = true;
  }
}
