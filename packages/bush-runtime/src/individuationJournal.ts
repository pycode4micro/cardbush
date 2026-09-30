import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MemoryRecord } from '@cardbush/bush-protocol';
import type { MemoryRow } from './individuationStore.js';
import { memoryTerms } from './individuationText.js';

export const memoryMetadata = (row:MemoryRow):{related?:string[];user?:string;session?:string;turn?:string;sources?:string[]} => JSON.parse(row.metadata);
export const activeMemory = (row:MemoryRow,now:number) => row.state==='active' && (row.expires===null || row.expires>now);
export function memoryView(row:MemoryRow,now:number,text=row.text):MemoryRecord {
  const meta=memoryMetadata(row);
  return {id:row.id,kind:row.kind,text,revision:row.revision,state:row.state==='active'&&!activeMemory(row,now)?'expired':row.state,
    origin:row.origin,applies_when:row.applies_when,created_at:row.created,age_days:Math.max(0,Math.floor((now-row.created)/86400000)),
    expires_at:row.expires,last_confirmed_at:row.confirmed,last_rejected_at:row.rejected,
    source:meta.session?{session_id:meta.session,turn_id:meta.turn??''}:null,replaced_by:JSON.parse(row.replaced_by),
    source_ids:meta.sources??[],content_cleared:row.text==='',truncated:text!==row.text,hits:row.hits,misses:row.misses};
}
export function initializeMemoryJournal(db:DatabaseSync) {
  const columns=new Set(db.prepare('PRAGMA table_info(memory_records)').all().map(r=>r.name));
  for(const [name,definition] of Object.entries({state:"TEXT NOT NULL DEFAULT 'active'",origin:"TEXT NOT NULL DEFAULT 'agent'",
    applies_when:"TEXT NOT NULL DEFAULT ''",expires:'INTEGER',confirmed:'INTEGER',rejected:'INTEGER',replaced_by:"TEXT NOT NULL DEFAULT '[]'"})) {
    if(!columns.has(name))db.exec(`ALTER TABLE memory_records ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS memory_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
    created INTEGER NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,before_rows TEXT NOT NULL,after_rows TEXT NOT NULL,
    undo_of TEXT,hits_delta INTEGER NOT NULL DEFAULT 0,misses_delta INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS memory_receipts(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS memory_change_reviews(change_id TEXT,review_id TEXT,PRIMARY KEY(change_id,review_id));
    CREATE INDEX IF NOT EXISTS memory_active ON memory_records(state,scope,updated DESC);`);
}
export const getMemoryRow = (db:DatabaseSync,id:string) => db.prepare('SELECT * FROM memory_records WHERE id=?').get(id) as MemoryRow|undefined;
export function memoryHistoryFull(db:DatabaseSync,additionalBytes=0) {
  const size=db.prepare('SELECT COUNT(*) count,COALESCE(SUM(length(CAST(before_rows AS BLOB))+length(CAST(after_rows AS BLOB))),0) bytes FROM memory_changes').get()!;
  return Number(size.count)>=2000 || Number(size.bytes)+additionalBytes>=32*1024*1024;
}
export function recordMemoryChange(db:DatabaseSync,before:MemoryRow[],ids:Iterable<string>,actor:string,reason:string,now:number,
  options:{undoOf?:string;hits?:number;misses?:number}={}) {
  const after=[...new Set(ids)].flatMap(id=>{const row=getMemoryRow(db,id);return row?[row]:[];});
  const beforeJson=JSON.stringify(before),afterJson=JSON.stringify(after);
  if(memoryHistoryFull(db,Buffer.byteLength(beforeJson)+Buffer.byteLength(afterJson)))throw new Error('Memory history is full. Clear inactive history from settings before making more changes.');
  const id=`change_${randomUUID()}`;
  db.prepare('INSERT INTO memory_changes(id,created,actor,reason,before_rows,after_rows,undo_of,hits_delta,misses_delta) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,now,actor,reason,beforeJson,afterJson,options.undoOf??null,options.hits??0,options.misses??0);
  return id;
}
export type MemoryJournalRow={seq:number;id:string;created:number;actor:string;reason:string;before_rows:string;after_rows:string;undo_of:string|null;hits_delta:number;misses_delta:number};
export function canUndoMemoryChange(db:DatabaseSync,change:MemoryJournalRow) {
  if(change.undo_of || db.prepare('SELECT 1 FROM memory_changes WHERE undo_of=?').get(change.id))return false;
  return (JSON.parse(change.after_rows) as MemoryRow[]).every(row=>getMemoryRow(db,row.id)?.revision===row.revision);
}
export function undoMemoryChange(db:DatabaseSync,changeId:string,now:number) {
  const event=db.prepare('SELECT * FROM memory_changes WHERE id=?').get(changeId) as MemoryJournalRow|undefined;
  if(!event || !canUndoMemoryChange(db,event))return {status:'conflict' as const,reason:'The change is missing, already undone, or a record has changed. Refresh history.'};
  const before=JSON.parse(event.before_rows) as MemoryRow[],after=JSON.parse(event.after_rows) as MemoryRow[];
  const originals=new Map(before.map(row=>[row.id,row]));
  for(const row of after) {
    const prior=originals.get(row.id);
    if(prior) {
      const columns=['kind','text','scope','tokens','created','observations','hits','misses','metadata','state','origin','applies_when','expires','confirmed','rejected','replaced_by'] as const;
      db.prepare(`UPDATE memory_records SET ${columns.map(key=>`${key}=?`).join(',')},updated=?,revision=revision+1 WHERE id=?`)
        .run(...columns.map(key=>prior[key]),now,row.id);
      db.prepare('DELETE FROM memory_terms WHERE record_id=?').run(row.id);
      for(const term of memoryTerms(prior.text+' '+prior.applies_when))db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)').run(row.id,term);
    } else db.prepare("UPDATE memory_records SET state='retracted',updated=?,revision=revision+1 WHERE id=?").run(now,row.id);
  }
  db.prepare('UPDATE memory_state SET revision=revision+1,hits=MAX(0,hits-?),misses=MAX(0,misses-?) WHERE id=1').run(event.hits_delta,event.misses_delta);
  // Restored evidence may be reviewed again. Remove only the ledger entries for this batch.
  db.prepare('DELETE FROM memory_reviews WHERE id IN (SELECT review_id FROM memory_change_reviews WHERE change_id=?)').run(event.id);
  const id=recordMemoryChange(db,after,after.map(row=>row.id),'user','Undo: '+event.reason,now,{undoOf:event.id,hits:-event.hits_delta,misses:-event.misses_delta});
  return {status:'ok' as const,change_id:id};
}
