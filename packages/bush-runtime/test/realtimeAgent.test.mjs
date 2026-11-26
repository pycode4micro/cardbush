import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryRuntimeHost, SessionStore, SubagentTaskStore, ToolRegistry } from '../dist/index.js';

const gate = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const until = async fn => { for (let i = 0; i < 300; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); };
test('spoken task summary uses the configured model and owned terminal result without a foreground turn or tools', async () => {
  const tasks = new SubagentTaskStore(), sessions = new SessionStore(), seen = [];
  let answer = '桌面共有十五个应用，主要是开发工具、浏览器和办公软件。完整清单可以在任务详情里查看。';
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, subagentTaskStore: tasks,
    runtimeDataRoot: await mkdtemp(join(tmpdir(), 'voice-summary-')), provider: { async *stream(request) {
      seen.push(request); const base = { protocol:'bush.model_event.v1', requestId:request.requestId, createdAt:new Date().toISOString() };
      yield {...base, sequence:0, kind:'response_started'};
      yield {...base, sequence:1, kind:'text_delta', delta:answer};
      yield {...base, sequence:2, kind:'response_completed', finishReason:'stop'};
    } } });
  const payload = { sessionId:'parent', taskId:'inventory', language:'zh', model:{model:'chosen-executor', metadata:{fixture:'kept'}} };
  const invoke = (input = payload) => host.sendCommand({kind:'runtime.realtime_task_summary', payload:input});
  tasks.start({taskId:'inventory', parentSessionId:'parent', parentTurnId:'voice_turn_call', childSessionId:'child', childTurnId:'child-turn',
    prompt:'查看桌面应用', inheritContext:true, inheritedMessageCount:0});
  try {
    await assert.rejects(invoke(), /No completed child/);
    const result = '| 名称 | 路径 |\n| Editor | C:\\Apps\\editor.exe |\n共十五个应用。';
    tasks.finish({parentSessionId:'parent',taskId:'inventory',status:'completed',finalResponse:result,errorMessage:'',usage:{}});
    await assert.rejects(invoke({...payload,sessionId:'unrelated'}), /No completed child/);
    assert.equal(seen.length,0);
    assert.deepEqual(await invoke(), {speech:answer});
    assert.equal(seen[0].model,'chosen-executor'); assert.deepEqual(seen[0].tools,[]);
    assert.equal(seen[0].metadata.runtimeMaintenance,'realtime_task_summary');
    assert.equal(seen[0].maxOutputTokens,128000);
    await invoke({...payload,model:{...payload.model,maxOutputTokens:16000}});
    assert.equal(seen.at(-1).maxOutputTokens,16000,'spoken summary inherits explicit model limits');
    assert.equal(JSON.parse(seen[0].messages.find(m=>m.role==='user').content).result,result);
    assert.match(seen[0].messages[0].content,/untrusted task DATA/);
    assert.equal(sessions.snapshot('parent'),undefined);
    for (answer of ['打开 C:\\Apps\\editor.exe','https://example.com/private','', '字'.repeat(501)]) {
      await assert.rejects(invoke(), /summary unavailable/);
    }
  } finally { await host.sendCommand({kind:'runtime.shutdown'}); }
});

test('hanging up cancels a pending spoken summary without changing the completed child', async () => {
  const tasks = new SubagentTaskStore(), ready = gate();
  tasks.start({taskId:'task',parentSessionId:'parent',parentTurnId:'voice_turn_call',childSessionId:'child',childTurnId:'turn',prompt:'inspect',inheritContext:false,inheritedMessageCount:0});
  tasks.finish({parentSessionId:'parent',taskId:'task',status:'completed',finalResponse:'verified finding',errorMessage:'',usage:{}});
  const host = new InMemoryRuntimeHost({subagentTaskStore:tasks, provider:{async *stream(request,{signal}) {
    ready.resolve(); await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    yield {protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString(),sequence:0,kind:'response_completed'};
  }}});
  const controller = new AbortController();
  const pending = host.sendCommand({kind:'runtime.realtime_task_summary',payload:{sessionId:'parent',taskId:'task',language:'en',model:{model:'fixture'}}}, controller.signal);
  void pending.catch(()=>{}); await ready.promise;
  try {controller.abort();await assert.rejects(pending);assert.equal(tasks.get('parent','task').finalResponse,'verified finding');}
  finally {await host.sendCommand({kind:'runtime.shutdown'});}
});

