import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AssistantFeedbackInput, MemoryMutation } from '@cardbush/bush-protocol';
import type { MemoryRow } from './individuationStore.js';
import { getMemoryRow, memoryMetadata, recordMemoryChange } from './individuationJournal.js';
import { boundedMemoryText, memoryTerms, memoryTokens } from './individuationText.js';

export const feedbackRecordId = (input:Pick<AssistantFeedbackInput,'sessionId'|'turnId'|'messageId'>) =>
  `feedback_${createHash('sha256').update(JSON.stringify([input.sessionId,input.turnId,input.messageId])).digest('hex').slice(0,32)}`;

/** One editable signal per reply. All changes and dependent invalidations share a transaction. */
export function writeAssistantFeedback(db:DatabaseSync,now:number,input:AssistantFeedbackInput,
  context:{user:string;assistant:string}|undefined):MemoryMutation {
  const id=feedbackRecordId(input),old=getMemoryRow(db,id),previous=old&&memoryMetadata(old).feedback;
  if(!old&&!input.rating)return {status:'ok'};
  if(old&&((!input.rating&&old.state==='retracted') || input.rating===previous?.rating&&['active','consolidated'].includes(old.state)))
    return {status:'ok',id};

  const before=new Map<string,MemoryRow>(),affected=new Set<string>();
  const remember=(row:MemoryRow)=>{before.set(row.id,row);affected.add(row.id);};
  if(old) {
    remember(old);
    const rows=db.prepare('SELECT * FROM memory_records').all() as MemoryRow[];
    const byId=new Map(rows.map(row=>[row.id,row]));
    const stale=new Set([id]);
    // Follow provenance through later habit compactions as well as direct summaries.
    for(let changed=true;changed;) {
      changed=false;
      for(const row of rows)if(!stale.has(row.id)&&row.origin==='summary'&&
        (memoryMetadata(row).sources??[]).some(source=>stale.has(source))) {
        stale.add(row.id);changed=true;
      }
      // The compact source list is bounded; the original records retain every replacement link.
      for(const row of rows)if(stale.has(row.id))for(const replacement of JSON.parse(row.replaced_by) as string[]) {
        if(!stale.has(replacement)&&byId.get(replacement)?.origin==='summary') {
          stale.add(replacement);changed=true;
        }
      }
    }
    const reconsider=new Set<string>();
    for(const row of rows)if(row.id!==id&&stale.has(row.id)) {
      for(const source of memoryMetadata(row).sources??[])reconsider.add(source);
      if(row.state==='active'||row.state==='consolidated') {
        remember(row);
        const meta=JSON.stringify({...memoryMetadata(row),feedbackInvalidated:true});
        db.prepare('UPDATE memory_records SET state=?,metadata=?,updated=?,revision=revision+1 WHERE id=?')
          .run(row.state==='active'?'disputed':row.state,meta,now,row.id);
      }
    }
    // Preserve other real votes as evidence for a later, corrected summary.
    for(const row of rows)if(row.id!==id&&row.kind==='feedback'&&row.state==='consolidated'&&
      (reconsider.has(row.id)||(JSON.parse(row.replaced_by) as string[]).some(replacement=>stale.has(replacement)))) {
      remember(row);
      db.prepare("UPDATE memory_records SET state='active',replaced_by='[]',updated=?,revision=revision+1 WHERE id=?").run(now,row.id);
    }
  }

  if(input.rating) {
    if(!context)throw new Error('The rated reply is unavailable.');
    const zh=/\p{Script=Han}/u.test(context.user||context.assistant);
    const user=boundedMemoryText(context.user,180),answer=boundedMemoryText(context.assistant,420);
    const text=zh
      ? `用户对这条回复${input.rating==='up'?'点赞（有帮助）':'点踩（不理想）'}，未提供具体原因。\n提问：${user}\n回复摘要：${answer}`
      : `The user rated this reply ${input.rating==='up'?'helpful':'unhelpful'}, without a specific reason.\nRequest: ${user}\nReply excerpt: ${answer}`;
    const meta=JSON.stringify({session:input.sessionId,turn:input.turnId,feedback:{rating:input.rating,messageId:input.messageId}});
    const tokens=memoryTokens(text+meta);
    if(old)db.prepare("UPDATE memory_records SET text=?,metadata=?,tokens=?,state='active',origin='agent',replaced_by='[]',updated=?,revision=revision+1 WHERE id=?")
      .run(text,meta,tokens,now,id);
    else db.prepare("INSERT INTO memory_records(id,kind,text,scope,tokens,created,updated,metadata) VALUES(?,'feedback',?,1,?,?,?,?)")
      .run(id,text,tokens,now,now,meta);
    db.prepare('DELETE FROM memory_terms WHERE record_id=?').run(id);
    for(const term of memoryTerms(text))db.prepare('INSERT OR IGNORE INTO memory_terms VALUES(?,?)').run(id,term);
  } else db.prepare("UPDATE memory_records SET state='retracted',updated=?,revision=revision+1 WHERE id=?").run(now,id);
  affected.add(id);
  db.exec('UPDATE memory_state SET revision=revision+1 WHERE id=1');
  const reason=input.rating==='up'?'用户点赞回复':input.rating==='down'?'用户点踩回复':'用户取消回复评价';
  return {status:'ok',id,change_id:recordMemoryChange(db,[...before.values()],affected,'user',reason,now)};
}
