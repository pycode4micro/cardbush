import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MAX_MEMORY_NOTE_TOKENS, type IndividuationSettings, type PersonalizationStatus, type SummaryForUserInput,
  type MemoryNote, type CheckHabitInput, type MemoryRead, type MemoryChange } from '@cardbush/bush-protocol';
import { boundedMemoryText, memoryHash, memoryTerms, memoryTokens } from './individuationText.js';
import { activeMemory, memoryView, memoryMetadata as metadata, initializeMemoryJournal, getMemoryRow,
  memoryHistoryFull, recordMemoryChange, canUndoMemoryChange, undoMemoryChange, type MemoryJournalRow } from './individuationJournal.js';

export type MemoryOwner = { sessionId: string; turnId: string; operationId?:string };
export type MemoryRow = { seq: number; id: string; kind: 'habit'|'prediction'|'note'|'evidence'; text: string;
  scope: number; tokens: number; revision: number; created: number; updated: number; observations: number;
  hits: number; misses: number; metadata: string; state:'active'|'retracted'|'disputed'|'superseded'|'consolidated';
  origin:'agent'|'user'|'summary';applies_when:string;expires:number|null;confirmed:number|null;rejected:number|null;replaced_by:string };
export type MemoryStage = 'events'|'habits';
export type MemorySnapshot = { lease: string; stage: MemoryStage; records: MemoryRow[]; tokens: number; fingerprint: string; retryKey: string };
export type MemorySummary = { habits: Array<MemoryNote & { sources: string[] }>; predictions: Array<MemoryNote & { sources: string[] }>;
  reviews: Array<{ prediction: string; evidence: string; outcome: 'hit'|'miss'; reason: string }> };
export class MemorySummaryValidationError extends Error {
  constructor(readonly reason:'history_full'|'unsupported_sources'|'unsupported_promotion'|'invalid_review'|'insufficient_reduction'|'disabled_category'|'note_too_long'|'condition_lost'|'expired_output'|'retired_source',message:string) { super(message); }
}
const mask = (settings: IndividuationSettings) => (settings.habits ? 1 : 0) | (settings.predictions ? 2 : 0);
const emptyStatus = (): PersonalizationStatus => ({ estimatedTokens:0,eventTokens:0,habitTokens:0,records:0,habits:0,predictions:0,notes:0,hits:0,misses:0,running:false,lastSummaryAt:null,lastError:null,inactiveRecords:0,historyChanges:0 });
const isForecast = (row: MemoryRow) => row.kind==='prediction' || row.kind==='note' && (row.scope & 2)!==0;
const noteId = (kind:string,note:MemoryNote) => `${kind}_${memoryHash(JSON.stringify([note.text,note.applies_when??'',note.expires_at??'']))}`;
const stageFingerprint = (stage:MemoryStage,retryKey:string,rows:MemoryRow[]) => createHash('sha256').update(JSON.stringify([stage,retryKey,rows.map(row=>[row.id,row.revision])])).digest('hex');

