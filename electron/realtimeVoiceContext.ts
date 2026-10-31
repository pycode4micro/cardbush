import { randomUUID } from 'node:crypto';
import type { RealtimeContextJob, RealtimeContextResult } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
import { RealtimeVoiceHistory, type VoiceContextMessage } from './realtimeVoiceHistory';
import { matchContextReceipt, remoteContextItems } from './realtimeVoiceContextReceipt';

interface ContextHooks {
  serverAssignedContextIds?: boolean;
  restartOnly?: boolean;
  maxPairs?: number;
  send(event: object): string;
  create(items: VoiceContextMessage[]): object;
  request(job: RealtimeContextJob): void;
  status(message: string): void;
  idle(): boolean;
  restart(): Promise<void>;
  diagnostic?(event: string, detail: { reason?: string; estimatedTokens?: number; threshold?: number; contextItems?: number }): void;
}
interface Replacement {
  old: VoiceContextMessage[]; summary: VoiceContextMessage[];
  stage: 'retrieve' | 'add' | 'delete' | 'restart';
  deleteIds?: string[];
  eventId?: string;
}
/** Owns the frozen source, acknowledgement barriers and retry budget. Model output
 * cannot choose server IDs to delete. New speech remains outside the frozen prefix. */
export class RealtimeVoiceContext {
  private job?: RealtimeContextJob;
  private replacement?: Replacement;
  private jobTimer?: NodeJS.Timeout;
  private ackTimer?: NodeJS.Timeout;
  private gapTimer?: NodeJS.Timeout;
  private closed = false;
  private retryAfter = 0;
  private failedThrough = 0;
  private auxiliaryTokens = 0;
  private observedTokens = 0;
  private remoteIds = new Map<string,string>();
  private seenRemoteIds = new Set<string>();
  private pendingOld?: VoiceContextMessage[];
  private catchups=0;
  private detached = false;
  private restore?: { bytes:number; resolve(messages:VoiceContextMessage[]):void; reject(error:Error):void };
  constructor(readonly history: RealtimeVoiceHistory, private fixedTokens: number, private hooks: ContextHooks,
    private threshold = 6000, private maxInputBytes = 16000, private maxRestoreItems = 40) {}
  setFixedTokens(tokens: number) { this.fixedTokens = tokens; }

