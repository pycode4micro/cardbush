import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

const result = await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:'src/features/assistant/assistantTimeline.ts',formats:['es']}}});
const output = (Array.isArray(result) ? result[0] : result).output.find(item=>item.type==='chunk').code;
const { assistantTimeSeparators, assistantTimeLabel, assistantInputEntry } = await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));

test('timestamps separate conversations after five minutes and across local calendar days', () => {
  const at = (day,hour,minute,second=0) => new Date(2026,9,day,hour,minute,second).toISOString();
  const items = [at(30,15,6),at(30,15,6,30),at(30,15,7),at(30,15,7,20),at(30,15,12,19),at(30,15,17,19),at(30,23,59),at(31,0,1)]
    .map((at,index)=>({key:String(index),at}));
  assert.deepEqual([...assistantTimeSeparators(items)],['0','5','6','7']);
  assert.deepEqual([...assistantTimeSeparators(items.slice(2,5))],['2'],'a clipped quick transcript has its own first timestamp');
  assert.deepEqual([...assistantTimeSeparators([{key:'bad',at:'invalid'},...items])],['0','5','6','7']);
  assert.deepEqual([...assistantTimeSeparators([])],[]);
});

test('timestamp labels follow locale, show dates for older days and include a different year', () => {
  const now = new Date(2026,9,30,16,0), today = new Date(2026,9,30,15,6), yesterday = new Date(2026,9,29,15,6), old = new Date(2025,9,29,15,6);
  for (const language of ['zh','en']) {
    assert.equal(assistantTimeLabel(today.toISOString(),language,now),new Intl.DateTimeFormat(language,{hour:'2-digit',minute:'2-digit'}).format(today));
    assert.equal(assistantTimeLabel(yesterday.toISOString(),language,now),new Intl.DateTimeFormat(language,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(yesterday));
    assert.ok(assistantTimeLabel(old.toISOString(),language,now).includes('2025'));
  }
});

test('optimistic input preserves attachments and structured context without host inspection', async () => {
  const entry = await assistantInputEntry({text:'@C:/My Files/note.txt\n@C:/My Files/photo.png\n请查看',context:[{kind:'editing-location',content:'selected paragraph'}]});
  assert.equal(entry.content,'请查看');assert.equal(entry.attachments.length,2);
  assert.equal(entry.attachments.find(item=>item.name==='photo.png').type,'image');
  assert.equal(entry.promptContext[0].content,'selected paragraph');
  assert.ok(entry.id.startsWith('input-'));assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
});
