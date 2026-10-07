import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { modelMessageSchema, type ModelMessage } from '@cardbush/bush-protocol';

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('append'), messages: z.array(modelMessageSchema), entryIds: z.array(z.string()) }),
  z.object({ type: z.literal('checkpoint'), through: z.number().int().nonnegative(), summary: z.string(), entryIds: z.array(z.string()).default([]) }),
]);
type HistoryEvent = z.infer<typeof eventSchema>;

/** Host-only, append-only model exchanges. UI/voice transcripts are a separate projection. */
export class AssistantModelHistory {
  private loaded = false;
  private records: ModelMessage[] = [];
  private consumed = new Set<string>();
  private through = 0;
  private summary = '';
  constructor(private readonly path: string) {}

  read() {
    if (!this.loaded) {
      this.records = []; this.consumed.clear(); this.through = 0; this.summary = '';
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
    }
    return { messages: structuredClone(this.records), entryIds: new Set(this.consumed),
      through: this.through, summary: this.summary };
  }
  append(messages: ModelMessage[], entryIds: string[] = []) {
    if (messages.length || entryIds.length) this.write({ type: 'append', messages, entryIds });
  }
  checkpoint(through: number, summary: string, entryIds: string[] = []) { this.write({ type: 'checkpoint', through, summary, entryIds }); }
  private write(event: HistoryEvent) {
    this.read();
    const parsed = eventSchema.parse(event);
    this.validate(parsed);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(parsed) + '\n', { encoding: 'utf8', mode: 0o600, flush: true });
    this.apply(parsed);
  }
  private validate(event: HistoryEvent) {
    if (event.type === 'checkpoint' && (event.through < this.through || event.through > this.through + this.records.length))
      throw Error('Invalid assistant model history checkpoint.');
  }
  private apply(event: HistoryEvent) {
    this.validate(event);
    if (event.type === 'append') {
      this.records.push(...event.messages);
    } else {
      // Retain source events on disk without keeping compacted tool output in RAM.
      this.records = this.records.slice(event.through - this.through);
      this.through = event.through; this.summary = event.summary;
    }
    event.entryIds.forEach(id => this.consumed.add(id));
  }
  clear() {
    rmSync(this.path, { force: true });
    this.records = []; this.consumed.clear(); this.through = 0; this.summary = ''; this.loaded = true;
  }
}