test('realtime parent dispatches parallel children while text turn is busy, reads, guides and resumes without losing policy', async () => {
  const parentGate = gate(), childGate = gate(), seen = [];
  const tasks = new SubagentTaskStore(), sessions = new SessionStore(), registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ runtimeDataRoot: await mkdtemp(join(tmpdir(), 'bush-voice-agents-')), sessionStore: sessions, subagentTaskStore: tasks, toolRegistry: registry,
    provider: { async *stream(request) {
      seen.push(request);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      await (request.metadata.agentRole === 'child' ? childGate.promise : parentGate.promise);
      yield { ...base, sequence: 1, kind: 'text_delta', delta: 'verified child answer' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: 'stop' };
    } } });
  const parent = { protocol: 'bush.session_turn_request.v1', requestId: 'voice-request', sessionId: 'parent', turnId: 'voice_turn_call', model: 'fixture',
    tools: registry.definitions(), prefixMessages: [{ role: 'system', content: 'configured agent role' }],
    inputMessages: [{ messageId: 'voice-input', message: { role: 'user', content: 'voice context' } }], metadata: {}, permissionMode: 'ask_for_approval' };
  const invoke = payload => host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: { sessionId: 'parent', ...payload } });
  const textTurn = host.runSessionTurn({ ...parent, requestId: 'text-r', turnId: 'text-turn' });
  try {
    await until(() => seen.some(r => r.turnId === 'text-turn'));
    const firstInput = { callId: 'first', action: 'subagent', parent, prompt: 'first task' };
    const [first, second] = await Promise.all([invoke(firstInput), invoke({ ...firstInput, callId: 'second', prompt: 'second task' })]);
    assert.equal(first.status, 'running'); assert.equal(second.status, 'running');
    const early = await invoke({ callId: 'early-guide', action: 'subagent', taskId: first.taskId, parent, prompt: 'keep the original scope' });
    assert.equal(early.status, 'message_queued', 'guidance also works during child startup');
    assert.notEqual(first.childSessionId, second.childSessionId);
    assert.equal(tasks.list('parent').length, 2);
    await assert.rejects(invoke({ ...firstInput, callId: 'unknown-child', taskId: 'not-owned' }), /belong/);
    await assert.rejects(invoke({ ...firstInput, callId: 'removed-tool', action: 'send_subagent_message', taskId: first.taskId }));
    assert.equal(tasks.list('parent').length, 2, 'invalid follow-ups never become new tasks');
    await assert.rejects(invoke({ ...firstInput, callId: 'disabled', parent: { ...parent, tools: [] } }), error => error.code === 'realtime_subagent_disabled');
    await assert.rejects(invoke({ ...firstInput, callId: 'mismatch', parent: { ...parent, sessionId: 'other' } }), /configured parent/);
    assert.deepEqual(await invoke(firstInput), first, 'a repeated receipt does not duplicate execution');
    await assert.rejects(invoke({ ...firstInput, prompt: 'changed' }), /reused/);
    await until(() => new Set(seen.filter(r => r.metadata.agentRole === 'child').map(r => r.sessionId)).size === 2);
    assert.ok(seen.filter(r => r.metadata.agentRole === 'child').every(r => r.permissionMode === 'ask_for_approval' && r.messages.some(m => m.content === 'configured agent role')));
    const guide = await invoke({ callId: 'guide', action: 'subagent', taskId: first.taskId, parent, prompt: 'only inspect, do not change files' });
    assert.equal(guide.status, 'message_queued');
    const live = await invoke({ callId: 'read-live', action: 'read_subagent_conversation', taskId: first.taskId });
    assert.ok(live.messages.some(m => m.author === 'parent_agent' && m.content === 'only inspect, do not change files'));
    await assert.rejects(invoke({ callId: 'other', sessionId: 'unrelated', action: 'read_subagent_conversation', taskId: first.taskId }), /belong/);
    childGate.resolve();
    await until(() => tasks.list('parent').every(t => t.status !== 'running'));
    const resumed = await invoke({ callId: 'follow-up', action: 'subagent', taskId: first.taskId, parent, prompt: 'explain your result' });
    assert.equal(resumed.childSessionId, first.childSessionId);
    assert.notEqual(resumed.taskId, first.taskId);
    await until(() => tasks.get('parent', resumed.taskId)?.status !== 'running');
    const history = await invoke({ callId: 'history', action: 'read_subagent_conversation', taskId: first.taskId });
    assert.ok(history.messages.some(m => m.content === 'explain your result' && m.author === 'parent_agent'));
    assert.ok(history.messages.some(m => m.role === 'assistant' && m.content === 'verified child answer'));
    const last = seen.filter(r => r.sessionId === first.childSessionId).at(-1);
    assert.ok(last.messages.some(m => m.content === 'verified child answer'), 'resumption retains child history');
    assert.equal(last.permissionMode, 'ask_for_approval');
  } finally {
    childGate.resolve(); parentGate.resolve(); await textTurn;
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  }
});