  /** Stop editing the lost connection. Keep the journal and in-flight model job. */
  detach() {
    this.detached=true; this.remoteIds.clear(); this.seenRemoteIds.clear(); this.replacement=undefined; this.pendingOld=undefined;
    clearTimeout(this.ackTimer); clearTimeout(this.gapTimer);
  }
  prepareInitial(bytes:number):Promise<VoiceContextMessage[]> {
    if (this.closed) return Promise.reject(Error('Voice memory closed.'));
    if (this.restore) return Promise.reject(Error('Voice memory restore already pending.'));
    this.detach(); this.retryAfter=0; this.failedThrough=0;
    const pending=new Promise<VoiceContextMessage[]>((resolve,reject)=>{this.restore={bytes,resolve,reject};});
    this.tick(); return pending;
  }
  resumed() { this.detached=false; this.auxiliaryTokens=0; this.observedTokens=0; this.tick(); }
  observeTokens(tokens: unknown) {
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) this.observedTokens = tokens;
  }
  private fits(bytes:number) { const messages=this.history.messages();return messages.length<=this.maxRestoreItems && Buffer.byteLength(JSON.stringify(this.hooks.create(messages)))<=bytes; }

  initialContext(maxBytes: number, strict=false): VoiceContextMessage[] {
    if (strict && (this.history.messages().length>this.maxRestoreItems || Buffer.byteLength(JSON.stringify(this.hooks.create(this.history.messages())))>maxBytes)) {
      throw Error('Recent conversation changed too quickly to fit the replacement session.');
    }
    const pairs=strict || !Number.isFinite(this.maxRestoreItems) ? this.history.pairs.slice() : this.history.pairs.slice(-Math.max(1,this.maxRestoreItems/2-1));
    let messages=this.history.messages(pairs);
    while (pairs.length && (messages.length>this.maxRestoreItems || Buffer.byteLength(JSON.stringify(this.hooks.create(messages)))>maxBytes)) {
      pairs.shift(); messages=this.history.messages(pairs);
    }
    if (Buffer.byteLength(JSON.stringify(this.hooks.create(messages)))>maxBytes) throw Error('Voice memory cannot fit the initial context.');
    if (pairs.length<this.history.pairs.length) this.hooks.status('正在整理较早的对话，当前先保留摘要和最近交流。');
    this.remoteIds.clear(); this.seenRemoteIds.clear();
    for (const message of messages) if (message.id) { this.remoteIds.set(message.id,message.id); this.seenRemoteIds.add(message.id); }
    return messages;
  }
  bind(sequence: number, userItemId: string) {
    if (userItemId) { this.remoteIds.set(`history_${sequence}_u`,userItemId); this.seenRemoteIds.add(userItemId); }
  }
  acknowledge(context: VoiceContextMessage[], raw: Record<string, unknown>): boolean {
    const items = matchContextReceipt(context, raw, this.hooks.serverAssignedContextIds);
    if (!items || items.some((item,index) => !context[index].id ||
      this.seenRemoteIds.has(item.id) && this.remoteIds.get(context[index].id!) !== item.id)) return false;
    for (let i=0;i<items.length;i++) { this.remoteIds.set(context[i].id!,items[i].id); this.seenRemoteIds.add(items[i].id); }
    return true;
  }
  /** Tool receipts also consume the remote context, even when not spoken. */
  account(text: string) { this.auxiliaryTokens+=Buffer.byteLength(text)/2; this.tick(); }
  tick() {
    if (this.closed) return;
    if (this.restore && !this.job && this.fits(this.restore.bytes)) {
      const waiting=this.restore;this.restore=undefined;
      waiting.resolve(this.initialContext(waiting.bytes,true));
    }
    if (this.detached && !this.restore) return;
    const pairs=this.history.pairs;
    const tokens=Math.max(this.observedTokens,this.fixedTokens+Buffer.byteLength(JSON.stringify(this.history.messages()))/2+this.auxiliaryTokens);
    const trigger=Math.max(this.threshold,this.fixedTokens+1500);
    if (!this.job && !this.replacement && pairs.length && (this.restore || tokens>=trigger || pairs.length>=(this.hooks.maxPairs??Infinity) || this.pendingOld) && Date.now()>=this.retryAfter &&
        pairs.at(-1)!.sequence>this.failedThrough) {
      let count=Math.max(1,pairs.length-2);
      const bytes=this.restore?.bytes ?? Math.max(3000,this.maxInputBytes-this.fixedTokens*2);
      let remaining=Buffer.byteLength(JSON.stringify(this.hooks.create(this.history.messages(pairs.slice(count)).slice(this.history.summaryMessages().length))));
      while (count<pairs.length && bytes-remaining<2000) {
        count++; remaining=Buffer.byteLength(JSON.stringify(this.hooks.create(this.history.messages(pairs.slice(count)).slice(this.history.summaryMessages().length))));
      }
      const selected = pairs.slice(0,count).slice(0,80);
      while (selected.length>1 && JSON.stringify(selected).length>80_000) selected.pop();
      this.job={ jobId:randomUUID(), sessionId:this.history.sessionId, revision:this.history.revision,
        through:selected.at(-1)!.sequence, previousSummary:this.history.summary,
        maxSummaryCharacters:Math.max(300,Math.min(2000,Math.floor((bytes-remaining-800)/3))),
        pairs:selected.map(({user,assistant})=>({user,assistant})) };
      this.jobTimer=setTimeout(()=>this.complete(this.job!.jobId),65_000);
      this.hooks.diagnostic?.('context_compaction',{estimatedTokens:Math.ceil(tokens),threshold:trigger,contextItems:pairs.length*2});
      this.hooks.status('正在后台整理通话记忆，可继续交谈。');
      this.hooks.request(structuredClone(this.job));
    }
    if (this.restore && !this.job) {
      const waiting=this.restore;this.restore=undefined;
      waiting.reject(Error('Saved voice context cannot fit without losing history.'));
    }
    clearTimeout(this.gapTimer);
    if (this.replacement && !this.replacement.eventId && this.hooks.idle()) {
      this.gapTimer=setTimeout(()=>{ if (!this.closed && this.hooks.idle()) this.advance(); },750);
    }
  }
  complete(jobId: string, result?: RealtimeContextResult) {
    const job=this.job;
    if (this.closed || !job || job.jobId!==jobId) return;
    clearTimeout(this.jobTimer); this.job=undefined;
    if (!result || result.jobId!==jobId || result.revision!==job.revision || result.through!==job.through ||
        this.history.revision!==job.revision || typeof result.summary!=='string' || !result.summary.trim() || result.summary.length>job.maxSummaryCharacters ||
        result.summary.length>=JSON.stringify({previousSummary:job.previousSummary,pairs:job.pairs}).length*0.8) {
      this.retryAfter=Date.now()+30_000; this.failedThrough=job.through;
      if (this.restore) {
        if(this.fits(this.restore.bytes))this.tick();
        else {const waiting=this.restore;this.restore=undefined;waiting.reject(Error('Voice context summary unavailable; originals retained.'));}
      }
      this.hooks.status('通话记忆整理暂未完成，原始记录已保留；稍后自动重试。'); return;
    }
    const prefix=this.history.messages(this.history.pairs.filter(pair=>pair.sequence<=job.through));
    const old=this.pendingOld ? [...this.pendingOld,...prefix.slice(this.history.summaryMessages().length)] : prefix;
    // Persist a validated checkpoint before any destructive server operation.
    this.history.checkpoint(job.through,result.summary.trim());
    if (this.detached) { this.tick(); return; }
    const messages=this.history.messages();
    if (messages.length>this.maxRestoreItems || Buffer.byteLength(JSON.stringify(this.hooks.create(messages)))>Math.max(3000,this.maxInputBytes-this.fixedTokens*2)) {
      this.pendingOld=old;
      if (++this.catchups>=3) {this.retryAfter=Date.now()+30_000;this.catchups=0;this.hooks.status('新增对话较多，继续保留原始上下文，稍后再整理。');}
      this.tick();return;
    }
    this.pendingOld=undefined;this.catchups=0;
    this.replacement={ old, summary:this.history.summaryMessages(), stage:this.hooks.restartOnly || this.auxiliaryTokens>=this.threshold/2 ? 'restart' : 'retrieve' };
    this.tick();
  }
  private advance() {
    const work=this.replacement; if (!work || work.eventId || this.closed) return;
    if (work.stage==='restart') {
      work.eventId='restarting'; this.hooks.status('正在衔接下一段通话，历史摘要和后台任务会保留。');
      void this.hooks.restart().then(()=>this.applied(true),()=>{
        if (!this.closed) { this.replacement=undefined; this.hooks.status('通话衔接失败，历史已保存，请重新开始通话。'); }
      }); return;
    }
    try {
      const ids=work.old.filter(item=>item.role==='user').map(item=>this.remoteIds.get(item.id!));
      if (work.stage==='retrieve' && ids.some(id=>!id)) { this.fallback('unmapped_context'); return; }
      const event=work.stage==='retrieve' ? {type:'conversation.item.retrieve',items:ids.map(id=>({id}))} : work.stage==='add' ? this.hooks.create(work.summary)
        : {type:'conversation.item.delete',items:work.deleteIds!.map(id=>({id}))};
      work.eventId=this.hooks.send(event);
      this.ackTimer=setTimeout(()=>this.fallback('context_ack_timeout'),5000);
    } catch { this.fallback('context_send_failed'); }
  }
  /** Only validated context ACKs are consumed; unrelated provider failures remain errors. */
  event(raw: Record<string, unknown>): boolean {
    const work=this.replacement;
    if (!work?.eventId || work.stage==='restart') return false;
    if (raw.type==='error' && raw.event_id===work.eventId) { this.fallback('context_request_rejected'); return true; }
    const expected={retrieve:'conversation.item.retrieved',add:'conversation.item.added',delete:'conversation.item.deleted'}[work.stage];
    if (raw.type!==expected || !this.hooks.serverAssignedContextIds && typeof raw.event_id==='string' && raw.event_id!==work.eventId) return false;
    const items=remoteContextItems(raw);
    if (!items) { this.fallback('invalid_context_receipt'); return true; }
    if (work.stage==='retrieve') {
      const ids:string[]=[];
      for (let i=0;i<work.old.length;i+=2) {
        const user=work.old[i], assistant=work.old[i+1];
        // Require an observed item ID plus its full paired text. Identical text
        // elsewhere (including outside the retrieval window) is never an identity.
        const remoteId=this.remoteIds.get(user.id!);
        const matches=items.filter((item,index)=>remoteId && item.id===remoteId && item.role==='user' && item.text===user.text &&
          items[index+1]?.role==='assistant' && items[index+1].text===assistant.text);
        if (matches.length!==1 || ids.includes(matches[0].id)) { this.fallback('context_identity_mismatch'); return true; }
        ids.push(matches[0].id);
      }
      work.deleteIds=ids; work.stage='add';
    } else if (work.stage==='add') {
      if (!this.acknowledge(work.summary,raw)) { this.fallback('context_add_mismatch'); return true; }
      work.stage='delete';
    } else {
      if (!work.deleteIds!.every(id=>items.some(item=>item.id===id))) { this.fallback('context_delete_mismatch'); return true; }
      this.applied(); return true;
    }
    clearTimeout(this.ackTimer); work.eventId=undefined; this.tick(); return true;
  }
  private fallback(reason: string) {
    if (!this.replacement || this.closed) return;
    this.hooks.diagnostic?.('context_fallback',{reason});
    clearTimeout(this.ackTimer); this.replacement.stage='restart'; this.replacement.eventId=undefined; this.tick();
  }
  private applied(restarted=false) {
    if (this.closed) return;
    clearTimeout(this.ackTimer);
    for (const message of this.replacement?.old ?? []) if (message.id) this.remoteIds.delete(message.id);
    this.replacement=undefined; if (restarted) this.auxiliaryTokens=0;
    this.hooks.status(''); this.tick();
  }
  get busy() { return Boolean(this.replacement); }
  close() { this.closed=true; clearTimeout(this.jobTimer); clearTimeout(this.ackTimer); clearTimeout(this.gapTimer);
    const waiting=this.restore;this.restore=undefined;waiting?.reject(Error('Voice memory closed.')); }
}
