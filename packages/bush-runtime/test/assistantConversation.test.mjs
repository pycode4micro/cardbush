import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationJournal } from '../dist/conversationJournal.js';
import { AssistantConversation } from '../dist/assistantConversation.js';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, SubagentTaskStore } from '../dist/index.js';
import { assistantProfileSchema, PERSONAL_ASSISTANT_SESSION as id } from '@cardbush/bush-protocol';

const temporary = () => mkdtempSync(join(tmpdir(), 'assistant-conversation-'));
const entry = (key, content = '请帮我检查文件', role = 'user', source = 'text') => ({ id: key, content, role, source, visibility: 'conversation', createdAt: new Date().toISOString() });
const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const until = async fn => { for (let i = 0; i < 400; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
async function* response(request, { text = '', calls = [] } = {}) {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  let sequence = 0;
  yield { ...base, sequence: sequence++, kind: 'response_started' };
  if (text) yield { ...base, sequence: sequence++, kind: 'text_delta', delta: text };
  for (const [index, call] of calls.entries()) yield { ...base, sequence: sequence++, kind: 'tool_call_delta', index, toolCallId: call.id,
    nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  yield { ...base, sequence, kind: 'response_completed', finishReason: calls.length ? 'tool_calls' : 'stop' };
}
const parent = (registry, voice = false) => ({ protocol: 'bush.session_turn_request.v1', requestId: 'assistant-request', sessionId: id,
  turnId: 'assistant-turn', model: 'fixture', prefixMessages: [{ role: 'system', content: 'Execution instructions only.' }],
  inputMessages: [{ messageId: 'input', message: { role: 'user', content: 'Check the files' } }], tools: registry?.definitions() ?? [],
  metadata: { assistantOutputMode: voice ? 'voice' : 'text' }, permissionMode: 'task_free' });

test('conversation journal survives restart, deduplicates retries and repairs only an incomplete final append', () => {
  const root = temporary(), journal = new ConversationJournal(root), message = entry('speech', '中文语音');
  journal.append('chat-a', message);
  journal.append('chat-a', { ...message, createdAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(journal.read('chat-a').length, 1);
  assert.throws(() => journal.append('chat-a', { ...message, content: 'different' }), /reused/);
  appendFileSync(join(root, readdirSync(root)[0]), '{"id":"incomplete');
  const restored = new ConversationJournal(root);
  assert.equal(restored.read('chat-a')[0].content, message.content);
  restored.append('chat-a', entry('next'));
  assert.equal(new ConversationJournal(root).read('chat-a').length, 2);
  assert.deepEqual(restored.read('chat-b'), []);
  restored.forget('chat-a'); assert.deepEqual(new ConversationJournal(root).read('chat-a'), []);
});

test('assistant dispatch/await stay nonblocking; only Markdown and final replies render, task completion wakes the parent', async () => {
  const journal = new ConversationJournal(temporary()), tasks = [], seen = [], modelGate = gate();
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => tasks,
    checkpoint: () => ({}), delegate: async input => {
      assert.equal(input.targetAgent, 'saved-ssh-agent');
      tasks.push({ taskId: 'child-task', status: 'running', finalResponse: '', errorMessage: '' });
      return { taskId: 'child-task', status: 'running' };
    }, provider: { async *stream(request) {
      seen.push(request); const index = round++;
      if (index === 0) { await modelGate.promise; yield* response(request, { text: '我会检查文件。', calls: [{ id: 'dispatch', name: 'subagent', args: { prompt: 'Read only: inspect files' } }] }); }
      else if (index === 1) yield* response(request, { calls: [{ id: 'watch', name: 'await_subagent', args: { task_ids: ['child-task'] } }] });
      else if (index === 2) yield* response(request, { text: '已经交给后台处理，我们可以继续聊。' });
      else if (index === 3) yield* response(request, { calls: [{ id: 'page', name: 'page_write', args: { content: '**已核对**：文件正常。' } }] });
      else yield* response(request);
    } } });
  const command = { action: 'turn', sessionId: id, entry: entry('first'), parent: parent(), profile: assistantProfileSchema.parse({ targetAgent: 'saved-ssh-agent' }) };
  try {
    assert.equal(assistant.command(command).status, 'accepted');
    assert.equal(assistant.command({ action: 'read', sessionId: id }).busy, true);
    modelGate.resolve(); await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(tasks[0].status, 'running', 'main response finishes while child still executes');
    assert.equal(round, 3); assistant.command(command); await new Promise(r => setTimeout(r, 20)); assert.equal(round, 3, 'retry does not re-execute');
    assert.deepEqual(seen[0].tools.map(tool => tool.name).sort(), ['await_subagent', 'page_write', 'read_subagent_conversation', 'send_subagent_message', 'subagent']);
    assert.ok(!journal.read(id).some(item => item.content === '我会检查文件。'), 'loop commentary is not a page message');
    tasks[0].status = 'completed'; tasks[0].finalResponse = '文件正常';
    await until(() => journal.read(id).some(item => item.source === 'page'));
    const visible = journal.read(id).filter(item => item.visibility !== 'internal');
    assert.deepEqual(visible.map(item => item.role), ['user', 'assistant', 'assistant']);
    assert.match(visible.at(-1).content, /已核对/);
    assert.equal(journal.read(id).filter(item => item.source === 'task').length, 1);
  } finally { modelGate.resolve(); assistant.close(); }
});

test('chained assistant speech is retained internally while page_write remains visible', async () => {
  const journal = new ConversationJournal(temporary()); let calls = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}), delegate: async () => ({}),
    provider: { async *stream(request) { const index = calls++; yield* response(request, index % 2 ? { text: '我把重点写在页面上了。' } : { calls: [{ id: 'written', name: 'page_write', args: { content: `## 重点\n这里是第 ${index / 2 + 1} 份资料。` } }] }); } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('spoken', '需要一份资料', 'user', 'voice'), parent: parent(undefined, true), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.deepEqual(journal.read(id).map(item => [item.role, item.visibility]), [['user', 'conversation'], ['assistant', 'conversation'], ['assistant', 'internal']]);
    assistant.command({ action: 'turn', sessionId: id, entry: entry('spoken-again', '再整理另一份资料', 'user', 'voice'), parent: parent(undefined, true), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.equal(journal.read(id).filter(item => item.source === 'page').length, 2, 'reused provider call IDs in later turns do not collide');
  } finally { assistant.close(); }
});

test('long assistant history checkpoints through the text model, retaining original messages and loading no maintenance tools normally', async () => {
  const root = temporary(), journal = new ConversationJournal(root), seen = [];
  for (let i = 0; i < 12; i++) journal.append(id, entry(`old-${i}`, `Record ${i}: 保留项目的关键约束。`.repeat(220), i % 2 ? 'assistant' : 'user'));
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), toolRegistry: registry, provider: { async *stream() {} } });
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => registry.definitions().find(tool => tool.name === 'checkpoint_context'), delegate: async () => ({}),
    provider: { async *stream(request) { seen.push(request); yield* response(request, request.tools.length === 1 && request.tools[0].name === 'checkpoint_context'
      ? { calls: [{ id: `memory-${seen.length}`, name: 'checkpoint_context', args: { updates: [{ source: 0, summary: '记录了项目约束，尚无执行结果。' }] } }] }
      : { text: '已记住约束。' }); } } });
  try {
    assistant.command({ action: 'turn', sessionId: id, entry: entry('recent', '请记住'), parent: parent(), profile: assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action: 'read', sessionId: id }).busy);
    assert.equal(assistant.command({ action: 'read', sessionId: id }).error, '');
    assert.ok(seen.some(request => request.tools[0]?.name === 'checkpoint_context'));
    assert.ok(seen.at(-1).messages.some(message => message.name === 'conversation_memory'));
    assert.ok(!seen.at(-1).tools.some(tool => tool.name === 'checkpoint_context'));
    assert.equal(new ConversationJournal(root).read(id).filter(item => item.id.startsWith('old-')).length, 12);
  } finally { assistant.close(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('voice journal append during a foreground turn neither changes its revision nor breaks its commit; session deletion clears it', async () => {
  const sessions = new SessionStore(), registry = new ToolRegistry(), started = gate(), finish = gate();
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), sessionStore: sessions, toolRegistry: registry,
    provider: { async *stream(request) { started.resolve(); await finish.promise; yield* response(request, { text: 'Done' }); } } });
  const run = host.runSessionTurn(parent(registry));
  try {
    await started.promise;
    const revision = sessions.snapshot(id).revision;
    await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'append', sessionId: id, entry: entry('parallel-voice', '通话中的补充', 'user', 'voice') } });
    assert.equal(sessions.snapshot(id).revision, revision);
    finish.resolve(); await run;
    assert.equal(sessions.snapshot(id).turns.length, 1);
    assert.equal((await host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'read', sessionId: id } })).entries.length, 1);
    await host.sendCommand({ kind: 'runtime.delete_session', payload: { sessionId: id } });
    await assert.rejects(host.sendCommand({ kind: 'runtime.assistant_conversation', payload: { action: 'append', sessionId: id, entry: entry('late') } }), /no longer exists/);
  } finally { finish.resolve(); await run; await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('remote voice children retain host identity for guidance, reads and resumption', async () => {
  const tasks = new SubagentTaskStore(), registry = new ToolRegistry(), finish = gate(), guided = [];
  const host = new InMemoryRuntimeHost({ dataRoot: temporary(), subagentTaskStore: tasks, toolRegistry: registry,
    provider: { async *stream() {} }, remoteAgents: {
      list: async () => [{ id: 'remote-1', name: 'SSH', agentId: 'server-1' }],
      run: async input => { assert.equal(input.connectionId, 'remote-1'); await finish.promise; return { status: 'completed', finalResponse: 'Remote result', errorMessage: '', usage: {} }; },
      guide: async input => { guided.push(input); return { accepted: true }; },
      read: async () => undefined,
    } });
  const invoke = payload => host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: { sessionId: id, ...payload } });
  try {
    const first = await invoke({ callId: 'dispatch-remote', action: 'subagent', prompt: 'Inspect remote files', targetAgent: 'remote-1', parent: parent(registry) });
    assert.equal(first.status, 'running');
    await invoke({ callId: 'guide-remote', action: 'send_subagent_message', taskId: first.taskId, prompt: 'Read only', targetAgent: 'another-host', parent: parent(registry) });
    assert.equal(guided[0].connectionId, 'remote-1'); assert.equal(guided[0].parentSessionId, id);
    assert.equal((await invoke({ callId: 'read-remote', action: 'read_subagent_conversation', taskId: first.taskId })).status, 'starting');
    finish.resolve(); await until(() => tasks.get(id, first.taskId).status === 'completed');
    const resumed = await invoke({ callId: 'resume-remote', action: 'send_subagent_message', taskId: first.taskId, prompt: 'Explain', targetAgent: 'another-host', parent: parent(registry) });
    assert.equal(resumed.childSessionId, first.childSessionId);
  } finally { finish.resolve(); await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('assistant attachments survive history and enter model and child context with vision gated by settings', async () => {
  const root = temporary(), journal = new ConversationJournal(root), requests = [], dispatched = [];
  const attachments = [{ id: 'doc', name: '笔记.txt', path: 'C:/local/笔记.txt', type: 'document', execution: { connectionId: 'ssh', path: '/remote/笔记.txt' } },
    { id: 'image', name: 'screen.png', path: 'C:/local/screen.png', type: 'image' }];
  let round = 0;
  const assistant = new AssistantConversation(journal, { exists: () => true, tasks: () => [], checkpoint: () => ({}),
    delegate: async input => { dispatched.push(input); return { status: 'accepted' }; },
    provider: { async *stream(request) { requests.push(request); yield* response(request, round++ === 0
      ? { calls: [{ id:'read-file', name:'subagent', args:{ prompt:'读取附件并归纳' } }] } : { text:'已安排读取。' }); } } });
  try {
    const config = { ...parent(), requestCapabilities: { vision: true, interactiveRequests: false } };
    config.prefixMessages.push({ role:'developer', content:'Attached files:\n/remote/笔记.txt' });
    assistant.command({ action:'turn', sessionId:id, entry:{ ...entry('attached'), attachments }, parent:config, profile:assistantProfileSchema.parse({ targetAgent:'ssh' }) });
    await until(() => !assistant.command({ action:'read', sessionId:id }).busy);
    assert.match(requests[0].messages.at(-1).content, /remote\/笔记.txt/);
    assert.equal(requests[0].messages.at(-1).images[0].url, 'C:/local/screen.png');
    assert.equal(dispatched[0].targetAgent, 'ssh');
    assert.ok(dispatched[0].parent.prefixMessages.some(item => item.content.includes('/remote/笔记.txt')));
    assert.deepEqual(new ConversationJournal(root).read(id)[0].attachments, attachments);
    assistant.command({ action:'turn', sessionId:id, entry:entry('followup'), parent:parent(), profile:assistantProfileSchema.parse({}) });
    await until(() => !assistant.command({ action:'read', sessionId:id }).busy);
    assert.ok(!requests.at(-1).messages.some(item => item.images?.length), 'vision-off never sends history images');
    assert.ok(requests.at(-1).messages.some(item => item.content.includes('screen.png')), 'file references remain usable');
  } finally { assistant.close(); }
});


test('reset forgets memory and isolates late replies and transcripts without deleting other chats',async()=>{
  const journal=new ConversationJournal(temporary()),old=gate(),fresh=gate(),requests=[];
  const assistant=new AssistantConversation(journal,{exists:()=>true,tasks:()=>[],checkpoint:()=>({}),delegate:async()=>({}),
    provider:{async *stream(request){requests.push(request);await (requests.length===1?old:fresh).promise;yield* response(request,{text:requests.length===1?'old reply':'new reply'});}}});
  const profile=assistantProfileSchema.parse({name:'Lumi',persona:'reliable',targetAgent:'ssh-fixture',microphoneMuted:true,outputMuted:true});
  journal.append('other-chat',entry('other','keep this'));
  try {
    assistant.command({action:'turn',sessionId:id,entry:entry('old-input','old private context'),parent:parent(),profile,generation:0});
    await until(()=>requests.length===1);
    const result=assistant.command({action:'reset',sessionId:id});assert.equal(result.generation,1);
    assert.equal(assistant.command({action:'read',sessionId:id}).busy,false);assert.deepEqual(journal.read(id),[]);
    assert.equal(journal.read('other-chat').length,1);
    assert.throws(()=>assistant.command({action:'append',sessionId:id,entry:entry('late-voice'),generation:0}),/reset/);
    assert.throws(()=>assistant.command({action:'turn',sessionId:id,entry:entry('late-input'),parent:parent(),profile,generation:0}),/reset/);
    assistant.command({action:'turn',sessionId:id,entry:entry('new-input','fresh start'),parent:parent(),profile,generation:1});
    await until(()=>requests.length===2);
    assert.ok(!requests[1].messages.some(message=>message.content?.includes('old private context')));
    assert.match(requests[1].messages[0].content,/Lumi/);
    old.resolve();await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(assistant.command({action:'read',sessionId:id}).busy,true,'old cleanup cannot clear the new response');
    assert.equal(assistant.command({action:'read',sessionId:id}).error,'');
    fresh.resolve();await until(()=>!assistant.command({action:'read',sessionId:id}).busy);
    assert.equal(journal.read(id).filter(message=>message.role==='assistant').length,1);
  }finally{old.resolve();fresh.resolve();assistant.close();}
});