test('manual background session approval is reused for the exact action in the same session', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'background-session-grant-'));
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore();
  const prompts = [], executions = [], started = new Set();
  let target, decision;
  registry.register({
    definition: { name: 'read_guarded_fixture', description: 'Read an exact protected resource.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    visibleToChild: true, decodeInput: input => input,
    authorize: ({ input }) => ({ kind: 'ask', request: { reason: 'Read a protected resource', actions: ['read'],
      targets: [{ kind: 'opaque', value: input.target }], capabilityIds: ['fixture:read'] } }),
    execute: ({ input }) => { executions.push(input.target); return { read: true }; },
  });
  const host = new InMemoryRuntimeHost({ dataRoot, toolRegistry: registry, subagentTaskStore: tasks,
    requestBackgroundPermission: async input => {
      prompts.push(input.targets[0].value);
      assert.ok(decision, 'a matching session grant should bypass the prompt');
      return decision;
    },
    provider: { async *stream(request) {
      const first = !started.has(request.turnId);
      started.add(request.turnId);
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      yield { ...base, sequence: 0, kind: 'response_started' };
      if (first) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(),
        nameDelta: 'read_guarded_fixture', argumentsDelta: JSON.stringify({ target }) };
      else yield { ...base, sequence: 1, kind: 'text_delta', delta: 'Fixture settled.' };
      yield { ...base, sequence: 2, kind: 'response_completed', finishReason: first ? 'tool_calls' : 'stop' };
    } },
  });
  t.after(async () => {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.ok(dataRoot.startsWith(join(tmpdir(), 'background-session-grant-')));
    await rm(dataRoot, { recursive: true, force: true });
  });
  let index = 0;
  const dispatch = async (sessionId, resource, choice, previous) => {
    target = resource; decision = choice; index++;
    const parent = { protocol: 'bush.session_turn_request.v1', requestId: `request-${index}`, sessionId,
      turnId: `turn-${index}`, model: 'fixture', tools: registry.definitions(), prefixMessages: [],
      inputMessages: [{ messageId: `input-${index}`, message: { role: 'user', content: 'Read fixture.' } }],
      permissionMode: 'ask_for_approval', metadata: { subagentPermissionRouting: 'user', individuation: { habits: false, predictions: false } } };
    const receipt = await host.sendCommand({ kind: 'runtime.realtime_agent_tool', payload: {
      sessionId, callId: `dispatch-${index}`, action: 'subagent', parent, prompt: 'Read fixture.',
      ...(previous ? { taskId: previous.taskId } : {}),
    } });
    await until(() => tasks.get(sessionId, receipt.taskId)?.status === 'completed');
    return receipt;
  };
  const original = await dispatch('owner', 'first-resource', 'allow_session');
  const resumed = await dispatch('owner', 'first-resource', undefined, original);
  assert.equal(resumed.childSessionId, original.childSessionId);
  await dispatch('owner', 'second-resource', 'allow_once', resumed);
  await dispatch('owner', 'second-resource', 'deny', resumed);
  await dispatch('another-owner', 'first-resource', 'invalid');
  assert.deepEqual(prompts, ['first-resource', 'second-resource', 'second-resource', 'first-resource']);
  assert.deepEqual(executions, ['first-resource', 'first-resource', 'second-resource']);
});

