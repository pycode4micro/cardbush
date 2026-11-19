import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AssistantContextMaintenance, assistantCheckpointPlan } from '../dist/assistantContextMaintenance.js';
import { AssistantModelHistory } from '../dist/assistantModelHistory.js';
import { registerContextCompactionTool } from '../dist/contextCompaction.js';
import { ToolRegistry } from '../dist/toolRegistry.js';
import { validateConversation } from '../dist/sessionStore.js';
const parent={protocol:'bush.session_turn_request.v1',sessionId:'assistant',turnId:'p',requestId:'r',model:'fixture',tools:[],inputMessages:[],prefixMessages:[],metadata:{contextWindowTokens:530000},maxOutputTokens:8000};
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.fail('timed out');};
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'assistant-idle-')), path=join(root,'history.jsonl'), history=new AssistantModelHistory(path), maintenance=new AssistantContextMaintenance();
  const registry=new ToolRegistry();registerContextCompactionTool(registry,()=>assert.fail('maintenance has no execution tools'));
  for(let i=0;i<60;i++)history.append([{role:'user',content:`Input ${i} `+'history data '.repeat(800)},
    {role:'assistant',content:'',toolCalls:[{id:`c${i}`,name:'read',argumentsText:'{}'}]},
    {role:'tool',toolCallId:`c${i}`,content:'fact '.repeat(1500)},
    {role:'assistant',content:`Answer ${i}`,toolCalls:[]}],[`input-${i}`]);
  history.append([],[],[{sessionId:'assistant',taskId:'done',attempt:'old'}],[]);
  t.after(()=>{maintenance.cancel();rmSync(root,{recursive:true,force:true});});
  return {history,maintenance,path,checkpoint:registry.definitions().find(t=>t.name==='checkpoint_context')};
}
async function* checkpoint(request,summary='User constraints and identifiers retained. Work remains a historical observation.') {
  const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
  yield {...base,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'checkpoint',nameDelta:'checkpoint_context',argumentsDelta:JSON.stringify({updates:[{source:0,summary}]})};
  yield {...base,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
}
test('idle checkpoint bounds the working set, preserves complete exchanges, IDs and original source across restart',async t=>{
  const f=fixture(t), before=f.history.read(), requests=[];
  const plan=assistantCheckpointPlan(before,parent);assert.ok(plan);validateConversation(plan.messages);
  const tail=before.messages.slice(plan.through-before.through);validateConversation(tail);assert.ok(tail.length>=8);
  const configured={...parent,tools:[{name:'unrelated_tool',description:'Unrelated foreground tool contract. '.repeat(6000),inputSchema:{type:'object'}}]};
  await f.maintenance.compact(f.history,configured,{async *stream(request){requests.push(request);yield*checkpoint(request);}},f.checkpoint,new AbortController().signal,[]);
  assert.ok(requests.length>=1&&requests.length<30);
  assert.ok(requests.every(r=>r.metadata.runtimeMaintenance==='assistant_context_compaction'&&r.tools.length===1));
  const after=f.history.read();assert.ok(after.through>0);assert.deepEqual(after.messages.slice(-8),before.messages.slice(-8));
  validateConversation(after.messages);assert.equal(assistantCheckpointPlan(after,parent),undefined);
  assert.deepEqual(after.entryIds,before.entryIds);assert.deepEqual(after.taskResults,before.taskResults);
  assert.match(readFileSync(f.path,'utf8'),/Input 0/);assert.deepEqual(new AssistantModelHistory(f.path).read(),after);
  assert.equal(f.maintenance.snapshot().phase,'completed');assert.ok(f.maintenance.snapshot().afterTokens<64000);
});
for(const mutation of ['cancel','checkpoint','unfinished-reply'])test(`a ${mutation} during maintenance prevents stale checkpoint commit`,async t=>{
  const f=fixture(t), gate=Promise.withResolvers(), controller=new AbortController();let started=false;
  const run=f.maintenance.compact(f.history,parent,{async *stream(request){started=true;await gate.promise;yield*checkpoint(request);}},f.checkpoint,controller.signal,[]);
  t.after(gate.resolve);await until(()=>started);
  if(mutation==='cancel')controller.abort();
  if(mutation==='checkpoint')f.history.checkpoint(4,'A newer checkpoint');
  if(mutation==='unfinished-reply')f.history.append([{role:'user',content:'Fresh input'}],['fresh'],[],['fresh']);
  const expected=f.history.read();gate.resolve();
  if(mutation==='cancel')await assert.rejects(run);else await run;
  assert.deepEqual(f.history.read(),expected);
});
test('new input cancels scheduled or in-flight idle work immediately, with no foreground error or retry storm',async t=>{
  const f=fixture(t), gate=Promise.withResolvers();let calls=0,signal;
  f.maintenance.schedule(async s=>{signal=s;calls++;await gate.promise;s.throwIfAborted();},1);
  t.after(gate.resolve);await until(()=>calls===1);f.maintenance.cancel();assert.equal(signal.aborted,true);
  f.maintenance.schedule(async()=>{calls++;throw Error('provider unavailable');},1);await until(()=>calls===2);
  await new Promise(r=>setTimeout(r,10));assert.equal(f.maintenance.snapshot().phase,'failed');
  f.maintenance.schedule(async()=>{calls++;},1);await new Promise(r=>setTimeout(r,10));assert.equal(calls,2);
  gate.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(f.maintenance.snapshot().phase,'failed','stale cancellation must not replace the newer job status');
});

test('checkpoint source budgeting counts historical reasoning serialized as text',t=>{
  const f=fixture(t), source=f.history.read();
  const plain=assistantCheckpointPlan(source,parent);
  source.messages=source.messages.map(message=>message.role==='assistant'
    ? {...message,reasoningContent:'Historical reasoning with quoted "facts". '.repeat(500)}:message);
  const withReasoning=assistantCheckpointPlan(source,parent);
  assert.ok(withReasoning.messages.length<plain.messages.length);
  validateConversation(withReasoning.messages);
  validateConversation(source.messages.slice(withReasoning.messages.length));
});

test('oversized indivisible sources retain original history and expose bounded failure diagnostics',async t=>{
  const f=fixture(t), source=f.history.read();
  source.messages[0]={role:'user',content:'one indivisible source '.repeat(100000)};
  const diagnostics=[];
  f.maintenance.schedule(async()=>assistantCheckpointPlan(source,parent),1,error=>diagnostics.push(error));
  await until(()=>f.maintenance.snapshot().phase==='failed');
  assert.equal(f.maintenance.snapshot().errorCode,'context_checkpoint_source_too_large');
  assert.equal(diagnostics.length,1);assert.doesNotMatch(diagnostics[0].message,/indivisible source/);
  assert.equal(f.history.read().through,0);
});

test('idle pressure keeps corrections and native task receipts, with paged original evidence after restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-recorded-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'history.jsonl'), history = new AssistantModelHistory(path);
  const initial = 'Use account 14.', correction = 'Correction: use 39. Cancel publication.';
  const originalLog = 'heartbeat '.repeat(1000) + 'signed-middle-evidence' + 'heartbeat '.repeat(1000);
  const source = Array.from({ length: 15 }, (_, i) => [
    { role: 'user', content: [initial, correction][i] ?? 'Continue.' },
    { role: 'assistant', content: '', reasoningContent: 'private-reasoning', toolCalls: [{ id: 'c' + i, name: 'tasks', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'c' + i, content: JSON.stringify({ tasks: [{ id: 'Q' + i, status: 'running' }], log: originalLog }) },
    { role: 'assistant', content: 'Observed.', toolCalls: [] },
  ]).flat();
  history.append(source);
  await new AssistantContextMaintenance().compact(history, { ...parent, metadata: { contextWindowTokens: 50000 } },
    { stream: () => assert.fail('Recorded history should fit without a model call') }, {}, new AbortController().signal, []);
  const restored = new AssistantModelHistory(path), state = restored.read();
  assert.deepEqual(state, history.read());
  assert.deepEqual(state.messages.filter(m => m.role === 'user'), source.filter(m => m.role === 'user'));
  validateConversation(state.messages);
  assert.deepEqual(state.messages.slice(-8), source.slice(-8));
  const receipt = JSON.parse(state.messages[2].content);
  assert.deepEqual(receipt.tasks, [{ id: 'Q0', status: 'running' }]);
  assert.ok(!state.messages[2].content.includes('signed-middle-evidence'));
  const input = { locator: receipt._assistant_history.locator, offset: 0, maxChars: 4999 };
  let text = '', page;
  do {
    page = await restored.readOriginal('assistant', input);
    text += page.text;
    input.offset = page.next_offset; input.revision = page.revision;
  } while (input.offset !== null);
  assert.ok(text.includes('signed-middle-evidence'));
  assert.ok(!text.includes('private-reasoning'));
  restored.clear(); restored.append(source);
  await assert.rejects(restored.readOriginal('assistant', { ...input, offset: 0 }), /unavailable/);
});

test('successive semantic checkpoints keep indexed user corrections and nested tool evidence even if the model omits them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-anchors-')), path = join(root, 'history.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new AssistantModelHistory(path);
  const correction = '用 LIME-39，撤回发布授权。';
  const fact = { tasks: [{ taskId: 'A-326', status: 'failed', code: 'E-17' }], log: 'history '.repeat(700) };
  history.append([{ role: 'user', content: correction },
    { role: 'assistant', content: '', toolCalls: [{ id: 'wrapped', name: 'call_tool', argumentsText: '{"name":"tasks","arguments":{}}' }] },
    { role: 'tool', toolCallId: 'wrapped', content: JSON.stringify(fact) }]);
  history.checkpoint(3, 'Batch inspected.', [], 2000);
  history.append([{ role: 'user', content: '保留字幕 SUB-72。' }, { role: 'assistant', content: '收到。', toolCalls: [] }]);
  history.checkpoint(5, 'Summary with no identifiers.', [], 2000);
  const restored = new AssistantModelHistory(path), memory = restored.read().memory;
  assert.match(memory, /LIME-39.*A-326.*E-17.*SUB-72/s);
  const evidence = JSON.parse(memory.slice(memory.indexOf('[{')));
  assert.deepEqual(evidence.map(item => item.index), [0, 2, 3]);
  assert.equal(evidence[0].text, correction);
  const tool = JSON.parse(evidence[1].text);
  assert.equal(tool.tool, 'tasks'); assert.deepEqual(tool.fields.tasks, fact.tasks);
  const range = memory.match(/conversation-history:\/\/[^\n]+/)[0];
  const single = range.replace(/\.0\//, '.2/').replace(/\.4$/, '.2');
  const page = await restored.readOriginal('assistant', { locator: single, offset: 0, maxChars: 12000 });
  assert.deepEqual(JSON.parse(JSON.parse(page.text).message.content), fact);
});

test('an existing summary acquires a durable original range on first open', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-legacy-')), path = join(root, 'history.jsonl');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [{ type: 'append', messages: [{ role: 'user', content: 'Cancel J-5.' }], entryIds: ['old'] },
    { type: 'checkpoint', through: 1, summary: 'Old summary.' }];
  writeFileSync(path, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const first = new AssistantModelHistory(path).read(), migrated = readFileSync(path, 'utf8');
  assert.equal(first.summary, 'Old summary.');
  const locator = first.memory.match(/conversation-history:\/\/[^\n]+/)[0];
  const second = new AssistantModelHistory(path);
  assert.deepEqual(second.read(), first); assert.equal(readFileSync(path, 'utf8'), migrated);
  assert.match((await second.readOriginal('assistant', { locator, offset: 0, maxChars: 500 })).text, /Cancel J-5/);
});