/** One host-local database. SQL operations are short; no model request holds a transaction open. */
export class IndividuationStore {
  constructor(readonly path: string, private readonly now = Date.now) {}
  private async transaction<T>(run: (db: DatabaseSync, now: number) => T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const { DatabaseSync } = await import('node:sqlite');
    signal?.throwIfAborted();
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true, mode:0o700 });
      try { closeSync(openSync(this.path,'ax',0o600)); } catch(error) { if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
    }
    const db = new DatabaseSync(this.path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS memory_records(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,
          text TEXT NOT NULL,scope INTEGER NOT NULL,tokens INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
          created INTEGER NOT NULL,updated INTEGER NOT NULL,observations INTEGER NOT NULL DEFAULT 1,
          hits INTEGER NOT NULL DEFAULT 0,misses INTEGER NOT NULL DEFAULT 0,metadata TEXT NOT NULL DEFAULT '{}');
        CREATE INDEX IF NOT EXISTS memory_kind ON memory_records(kind,updated DESC);
        CREATE TABLE IF NOT EXISTS memory_terms(record_id TEXT REFERENCES memory_records(id) ON DELETE CASCADE,term TEXT,PRIMARY KEY(term,record_id));
        CREATE TABLE IF NOT EXISTS memory_origins(record_id TEXT REFERENCES memory_records(id) ON DELETE CASCADE,owner TEXT,PRIMARY KEY(record_id,owner));
        CREATE TABLE IF NOT EXISTS memory_reviews(id TEXT PRIMARY KEY,outcome TEXT,reason TEXT,updated INTEGER);
        CREATE TABLE IF NOT EXISTS memory_state(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER DEFAULT 0,
          lease TEXT,lease_until INTEGER DEFAULT 0,retry_after INTEGER DEFAULT 0,last_summary INTEGER,last_error TEXT,hits INTEGER DEFAULT 0,misses INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS memory_summary_attempts(fingerprint TEXT PRIMARY KEY,code TEXT NOT NULL,retry_after INTEGER,updated INTEGER NOT NULL);
        INSERT OR IGNORE INTO memory_state(id) VALUES(1); BEGIN IMMEDIATE;`);
      initializeMemoryJournal(db);
      // Import the old structured records once; predictions remain hypotheses, never queued actions.
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='individuation'").get()) {
        const old=db.prepare('SELECT * FROM individuation').all() as Array<Record<string,unknown>>;
        for(const row of old) {
          const body=JSON.parse(String(row.body));
          const text=row.kind==='habit' ? `${body.content}\n${body.evidence ?? ''}` : `${body.trigger} → ${body.action}\n${body.reason ?? ''}`;
          this.insert(db,row.kind==='habit'?'habit':'prediction',text,row.kind==='habit'?1:2,{sessionId:String(row.session_id),turnId:String(row.turn_id)},Number(row.updated_at),{});
        }
        db.exec('DROP TABLE individuation');
      }
      const result=run(db,this.now()); signal?.throwIfAborted(); db.exec('COMMIT'); return result;
    } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
    finally { db.close(); }
  }
  private insert(db: DatabaseSync, kind: MemoryRow['kind'], text: string, scope: number, owner: MemoryOwner, now: number,
    meta: Record<string,unknown>, id = `${kind}_${memoryHash(`${scope}:${text}`)}`): { id:string; changed:boolean } {
    const origin=memoryHash(`${owner.sessionId}:${owner.turnId}`);
    const existing=db.prepare('SELECT * FROM memory_records WHERE id=?').get(id) as MemoryRow|undefined;
    if(existing) {
      if(existing.observations>=100 || !db.prepare('INSERT OR IGNORE INTO memory_origins VALUES(?,?)').run(id,origin).changes) return {id,changed:false};
      db.prepare('UPDATE memory_records SET observations=observations+1,updated=?,revision=revision+1 WHERE id=?').run(now,id);
    } else {
      const tokens=memoryTokens(text+JSON.stringify(meta));
      db.prepare('INSERT INTO memory_records(id,kind,text,scope,tokens,created,updated,metadata) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,kind,text,scope,tokens,now,now,JSON.stringify(meta));
      db.prepare('INSERT INTO memory_origins VALUES(?,?)').run(id,origin);
      const add=db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)');
      for(const term of memoryTerms(text)) add.run(id,term);
    }
    db.exec('UPDATE memory_state SET revision=revision+1 WHERE id=1'); return {id,changed:true};
  }
  private full(db: DatabaseSync, settings: IndividuationSettings) {
    const totals=db.prepare("SELECT COUNT(*) count,COALESCE(SUM(tokens),0) tokens FROM memory_records WHERE state='active' AND (expires IS NULL OR expires>?)").get(this.now()) as {count:number;tokens:number};
    return totals.count>=8000 || totals.tokens>Math.max(40_000,(settings.eventTokenThreshold+settings.habitTokenThreshold)*4);
  }
  async summarize(input: SummaryForUserInput, settings: IndividuationSettings, owner: MemoryOwner, user = '', signal?:AbortSignal) {
    signal?.throwIfAborted();
    const writes:Array<{category:'habit'|'prediction';status:'created'|'deduplicated'|'rejected'|'skipped';id?:string;reason?:string}>=[];
    const entries=([['habit',1,settings.habits],['prediction',2,settings.predictions]] as const).flatMap(([kind,scope,enabled])=>{
      const note=input[kind];if(!note)return [];
      if(!enabled){writes.push({category:kind,status:'skipped',reason:'category_disabled'});return [];}
      return [{kind,scope,note}];
    });
    if(!entries.length)return {saved:false,writes};
    const invalid=entries.find(entry=>memoryTokens(entry.note.text+' '+(entry.note.applies_when??''))>MAX_MEMORY_NOTE_TOKENS || entry.note.expires_at&&Date.parse(entry.note.expires_at)<=this.now());
    if(invalid)return {saved:false,writes:[...writes,...entries.map(entry=>({category:entry.kind,status:'rejected' as const,
      reason:entry===invalid?(entry.note.expires_at&&Date.parse(entry.note.expires_at)<=this.now()?'already_expired':'note_too_long'):'atomic_write_rejected'}))]};
    return this.transaction((db,now)=>this.withReceipt(db,owner,input,now,()=>{
      const blocked=this.full(db,settings)?'summary_required':memoryHistoryFull(db)?'history_full':undefined;
      if(blocked)return {saved:false,writes:[...writes,...entries.map(entry=>({category:entry.kind,status:'rejected' as const,reason:blocked}))]};
      const before:MemoryRow[]=[],changed:string[]=[];
      for(const {kind,scope,note} of entries) {
        const id=noteId(kind,note),existing=getMemoryRow(db,id);
        if(existing&&!activeMemory(existing,now)){writes.push({category:kind,status:'rejected',id,reason:'inactive_record_requires_review'});continue;}
        if(existing)before.push(existing);
        const added=this.insert(db,kind,note.text,scope,owner,now,{user:boundedMemoryText(user,240),session:owner.sessionId,turn:owner.turnId},id);
        if(!existing) {
          const expires=note.expires_at?Date.parse(note.expires_at):kind==='prediction'?now+7*86400000:null;
          db.prepare('UPDATE memory_records SET applies_when=?,expires=?,tokens=tokens+? WHERE id=?').run(note.applies_when??'',expires,memoryTokens(note.applies_when??''),id);
          for(const term of memoryTerms(note.applies_when??''))db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)').run(id,term);
        }
        if(added.changed)changed.push(id);
        writes.push({category:kind,status:existing?'deduplicated':'created',id});
      }
      if(changed.length)recordMemoryChange(db,before.filter(row=>changed.includes(row.id)),changed,'agent','Record memory',now);
      return {saved:writes.some(entry=>entry.status==='created'||entry.status==='deduplicated'),writes};
    }),signal);
  }
  private withReceipt<T>(db:DatabaseSync,owner:MemoryOwner,input:unknown,now:number,run:()=>T):T {
    const fingerprint=memoryHash(JSON.stringify(input)),key=memoryHash(`${owner.sessionId}:${owner.turnId}:${owner.operationId??fingerprint}`);
    const prior=db.prepare('SELECT fingerprint,result FROM memory_receipts WHERE id=?').get(key);
    if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Memory operation ID was reused with different input.');return JSON.parse(String(prior.result)) as T;}
    const result=run();db.prepare('INSERT INTO memory_receipts VALUES(?,?,?,?)').run(key,fingerprint,JSON.stringify(result),now);
    db.exec('DELETE FROM memory_receipts WHERE id NOT IN (SELECT id FROM memory_receipts ORDER BY created DESC LIMIT 10000)');return result;
  }
  private search(db: DatabaseSync, query:string, settings:IndividuationSettings,now=this.now(),kind?:CheckHabitInput['kind']): MemoryRow[] & {capped?:boolean} {
    const enabled=mask(settings), terms=memoryTerms(query);
    if(query && !terms.length) return [];
    if(!query) return db.prepare("SELECT * FROM memory_records WHERE kind!='evidence' AND state='active' AND (expires IS NULL OR expires>?) AND (scope & ?)=scope AND (? IS NULL OR kind=?) ORDER BY kind='habit' DESC,updated DESC,id LIMIT 64").all(now,enabled,kind??null,kind??null) as MemoryRow[];
    const rows=db.prepare(`SELECT r.*,COUNT(DISTINCT t.term) relevance FROM memory_records r JOIN memory_terms t ON r.id=t.record_id
      WHERE t.term IN (${terms.map(()=>'?').join(',')}) AND r.kind!='evidence' AND r.state='active' AND (r.expires IS NULL OR r.expires>?) AND (r.scope & ?)=r.scope AND (? IS NULL OR r.kind=?)
      GROUP BY r.id ORDER BY relevance DESC,r.kind='habit' DESC,r.updated DESC,r.id LIMIT 64`).all(...terms,now,enabled,kind??null,kind??null) as Array<MemoryRow & {relevance:number}>;
    return Object.assign(rows.filter(row=>row.relevance>=Math.min(2,terms.length) || terms.some(term=>term.length>=3 && (row.text+' '+row.applies_when).toLocaleLowerCase().includes(term))),{capped:rows.length>=64});
  }
  async read(input:CheckHabitInput,settings:IndividuationSettings,excluded:readonly string[]=[],budget=1000,signal?:AbortSignal):Promise<MemoryRead> {
    signal?.throwIfAborted();
    const base:MemoryRead={status:!mask(settings)?'disabled':input.ids?'not_found':'no_match',memories:[],matched_count:0,count_capped:false,
      disabled_categories:[...(!settings.habits?['habit' as const]:[]),...(!settings.predictions?['prediction' as const]:[])]};
    if(input.mode==='list')base.next_cursor=null;
    if(!mask(settings)||input.kind==='habit'&&!settings.habits||input.kind==='prediction'&&!settings.predictions)return {...base,status:'disabled'};
    if(!existsSync(this.path))return {...base,...(input.ids?{omitted:input.ids.map(id=>({id,reason:'not_found' as const}))}:{})};
    return this.transaction((db,now)=>{
      if(input.ids) {
        const omitted:NonNullable<MemoryRead['omitted']>=[];
        for(const id of new Set(input.ids)) {
          const row=getMemoryRow(db,id);
          if(!row||row.kind==='evidence'){omitted.push({id,reason:'not_found'});continue;}
          if((row.scope&mask(settings))!==row.scope){omitted.push({id,reason:'disabled'});continue;}
          base.memories.push(memoryView(row,now));
        }
        return {...base,status:base.memories.length?'ok':omitted.some(r=>r.reason==='disabled')?'disabled':'not_found',matched_count:base.memories.length,omitted};
      }
      if(input.mode==='list' || input.count_only&&!input.topics) return this.readPage(db,now,input,settings,base,budget);
      const candidates=new Map<string,{row:MemoryRow;score:number}>();
      for(const topic of input.topics??['']) {
        const found=this.search(db,topic,settings,now,input.kind);base.count_capped ||= found.capped===true||found.length>=64;
        found.forEach((row,index)=>candidates.set(row.id,{row,score:(candidates.get(row.id)?.score??0)+1/(index+1)}));
      }
      const rows=[...candidates.values()].sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)).map(value=>value.row);
      base.matched_count=rows.length;
      if(input.count_only)return {...base,status:rows.length?'ok':'no_match'};
      const seen=new Set(excluded);
      const hashes=new Set(excluded.flatMap(id=>{const row=db.prepare('SELECT kind,text FROM memory_records WHERE id=?').get(id);return row?[`${row.kind}:${memoryHash(String(row.text))}`]:[];}));
      let remaining=budget-60;
      for(const row of rows) {
        const hash=`${row.kind}:${memoryHash(row.text)}`;
        if(seen.has(row.id)||hashes.has(hash)) continue;
        const overhead=memoryTokens(JSON.stringify(memoryView(row,now,'')));
        if(remaining-overhead<24)break;
        const text=boundedMemoryText(row.text,Math.min(180,remaining-overhead-8));
        const entry=memoryView(row,now,text);
        const cost=memoryTokens(JSON.stringify(entry)); if(cost>remaining) break;
        base.memories.push(entry);seen.add(row.id);hashes.add(hash);remaining-=cost;
        if(base.memories.length>=5 || remaining<80) break;
      }
      return {...base,status:base.memories.length?'ok':rows.length?rows.every(row=>excluded.includes(row.id)||hashes.has(`${row.kind}:${memoryHash(row.text)}`))?'already_supplied':'budget_limited':'no_match'};
    },signal);
  }
  private readPage(db:DatabaseSync,now:number,input:CheckHabitInput,settings:IndividuationSettings,base:MemoryRead,budget:number):MemoryRead {
    const kind=input.kind??null,enabled=mask(settings);
    let ceiling=Number(db.prepare('SELECT COALESCE(MAX(seq),0) n FROM memory_records').get()!.n),before=ceiling+1;
    if(input.cursor) {
      try {
        const cursor=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
        if(cursor.v!==1 || cursor.kind!==kind || cursor.enabled!==enabled ||
          !Number.isSafeInteger(cursor.ceiling)||cursor.ceiling<0 ||
          !Number.isSafeInteger(cursor.before)||cursor.before<1||cursor.before>cursor.ceiling+1)throw Error('Invalid cursor');
        ceiling=cursor.ceiling;before=cursor.before;
      } catch { return {...base,status:'invalid_cursor',next_cursor:null}; }
    }
    // Stable keyset pagination: new writes do not shift later pages or repeat
    // earlier records. Category settings and active/expiry checks still apply.
    const where="kind!='evidence' AND state='active' AND (expires IS NULL OR expires>?) AND (scope & ?)=scope AND (? IS NULL OR kind=?) AND seq<=?";
    const params=[now,enabled,kind,kind,ceiling];
    const count=Number(db.prepare(`SELECT COUNT(*) n FROM memory_records WHERE ${where}`).get(...params)!.n);
    if(input.count_only)return {...base,status:count?'ok':'no_match',matched_count:count};
    const rows=db.prepare(`SELECT * FROM memory_records WHERE ${where} AND seq<? ORDER BY seq DESC LIMIT 6`).all(...params,before) as MemoryRow[];
    const continuation=(seq:number)=>Buffer.from(JSON.stringify({v:1,kind,enabled,ceiling,before:seq})).toString('base64url');
    const envelope={...base,status:'budget_limited',matched_count:count,next_cursor:continuation(before)};
    let remaining=budget-memoryTokens(JSON.stringify(envelope))-10,lastSeq=before,consumed=0;
    for(const row of rows.slice(0,5)) {
      const overhead=memoryTokens(JSON.stringify(memoryView(row,now,'')));
      if(remaining-overhead<24)break;
      const text=boundedMemoryText(row.text,Math.min(180,remaining-overhead-8));
      const entry=memoryView(row,now,text),cost=memoryTokens(JSON.stringify(entry));
      if(cost>remaining)break;
      base.memories.push(entry);remaining-=cost+1;lastSeq=row.seq;consumed++;
    }
    // An oversized legacy record must not stall the scan or disappear silently.
    // Return its ID for an explicit full read, then allow the next page to advance.
    if(rows.length && !consumed)return {...base,status:'budget_limited',matched_count:count,
      omitted:[{id:rows[0]!.id,reason:'budget_limited'}],
      next_cursor:rows.length>1?continuation(rows[0]!.seq):null};
    const more=rows.length>consumed;
    return {...base,status:base.memories.length?'ok':rows.length?'budget_limited':'no_match',matched_count:count,
      next_cursor:more&&consumed>0?continuation(lastSeq):null};
  }
  async check(query:string,settings:IndividuationSettings,excluded:readonly string[]=[],budget=1000,signal?:AbortSignal) {
    return (await this.read({...(query?{topics:[query.slice(0,4000)]}:{})},settings,excluded,budget,signal)).memories;
  }
  async change(input:MemoryChange,settings:IndividuationSettings,owner:MemoryOwner,actor:'agent'|'user',user='',signal?:AbortSignal) {
    signal?.throwIfAborted();
    if(!mask(settings))return {status:'disabled'};
    if(!existsSync(this.path))return {status:'not_found'};
    return this.transaction((db,now)=>this.withReceipt(db,owner,input,now,()=>{
      const old=getMemoryRow(db,input.id);
      if(!old||old.kind==='evidence')return {status:'not_found'};
      if((old.scope&mask(settings))!==old.scope)return {status:'disabled'};
      if(old.revision!==input.revision)return {status:'conflict',reason:'Read the current revision before editing.'};
      if(!activeMemory(old,now))return {status:'rejected',reason:'Record is inactive; undo its change in settings.'};
      if(actor==='agent'&&old.origin==='user')return {status:'rejected',reason:'User-confirmed records can only be changed in settings.'};
      const userCorrection=Boolean(input.user_quote&&user.includes(input.user_quote));
      if(actor==='agent'&&(input.action==='confirm'||input.action!=='dispute'&&!userCorrection))return {status:'rejected',reason:'An exact quote from the current user correction is required; otherwise mark disputed.'};
      if(input.replacement && (input.replacement.kind==='habit'&&!settings.habits || input.replacement.kind==='prediction'&&!settings.predictions))return {status:'disabled'};
      if(input.replacement && (memoryTokens(input.replacement.text+' '+(input.replacement.applies_when??''))>MAX_MEMORY_NOTE_TOKENS || input.replacement.expires_at&&Date.parse(input.replacement.expires_at)<=now))return {status:'rejected',reason:'Replacement is too long or already expired.'};
      if(memoryHistoryFull(db))return {status:'rejected',reason:'history_full'};
      const before=[old],ids=[old.id];let replacementId:string|undefined;
      if(input.replacement) {
        const note=input.replacement;replacementId=noteId(note.kind,note);
        if(replacementId===old.id)return {status:'rejected',reason:'Replacement is identical.'};
        const existing=getMemoryRow(db,replacementId);
        if(existing&&!activeMemory(existing,now))return {status:'rejected',reason:'Replacement is a retired record; review its history first.'};
        if(existing&&actor==='agent'&&existing.origin==='user')return {status:'rejected',reason:'Replacement is user-confirmed; it cannot be overwritten.'};
        if(existing)before.push(existing);
        this.insert(db,note.kind,note.text,note.kind==='habit'?1:2,owner,now,{session:owner.sessionId,turn:owner.turnId,user:boundedMemoryText(actor==='user'?input.reason:input.user_quote??'',240)},replacementId);
        const inserted=getMemoryRow(db,replacementId)!;
        db.prepare('UPDATE memory_records SET applies_when=?,expires=?,confirmed=?,origin=?,tokens=?,revision=revision+1 WHERE id=?')
          .run(note.applies_when??'',existing?existing.expires:note.expires_at?Date.parse(note.expires_at):note.kind==='prediction'?now+7*86400000:null,
            now,actor,memoryTokens(note.text+(note.applies_when??'')+inserted.metadata),replacementId);
        for(const term of memoryTerms(note.applies_when??''))db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)').run(replacementId,term);
        ids.push(replacementId);
      }
      if(input.action==='confirm')db.prepare("UPDATE memory_records SET origin='user',confirmed=?,updated=?,revision=revision+1 WHERE id=?").run(now,now,old.id);
      else db.prepare('UPDATE memory_records SET state=?,rejected=?,replaced_by=?,updated=?,revision=revision+1 WHERE id=?')
        .run(input.action==='supersede'?'superseded':input.action==='dispute'?'disputed':'retracted',actor==='user'||userCorrection?now:old.rejected,JSON.stringify(replacementId?[replacementId]:[]),now,old.id);
      db.exec('UPDATE memory_state SET revision=revision+1 WHERE id=1');
      const changeId=recordMemoryChange(db,before,ids,actor,input.reason,now);
      return {status:'ok',change_id:changeId,id:old.id,...(replacementId?{replacement_id:replacementId}:{})};
    }),signal);
  }
  async list(settings:IndividuationSettings,cursor=0,includeInactive=false,signal?:AbortSignal) {
    if(!existsSync(this.path)||!mask(settings))return {records:[],next_cursor:null};
    return this.transaction((db,now)=>{
      const rows=db.prepare(`SELECT * FROM memory_records WHERE kind!='evidence' AND (scope & ?)=scope AND seq>? ${includeInactive?'':"AND state='active' AND (expires IS NULL OR expires>?)"} ORDER BY seq LIMIT 21`)
        .all(mask(settings),cursor,...(includeInactive?[]:[now])) as MemoryRow[];
      return {records:rows.slice(0,20).map(row=>memoryView(row,now)),next_cursor:rows.length>20?rows[19]!.seq:null};
    },signal);
  }
  async history(settings:IndividuationSettings,cursor=0,signal?:AbortSignal) {
    if(!existsSync(this.path)||!mask(settings))return {changes:[],next_cursor:null};
    return this.transaction((db,now)=>{
      const rows=db.prepare('SELECT * FROM memory_changes WHERE (?=0 OR seq<?) ORDER BY seq DESC LIMIT 21').all(cursor,cursor) as MemoryJournalRow[];
      let bytes=0;const page:MemoryJournalRow[]=[];
      for(const row of rows.slice(0,20)) {
        const size=Buffer.byteLength(row.before_rows)+Buffer.byteLength(row.after_rows);
        if(page.length&&bytes+size>512*1024)break;
        page.push(row);bytes+=size;
      }
      const changes=page.flatMap(row=>{
        const before=JSON.parse(row.before_rows) as MemoryRow[],after=JSON.parse(row.after_rows) as MemoryRow[];
        if([...before,...after].some(record=>(record.scope&mask(settings))!==record.scope))return [];
        return [{id:row.id,created_at:row.created,actor:row.actor,reason:row.reason,before:before.map(r=>memoryView(r,now)),
          after:after.map(r=>memoryView(r,now)),undo_of:row.undo_of,can_undo:canUndoMemoryChange(db,row)}];
      });
      return {changes,next_cursor:rows.length>page.length?page.at(-1)!.seq:null};
    },signal);
  }
  async undo(changeId:string,settings:IndividuationSettings,owner:MemoryOwner,signal?:AbortSignal) {
    if(!existsSync(this.path))return {status:'not_found'};
    return this.transaction((db,now)=>this.withReceipt(db,owner,{undo:changeId},now,()=>{
      const event=db.prepare('SELECT * FROM memory_changes WHERE id=?').get(changeId) as MemoryJournalRow|undefined;
      if(!event)return {status:'not_found'};
      if((JSON.parse(event.after_rows) as MemoryRow[]).some(row=>(row.scope&mask(settings))!==row.scope))return {status:'disabled'};
      return undoMemoryChange(db,changeId,now);
    }),signal);
  }
  async purgeHistory(settings:IndividuationSettings,signal?:AbortSignal) {
    if(!existsSync(this.path))return emptyStatus();
    return this.transaction((db,now)=>{
      // Explicit user maintenance only. Keep ID tombstones so retired text cannot be re-added silently.
      db.prepare("UPDATE memory_records SET text='',applies_when='',metadata='{}',tokens=0,revision=revision+1 WHERE (state!='active' OR (expires IS NOT NULL AND expires<=?)) AND (scope & ?)=scope").run(now,mask(settings));
      db.exec("DELETE FROM memory_terms WHERE record_id IN (SELECT id FROM memory_records WHERE text='')");
      for(const event of db.prepare('SELECT * FROM memory_changes').all() as MemoryJournalRow[]) {
        if([...(JSON.parse(event.before_rows) as MemoryRow[]),...(JSON.parse(event.after_rows) as MemoryRow[])].every(row=>(row.scope&mask(settings))===row.scope)) {
          db.prepare('DELETE FROM memory_changes WHERE id=?').run(event.id);db.prepare('DELETE FROM memory_change_reviews WHERE change_id=?').run(event.id);
        }
      }
      db.exec('DELETE FROM memory_receipts; UPDATE memory_state SET revision=revision+1 WHERE id=1');
      return this.readStatus(db,settings,now);
    },signal);
  }
  async changedReferences(versions:Map<string,number>,settings:IndividuationSettings,signal?:AbortSignal) {
    if(!versions.size||!existsSync(this.path)||!mask(settings))return [];
    return this.transaction((db,now)=>[...versions].flatMap(([id,revision])=>{
      const row=getMemoryRow(db,id);
      // Expiry must invalidate a previously active reference even without a database write.
      const version=row&&!activeMemory(row,now)&&row.state==='active'?-row.revision:row?.revision;
      return row&&(row.scope&mask(settings))===row.scope&&version!==revision?[{id,revision:version!,state:memoryView(row,now).state,replaced_by:JSON.parse(row.replaced_by) as string[]}]:[];
    }).slice(0,20),signal);
  }
  async observe(text:string,settings:IndividuationSettings,owner:MemoryOwner,signal?:AbortSignal) {
    if(!settings.predictions || !text.trim()) return;
    await this.transaction((db,now)=>{
      if(this.full(db,settings)) return;
      const relevant=this.search(db,text,settings).filter(isForecast);
      const recent=db.prepare("SELECT * FROM memory_records WHERE kind IN ('note','prediction') AND state='active' AND (expires IS NULL OR expires>?) AND (scope & 2)=2 AND (scope & ?)=scope ORDER BY updated DESC LIMIT 8").all(now,mask(settings)) as MemoryRow[];
      relevant.push(...recent.filter(row=>metadata(row).session===owner.sessionId).slice(0,2));
      const related=[...new Set(relevant.filter(row=>metadata(row).turn!==owner.turnId).map(row=>row.id))].slice(0,5);
      if(!related.length) return;
      this.insert(db,'evidence',boundedMemoryText(text,600),2,owner,now,{related,session:owner.sessionId,turn:owner.turnId},`evidence_${memoryHash(`${owner.sessionId}:${owner.turnId}:${text}`)}`);
    },signal);
  }
  async status(settings:IndividuationSettings,signal?:AbortSignal):Promise<PersonalizationStatus> {
    if(!existsSync(this.path)) return emptyStatus();
    return this.transaction((db,now)=>this.readStatus(db,settings,now),signal);
  }
  private readStatus(db:DatabaseSync,settings:IndividuationSettings,now:number):PersonalizationStatus {
    const state=db.prepare('SELECT * FROM memory_state WHERE id=1').get()!;
    const records=db.prepare("SELECT kind,COUNT(*) count,COALESCE(SUM(tokens),0) tokens FROM memory_records WHERE state='active' AND (expires IS NULL OR expires>?) AND (scope & ?)=scope GROUP BY kind").all(now,mask(settings));
    const count=(kind:string)=>Number(records.find(row=>row.kind===kind)?.count??0);
    return {estimatedTokens:records.reduce((n,r)=>n+Number(r.tokens),0),records:records.reduce((n,r)=>n+Number(r.count),0),
      habitTokens:Number(records.find(row=>row.kind==='habit')?.tokens??0),eventTokens:records.filter(row=>row.kind!=='habit').reduce((n,r)=>n+Number(r.tokens),0),
      habits:count('habit'),predictions:count('prediction'),notes:count('note'),hits:Number(state.hits),misses:Number(state.misses),
      running:Boolean(state.lease && Number(state.lease_until)>now),lastSummaryAt:state.last_summary as number|null,lastError:state.last_error as string|null,
      inactiveRecords:Number(db.prepare("SELECT COUNT(*) count FROM memory_records WHERE kind!='evidence' AND (state!='active' OR expires<=?) AND (scope & ?)=scope").get(now,mask(settings))!.count),
      historyChanges:Number(db.prepare('SELECT COUNT(*) count FROM memory_changes').get()!.count)};
  }
  private stageRows(db:DatabaseSync,settings:IndividuationSettings,stage:MemoryStage,now:number):MemoryRow[] {
    return db.prepare("SELECT * FROM memory_records WHERE state='active' AND origin!='user' AND (expires IS NULL OR expires>?) AND (scope & ?)=scope AND (kind='habit')=? ORDER BY seq")
      .all(now,mask(settings),stage==='habits'?1:0) as MemoryRow[];
  }
  async begin(settings:IndividuationSettings,stage:MemoryStage,manual:boolean,signal?:AbortSignal,retryKey=''):Promise<MemorySnapshot|null> {
    if(!mask(settings) || !existsSync(this.path)) return null;
    return this.transaction((db,now)=>{
      const state=db.prepare('SELECT * FROM memory_state WHERE id=1').get()!;
      if(state.lease && Number(state.lease_until)>now) return null;
      const status=this.readStatus(db,settings,now);
      const tokens=stage==='events'?status.eventTokens:status.habitTokens;
      const threshold=stage==='events'?settings.eventTokenThreshold:settings.habitTokenThreshold;
      if(!tokens || !manual&&tokens<threshold) return null;
      const rows=this.stageRows(db,settings,stage,now);
      if(!rows.length)return null;
      // Each stage is a complete snapshot. Retrieval pagination never partitions consolidation.
      const fingerprint=stageFingerprint(stage,retryKey,rows);
      if(!manual) {
        const failed=db.prepare('SELECT retry_after FROM memory_summary_attempts WHERE fingerprint=?').get(fingerprint);
        if(failed&&(failed.retry_after===null||Number(failed.retry_after)>now))return null;
      }
      const lease=randomUUID(); db.prepare('UPDATE memory_state SET lease=?,lease_until=? WHERE id=1').run(lease,now+180_000);
      return {lease,stage,records:rows,tokens:rows.reduce((n,row)=>n+row.tokens,0),fingerprint,retryKey};
    },signal);
  }
  async apply(snapshot:MemorySnapshot,summary:MemorySummary,settings:IndividuationSettings,signal?:AbortSignal) {
    return this.transaction((db,now)=>{
      const state=db.prepare('SELECT * FROM memory_state WHERE id=1').get()!;
      if(state.lease!==snapshot.lease) throw Object.assign(new Error('Memory summary was superseded; original records were retained.'),{code:'memory_snapshot_changed'});
      if(snapshot.records.some(row=>!activeMemory(row,now)))throw Object.assign(new Error('Memory expired while summarizing; original records were retained.'),{code:'memory_snapshot_changed'});
      const originals=new Map(snapshot.records.map(r=>[r.id,r]));
      const unchangedStage=this.stageRows(db,settings,snapshot.stage,now).every(row=>originals.get(row.id)?.revision===row.revision);
      if(snapshot.stage==='habits'&&(summary.predictions.length||summary.reviews.length))throw new MemorySummaryValidationError('disabled_category','Habit compaction cannot create or review predictions.');
      if(memoryHistoryFull(db))throw new MemorySummaryValidationError('history_full','Memory history is full; original records were retained.');
      const historyBefore=new Map(originals),affected=new Set(originals.keys());
      for(const item of [...summary.habits,...summary.predictions]) if(!item.sources.length || new Set(item.sources).size!==item.sources.length || item.sources.some(id=>!originals.has(id))) throw new MemorySummaryValidationError('unsupported_sources','Summary contains unsupported sources.');
      const reviewPairs=new Set<string>();
      const validReviews=summary.reviews.filter(review=>{
        const pair=`${review.prediction}:${review.evidence}`;
        if(reviewPairs.has(pair)) throw new MemorySummaryValidationError('invalid_review','Prediction review is duplicated.');
        reviewPairs.add(pair);
        const prediction=originals.get(review.prediction),evidence=originals.get(review.evidence);
        if(!prediction || !evidence || !isForecast(prediction) || evidence.kind!=='evidence' || evidence.seq<=prediction.seq || evidence.created<prediction.created || !metadata(evidence).related?.includes(prediction.id)) throw new MemorySummaryValidationError('invalid_review','Prediction review has no subsequent user evidence.');
        return true;
      });
      // A concurrent repeat changes revision. Retry later instead of losing evidence or merging twice.
      if(snapshot.records.some(row=>Number(db.prepare('SELECT revision FROM memory_records WHERE id=?').get(row.id)?.revision)!==row.revision)) throw Object.assign(new Error('Memory changed while summarizing; original records were retained.'),{code:'memory_snapshot_changed'});
      // New dependent evidence requires a fresh complete event snapshot. Unrelated writes
      // may proceed, but must not cause originals and their replacements to coexist.
      if(snapshot.stage==='events'&&(db.prepare("SELECT * FROM memory_records WHERE kind='evidence' AND state='active' AND (expires IS NULL OR expires>?)").all(now) as MemoryRow[])
        .some(row=>!originals.has(row.id)&&(metadata(row).related??[]).some(id=>originals.has(id))))
        throw Object.assign(new Error('New evidence arrived while summarizing; original records were retained.'),{code:'memory_snapshot_changed'});
      const before=this.readStatus(db,settings,now).estimatedTokens;
      const hits=new Map<string,number>(),misses=new Map<string,number>(),reviewIds:string[]=[];
      const newReviews:MemorySummary['reviews']=[];
      for(const review of validReviews) {
        const reviewId=memoryHash(`${review.prediction}:${review.evidence}`);
        const saved=db.prepare('INSERT OR IGNORE INTO memory_reviews VALUES(?,?,?,?)').run(reviewId,review.outcome,review.reason,now);
        if(saved.changes) {
          reviewIds.push(reviewId);
          newReviews.push(review);
          const totals=review.outcome==='hit'?hits:misses;totals.set(review.prediction,(totals.get(review.prediction)??0)+1);
          db.exec(`UPDATE memory_state SET ${review.outcome==='hit'?'hits':'misses'}=${review.outcome==='hit'?'hits':'misses'}+1 WHERE id=1`);
        }
      }
      for(const row of snapshot.records) {
        db.prepare("UPDATE memory_records SET state='consolidated',hits=hits+?,misses=misses+?,updated=?,revision=revision+1 WHERE id=?")
          .run(hits.get(row.id)??0,misses.get(row.id)??0,now,row.id);
      }
      for(const [kind,items] of [['habit',summary.habits],['prediction',summary.predictions]] as const) for(const item of items) {
        if(kind==='habit'&&!settings.habits || kind==='prediction'&&!settings.predictions) throw new MemorySummaryValidationError('disabled_category','Summary attempted to write a disabled category.');
        const sourceRows=item.sources.map(id=>originals.get(id)!);
        const newOutcomes=(outcome:'hit'|'miss')=>new Set(newReviews.filter(review=>review.outcome===outcome&&item.sources.includes(review.prediction)).map(review=>review.evidence)).size;
        // Shared sources may have already been merged; do not multiply their old counts.
        const inheritedHits=Math.max(0,...sourceRows.map(row=>row.hits))+newOutcomes('hit');
        const inheritedMisses=Math.max(0,...sourceRows.map(row=>row.misses))+newOutcomes('miss');
        if(snapshot.stage==='events'&&kind==='habit'&&inheritedHits<2)
          throw new MemorySummaryValidationError('unsupported_promotion','Promoting a forecast requires repeated verified user evidence.');
        if(memoryTokens(item.text+' '+(item.applies_when??''))>MAX_MEMORY_NOTE_TOKENS)throw new MemorySummaryValidationError('note_too_long','Consolidated memory is too long.');
        if(sourceRows.some(row=>row.applies_when)&&!item.applies_when)throw new MemorySummaryValidationError('condition_lost','Summary dropped an explicit applicability condition.');
        const inheritedExpiry=sourceRows.filter(row=>row.kind===kind&&row.expires!==null).map(row=>row.expires!);
        const requestedExpiry=item.expires_at?Date.parse(item.expires_at):kind==='prediction'?now+7*86400000:null;
        const expiryLimits=[...inheritedExpiry,...(requestedExpiry===null?[]:[requestedExpiry])];
        const expires=expiryLimits.length?Math.min(...expiryLimits):null;
        if(expires!==null&&expires<=now)throw new MemorySummaryValidationError('expired_output','Summary returned an expired record.');
        const id=noteId(kind,item.expires_at?{...item,expires_at:new Date(expires!).toISOString()}:item),previous=getMemoryRow(db,id);
        if(previous&&!activeMemory(previous,now)&&!originals.has(id))throw new MemorySummaryValidationError('retired_source','Summary attempted to resurrect a retired record.');
        for(const source of sourceRows)if(source.id!==id && getMemoryRow(db,source.id)?.state==='consolidated') {
          const replaced=new Set(JSON.parse(getMemoryRow(db,source.id)!.replaced_by) as string[]);replaced.add(id);
          db.prepare('UPDATE memory_records SET replaced_by=? WHERE id=?').run(JSON.stringify([...replaced]),source.id);
        }
        if(previous?.origin==='user')continue;
        if(previous&&!historyBefore.has(id))historyBefore.set(id,previous);
        const lineage=[...new Set([...item.sources.filter(source=>source!==id),...(previous?metadata(previous).sources??[]:[])])].slice(0,100);
        const meta={...(previous?metadata(previous):{}),sources:lineage};
        const saved=this.insert(db,kind,item.text,kind==='habit'?1:2,{sessionId:'memory-summary',turnId:snapshot.lease},now,meta,id);
        affected.add(id);
        const firstSeen=Math.min(...sourceRows.map(row=>row.created),previous?.created??now);
        const confirmed=sourceRows.flatMap(row=>row.confirmed===null?[]:[row.confirmed]);
        const rejected=sourceRows.flatMap(row=>row.rejected===null?[]:[row.rejected]);
        for(const review of validReviews.filter(review=>item.sources.includes(review.prediction))) {
          const time=originals.get(review.evidence)!.created;
          (review.outcome==='hit'?confirmed:rejected).push(time);
        }
        db.prepare("UPDATE memory_records SET state='active',origin='summary',applies_when=?,expires=?,created=?,confirmed=?,rejected=?,replaced_by='[]',tokens=?,metadata=?,revision=revision+1 WHERE id=?")
          .run(item.applies_when??'',expires,firstSeen,confirmed.length?Math.max(...confirmed):null,rejected.length?Math.max(...rejected):null,memoryTokens(item.text+(item.applies_when??'')+JSON.stringify(meta)),JSON.stringify(meta),id);
        for(const term of memoryTerms(item.applies_when??''))db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)').run(id,term);
        // The global review ledger is exact; inherited per-record support is conservative.
        db.prepare('UPDATE memory_records SET observations=?,hits=?,misses=? WHERE id=?').run(Math.min(100,Math.max(previous?.observations??0,sourceRows.reduce((n,r)=>n+r.observations,0))),
          Math.max(previous?.hits??0,inheritedHits),Math.max(previous?.misses??0,inheritedMisses),saved.id);
      }
      // Compare the committed active view, including conditions, provenance and promoted
      // habits. Throwing here rolls back notes, review counts and history together.
      if(this.readStatus(db,settings,now).estimatedTokens>before)
        throw new MemorySummaryValidationError('insufficient_reduction','Summary increased active memory; original records were retained.');
      const changeId=recordMemoryChange(db,[...historyBefore.values()],affected,'summary','Consolidate memory',now,
        {hits:[...hits.values()].reduce((a,b)=>a+b,0),misses:[...misses.values()].reduce((a,b)=>a+b,0)});
      for(const id of reviewIds)db.prepare('INSERT INTO memory_change_reviews VALUES(?,?)').run(changeId,id);
      db.exec('UPDATE memory_state SET revision=revision+1 WHERE id=1');
      db.prepare('UPDATE memory_state SET lease=NULL,lease_until=0,retry_after=0,last_summary=?,last_error=NULL WHERE id=1').run(now);
      if(unchangedStage) {
        const fingerprint=stageFingerprint(snapshot.stage,snapshot.retryKey,this.stageRows(db,settings,snapshot.stage,now));
        db.prepare('INSERT OR REPLACE INTO memory_summary_attempts VALUES(?,?,NULL,?)').run(fingerprint,'completed',now);
        db.exec('DELETE FROM memory_summary_attempts WHERE fingerprint NOT IN (SELECT fingerprint FROM memory_summary_attempts ORDER BY updated DESC LIMIT 256)');
      }
      return this.readStatus(db,settings,now);
    },signal);
  }
  async fail(lease:string,message:string,failure?:{fingerprint?:string;code:string;retryable:boolean}) {
    await this.transaction((db,now)=>{
      const updated=db.prepare('UPDATE memory_state SET lease=NULL,lease_until=0,retry_after=?,last_error=? WHERE id=1 AND lease=?')
        .run(now+300_000,message.slice(0,300),lease);
      if(updated.changes&&failure?.fingerprint) {
        // A content/configuration fingerprint survives restarts and unrelated
        // writes. Deterministic failures require changed input or a manual retry.
        db.prepare('INSERT OR REPLACE INTO memory_summary_attempts VALUES(?,?,?,?)')
          .run(failure.fingerprint,failure.code,failure.retryable?now+300_000:null,now);
        db.exec('DELETE FROM memory_summary_attempts WHERE fingerprint NOT IN (SELECT fingerprint FROM memory_summary_attempts ORDER BY updated DESC LIMIT 256)');
      }
    });
  }
}