for (const [permissionMode, routing] of [['all_free','user'], ['all_free','parent'], ['ask_for_approval','user']]) {
  test(`voice dispatch needs no confirmation; child respects ${permissionMode}/${routing}`, async () => {
    const tasks = new SubagentTaskStore(), registry = new ToolRegistry(), rounds = new Map();
    let executed = 0, permissionRequests = 0;
    const observed = [];
    registry.register({ definition: { name:'guarded_voice_action', description:'Test action', inputSchema:{type:'object'} },
      manifest:{effect_kind:'observation',operation:'fixture.read',risk:'low',owner:'fixture',dispatch_scope:'turn',mutating:false},
      visibleToChild:true, decodeInput:input=>input,
      authorize:()=>({kind:'ask',request:{reason:'guarded test action',actions:['read'],targets:[{kind:'opaque',value:'fixture://voice'}],capabilityIds:['fixture:voice']}}),
      execute:()=>{executed++;return {ok:true};} });
    const host = new InMemoryRuntimeHost({ toolRegistry:registry, subagentTaskStore:tasks,
      requestBackgroundPermission:async()=>{permissionRequests++;return false;},
      provider:{async *stream(request) {
        observed.push(request);
        const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
        yield {...base,sequence:0,kind:'response_started'};
        const round=rounds.get(request.sessionId)??0;rounds.set(request.sessionId,round+1);
        if (!round) {
          yield {...base,sequence:1,kind:'tool_call_delta',index:0,toolCallId:'guard',nameDelta:'guarded_voice_action',argumentsDelta:'{}'};
          yield {...base,sequence:2,kind:'response_completed',finishReason:'tool_calls'};
        } else {
          yield {...base,sequence:1,kind:'text_delta',delta:'test action settled'};
          yield {...base,sequence:2,kind:'response_completed',finishReason:'stop'};
        }
      }} });
    try {
      const parent={protocol:'bush.session_turn_request.v1',requestId:'voice-request',sessionId:'parent',turnId:'voice_turn_permission',model:'fixture',
        tools:registry.definitions(),prefixMessages:[],inputMessages:[{messageId:'input',message:{role:'user',content:'inspect'}}],permissionMode,
        metadata:{subagentPermissionRouting:routing,childAgentPolicy:{permissionRouting:routing,childPermissionMode:'ask_for_approval'}}};
      const receipt=await host.sendCommand({kind:'runtime.realtime_agent_tool',payload:{sessionId:'parent',callId:'dispatch',action:'subagent',parent,prompt:'inspect'}});
      assert.equal(receipt.status,'running');
      await until(()=>tasks.get('parent',receipt.taskId)?.status!=='running');
      assert.ok(observed.every(r=>r.permissionMode===permissionMode));
      assert.equal(permissionRequests,permissionMode==='all_free'?0:1);
      assert.equal(executed,permissionMode==='all_free'?1:0);
      assert.ok(observed.at(-1).messages.some(m=>m.role==='tool' && m.content.includes(permissionMode==='all_free'?'true':'permission_rejected')));
    } finally { await host.sendCommand({kind:'runtime.shutdown',payload:{}}); }
  });
}
