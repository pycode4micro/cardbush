import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/features/chat/quickContextIndex.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { indexContextTurns, contextTickWindow } = await import('data:text/javascript;base64,' + Buffer.from(output).toString('base64'));
const message = (id, role, turnId, content=id, metadata={}) => ({ id, role, turnId, content, metadata });

test('turn previews keep protocol grouping, late finals, aliases and legacy guidance', () => {
  const messages = [message('u0','user','t0'), message('a0','assistant','t0'),
    message('g0','user','t0','guide',{turn_guidance:true}), message('u1','user','t1'),
    message('final0','assistant','t0','final',{transcript_kind:'assistant_final'}),
    {...message('u2','user'),messageId:'server-u2'}, message('g2','user',undefined,'guide',{name:'turn_guidance'}),
    message('a2','assistant'), message('u3','user')];
  const index = indexContextTurns(messages);
  assert.deepEqual(index.turns.map(m=>m.id),['u0','u1','u2','u3']);
  assert.deepEqual(index.messagesFor('u0').map(m=>m.id),['u0','a0','g0','final0']);
  assert.deepEqual(index.messagesFor('server-u2').map(m=>m.id),['u2','g2','a2']);
  assert.equal(index.byMessage.get('server-u2'), messages[5]);
  assert.deepEqual(index.messagesFor('missing'),[]);
  const prepended = indexContextTurns([message('older','user'),...messages]);
  assert.deepEqual(prepended.messagesFor('u0'),index.messagesFor('u0'),'prepending cannot shift an already selected preview');
  assert.deepEqual(indexContextTurns(messages.slice(5)).turns.map(m=>m.id),['u2','u3'],'removed history is not retained');
});

test('10,000-turn indexing and repeated previews do not read unrelated message content', () => {
  let contentReads=0, metadataReads=0;
  const messages=Array.from({length:10000},(_,i)=>['user','assistant'].map(role=>({
    id:`${role}-${i}`,role,get turnId(){metadataReads++;return `t${i}`;},
    get content(){contentReads++;return 'Long markdown '.repeat(1000);},
  }))).flat();
  const index=indexContextTurns(messages);
  assert.equal(contentReads,0,'indexing only needs metadata, not prompt/answer text');
  metadataReads=0;
  for(let i=0;i<1000;i++) assert.equal(index.messagesFor('user-0').length,2);
  assert.equal(contentReads,0);
  assert.equal(metadataReads,1000,'each lookup checks only its selected anchor, never the rest of history');
});

test('dense rails render a contiguous viewport and bounded overscan at every scroll position', () => {
  for(const count of [1,2,8,65,1000,10000]) for(const capacity of [2,8,32,96]) {
    for(const offset of [0,13.5,Math.floor(count/2)*9,count*9]) {
      const window=contextTickWindow(count,capacity,offset,9);
      assert.ok(window.start>=0&&window.end<=count);
      assert.ok(window.end-window.start<=Math.min(count,capacity+3));
      assert.ok(window.first>=window.start&&window.first<window.end);
      assert.equal(window.first,Math.min(Math.max(0,count-capacity),Math.floor(offset/9)));
    }
    assert.equal(contextTickWindow(count,capacity,0,9).start,0);
    assert.equal(contextTickWindow(count,capacity,count*9,9).end,count);
  }
  assert.deepEqual(contextTickWindow(0,96,0,9),{first:0,start:0,end:0});
});
