import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
import { fixtureState, fixtureTurn, conversationFixtureState, fixtureRecords, job, sessions, initialEvents, finalEvents } from './fixtures/web-transcript-data.mjs';
const ui = await loadChatTranscript({ source: `export * from ${JSON.stringify(path.resolve('web/transcript.ts'))};` });
const plain = value => JSON.parse(JSON.stringify(value));

test('committed native rendering folds intermediate replies and their tools beneath one final answer', () => {
  const source = fixtureState(), before = JSON.stringify(source), messages = ui.persistedTranscript(source);
  assert.equal(messages.length,2);
  assert.match(messages[1].content,/已经为您生成/);
  assert.deepEqual(plain(messages[1].loopHistory.map(item=>item.id)),['assistant-1','assistant-2']);
  assert.equal(messages[1].loopHistory.flatMap(item=>item.toolExecutions??[]).length,2);
  assert.equal(messages[1].loopHistory[1].toolExecutions[0].artifacts.length,1);
  assert.equal(JSON.stringify(source),before,'Projection must not mutate runtime history');
});
test('separate turns stay separate and hidden/superseded/maintenance rows do not render', () => {
  const source=fixtureState();
  source.snapshot.turns[0].messages.unshift({messageId:'secret',message:{role:'assistant',content:'private',visibility:'internal'}});
  source.snapshot.turns[0].messages.unshift({messageId:'maintenance',message:{role:'assistant',content:'compact'},metadata:{runtimeMaintenance:'context_compaction'}});
  source.snapshot.turns.push({...fixtureTurn(),turnId:'second',messages:[{messageId:'second-user',message:{role:'user',content:'另一个问题'}},{messageId:'old',message:{role:'assistant',content:'过时回复'}},{messageId:'second-final',message:{role:'assistant',content:'新的回复'}}]});
  source.snapshot.supersededMessageIds=['old'];
  const messages=ui.persistedTranscript(source);
  assert.equal(messages.length,4);
  assert.doesNotMatch(JSON.stringify(messages),/private|compact|过时回复/);
  assert.equal(messages.at(-1).turnId,'second');
});
test('web MIME attachment metadata adapts to native gallery without losing uploads', () => {
  const source=fixtureState();
  source.snapshot.turns[0].messages[0].metadata={attachments:[{id:'upload',name:'参考图',mime:'image/png',path:'/data/workspaces/uploads/reference.png'}, {id:'bad',path:'/data/config/key',mime:'image/png'}]};
  const attachment=ui.persistedTranscript(source)[0].attachments;
  assert.equal(attachment.length,1);assert.equal(attachment[0].type,'image');
});
function replay(events, live={}) { for(const [index,input] of events.entries()) {
  const event={...input,sequence:index,turnId:job.turnId,createdAt:job.createdAt};
  live=ui.applyTranscriptEvent(live,event);
  if(input.kind==='assistant_segment_delta'||input.kind==='assistant_segment_completed') live=ui.writeLiveSegment(live,job.turnId,input.payload.messageId,input.payload.delta??input.payload.content,input.kind.endsWith('completed'));
} return live; }
test('streamed text and tools share one native turn; final-response intent folds history before terminal commit', () => {
  let live=replay(initialEvents);let messages=ui.pendingTranscript(sessions[1].id,{...job,status:'running'},live[job.turnId]);
  assert.equal(messages.length,2);assert.equal(messages[1].toolExecutions[0].state,'running');
  live=replay(finalEvents,live);messages=ui.pendingTranscript(sessions[1].id,{...job,status:'running'},live[job.turnId]);
  assert.equal(messages.length,2);assert.equal(messages[1].metadata.transcript_kind,'assistant_final');
  assert.equal(messages[1].loopHistory.length,2);
  assert.equal(messages[1].loopHistory.flatMap(item=>item.toolExecutions??[]).length,2);
  const native=ui.persistedTranscript(fixtureState());
  assert.equal(messages[1].content,native[1].content);
});
test('replayed lifecycle events do not duplicate executions and session state is independent', () => {
  const live=replay(initialEvents), replayed=replay(initialEvents,live);
  assert.equal(Object.keys(replayed[job.turnId].tools).length,1);
  assert.equal(ui.pendingTranscript(sessions[1].id,{...job,turnId:'another',status:'running'},undefined)[1].toolExecutions,undefined);
  const complete=ui.writeLiveSegment(replayed,job.turnId,'assistant-1','authoritative',true);
  assert.equal(complete[job.turnId].segments['assistant-1'].content,'authoritative');
});
test('stopped execution retains its transcript instead of disappearing or becoming a successful final', () => {
  const live=replay(initialEvents);const messages=ui.pendingTranscript(sessions[1].id,{...job,status:'stopped'},live[job.turnId]);
  assert.equal(messages[1].metadata.stopped,true);assert.match(messages[1].content,/针织开衫/);
});
test('conversation-only snapshots use persisted summaries and defer large tool payloads until opened', () => {
  const state=conversationFixtureState(), messages=ui.persistedTranscript(state);
  assert.equal(messages.length,2);
  const tools=messages[1].loopHistory.flatMap(message=>message.toolExecutions??[]);
  assert.equal(tools.length,2);assert.ok(tools.every(tool=>tool.state==='completed'&&tool.metadata.nativeResultDeferred));
  assert.ok(tools.every(tool=>!tool.output));
  assert.equal(tools[1].metadata.displayTitle,'等待图片生成');
  const details=fixtureRecords().map(ui.webToolExecution);
  assert.equal(details[1].artifacts[0].path,'/data/workspaces/generated/grey-knit.png');
  const failed={...state.toolExecutions[0],outcome:'failed',error:{message:'失败'}};
  assert.equal(ui.webToolExecution(failed).state,'failed');
});
