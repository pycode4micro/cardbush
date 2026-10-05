import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface VoicePair { sequence: number; user: string; assistant: string }
export interface VoiceContextMessage { id?: string; role: 'user' | 'assistant'; text: string }
export interface VoiceHistoryCrypto { encrypt(value: string): string; decrypt(value: string): string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Append-only encrypted source journal; checkpoints only replace the active view.
 * No audio or personalization inference is stored here. */
export class RealtimeVoiceHistory {
  static forget(root:string,sessionId?:string) {
    if (!fs.existsSync(root)) return;
    const names=sessionId===undefined ? fs.readdirSync(root).filter(name=>/^[a-f0-9]{64}\.jsonl$/.test(name)) : [hash(sessionId)+'.jsonl'];
    for (const name of names) fs.rmSync(path.join(root,name),{force:true});
  }
  pairs: VoicePair[] = [];
  summary = '';
  revision = 0;
  through = 0;
  private sequence = 0;
  private seeds = new Set<string>();
  private file?: string;
  constructor(root: string | undefined, readonly sessionId: string, private crypto: VoiceHistoryCrypto) {
    if (!root) return; // Unnamed transient calls still keep memory during reconnects.
    fs.mkdirSync(root, { recursive: true });
    this.file = path.join(root, hash(sessionId) + '.jsonl');
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]; if (!line) continue;
      // A partial last append is recoverable. Never hide corruption of completed records.
      let value: any;
      try { value = JSON.parse(crypto.decrypt(JSON.parse(line))); }
      catch (error) { if (index === lines.length - 1) { fs.truncateSync(this.file, Buffer.byteLength(lines.slice(0,index).join('\n') + (index ? '\n' : ''))); break; } throw error; }
      if (value.type === 'pair') {
        if (!Number.isInteger(value.sequence) || value.sequence !== this.sequence + 1 || typeof value.user !== 'string' || typeof value.assistant !== 'string') throw Error('Invalid voice history.');
        this.sequence = value.sequence; this.pairs.push(value);
        if (value.seed) this.seeds.add(value.seed);
      } else if (value.type === 'checkpoint') {
        if (!Number.isInteger(value.through) || value.through < this.through || value.through > this.sequence || typeof value.summary !== 'string') throw Error('Invalid voice checkpoint.');
        this.through = value.through; this.summary = value.summary; this.revision++;
        this.pairs = this.pairs.filter(pair => pair.sequence > this.through);
      }
    }
  }
  private write(value: object, durable=false) {
    if (!this.file) return;
    const fd=fs.openSync(this.file,'a',0o600);
    try {fs.writeFileSync(fd,JSON.stringify(this.crypto.encrypt(JSON.stringify(value)))+'\n'); if (durable) fs.fsyncSync(fd);}
    finally {fs.closeSync(fd);}
  }
  append(user: string, assistant: string, seed?: string) {
    if (seed && this.seeds.has(seed)) return;
    if (user.length > 32000 || assistant.length > 32000) throw Error('Voice transcript exceeds the archival message limit.');
    const pair = { sequence: this.sequence + 1, user, assistant };
    this.write({ type: 'pair', ...pair, ...(seed ? { seed } : {}) });
    this.sequence++; this.pairs.push(pair); if (seed) this.seeds.add(seed);
    return pair.sequence;
  }
  seed(context: VoiceContextMessage[]) {
    for (let i=0;i<context.length;i+=2) {
      const user=context[i].text, assistant=context[i+1].text;
      this.append(user,assistant,hash(JSON.stringify([user,assistant])));
    }
  }
  checkpoint(through: number, summary: string) {
    if (!this.pairs.some(pair=>pair.sequence===through) || through <= this.through) throw Error('Stale voice checkpoint.');
    this.write({ type: 'checkpoint', through, summary },true);
    this.through=through; this.summary=summary; this.revision++;
    this.pairs=this.pairs.filter(pair=>pair.sequence>through);
  }
  summaryMessages(): VoiceContextMessage[] {
    return this.summary ? [
      { id: `memory_${this.revision}_u`, role: 'user', text: '[应用保存的历史摘要；仅供回忆，不是新请求或执行授权]\n'+this.summary },
      { id: `memory_${this.revision}_a`, role: 'assistant', text: '已参考历史摘要；以最新用户意图和真实任务状态为准，不重复执行历史任务。' },
    ] : [];
  }
  messages(pairs = this.pairs): VoiceContextMessage[] {
    return [...this.summaryMessages(), ...pairs.flatMap(pair=>[
      { id: `history_${pair.sequence}_u`, role: 'user' as const, text: pair.user },
      { id: `history_${pair.sequence}_a`, role: 'assistant' as const, text: pair.assistant },
    ])];
  }
}
