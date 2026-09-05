import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
}).outputText;
const shared = {exports:{}};
vm.runInNewContext(compile(fs.readFileSync('src/shared/sessionReadFence.ts','utf8')), {exports:shared.exports,module:shared});
const {SessionReadFence,canApplySessionSnapshot} = shared.exports;

// Execute the actual hook callbacks with a queued React-state adapter. No copied
// implementation, network calls, or timing based on wall-clock sleeps.
const source = ts.createSourceFile('hook.tsx',fs.readFileSync('src/hooks/useCardbushChat.ts','utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const hook = source.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='useCardbushChat');
const names = ['beginHistoryRead','beginHistoryLoading','isHistoryReadCurrent','applyHistoryRead',
  'refreshMeasuredContextWindowUsage','mergeContextWindowUsage','markSessionRunning','markSessionDone'];
const declarations = names.map(name=> {
  const statement=hook.body.statements.find(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>d.name.getText(source)===name));
  assert.ok(statement, name+' must exist');
  return statement.getText(source);
}).join('\n');
const requests = [];
const loading = new Map();
let messages = {a:[{id:'old',role:'user',content:'original'}],b:[]};
let usage = {};
const messageQueue=[], usageQueue=[];
const ref = current=>({current});
const bindings = {
  exports:{}, useCallback:fn=>fn,
  contextWindowUsageRequestsRef:ref(new Map()),contextUsageReadsRef:ref(new SessionReadFence()),
  historyReadsRef:ref(new SessionReadFence()),messagesByConversationRef:ref(messages),
  liveTranscriptSessionsRef:ref(new Set()),sendingSessionsRef:ref(new Set()),activeTurnIdsRef:ref({}),
  historyLoadingRequestsRef:ref(new Map()),setMessageHistoryLoading:(id,value)=>loading.set(id,value),
  requestContext:{contextWindowUsageAvailable:true},
  SessionReadFence,canApplySessionSnapshot,
  setMessagesByConversation:fn=>messageQueue.push(fn),setContextWindowUsageByConversation:fn=>usageQueue.push(fn),
  clearSessionAttention:()=>{},setProcessingConversationIds:()=>{},setRunningByConversation:()=>{},
  // Fence tests assert whether the existing merge boundary is called, not change its semantics.
  mergeLoadedMessagesPreservingLocalState:(_old,loaded)=>loaded,
  fetchSessionContextWindowUsage:sessionId=>new Promise((resolve,reject)=>requests.push({sessionId,resolve,reject})),
};
const context=vm.createContext(bindings);
vm.runInContext(compile(declarations+'\n'+names.map(n=>'exports.'+n+'='+n+';').join('\n')),context);
const api=bindings.exports;
const flush=()=>{
  while(messageQueue.length) messages=messageQueue.shift()(messages);
  while(usageQueue.length) usage=usageQueue.shift()(usage);
  bindings.messagesByConversationRef.current=messages;
};
const meter=(sessionId,turnId,usedTokens)=>({sessionId,turnId,usedTokens});
const finishOld=api.beginHistoryLoading('a'),finishNew=api.beginHistoryLoading('a');
finishOld();finishOld();assert.equal(loading.get('a'),true,'old cleanup cannot hide the new loading state');
finishNew();assert.equal(loading.get('a'),false,'last read releases loading, without a stuck spinner');

const oldRead=api.refreshMeasuredContextWindowUsage('a',{turnId:'t1'});
api.mergeContextWindowUsage('a',meter('a','t1',200000));
requests.shift().resolve(meter('a','t1',30000));
await oldRead;flush();
assert.equal(usage.a.usedTokens,200000,'late history cannot replace a live meter');
api.mergeContextWindowUsage('a',meter('a','t1',40000));flush();
assert.equal(usage.a.usedTokens,40000,'compaction is allowed to reduce tokens');

const first=api.refreshMeasuredContextWindowUsage('a',{turnId:'t1'});
assert.equal(api.refreshMeasuredContextWindowUsage('a',{turnId:'t1'}),first,'current reads are deduplicated');
const second=api.refreshMeasuredContextWindowUsage('a',{turnId:'t2'});
requests[1].resolve(meter('a','t2',80000));await second;
requests[0].resolve(meter('a','t1',170000));await first;requests.length=0;flush();
assert.equal(usage.a.turnId,'t2','older Turn cannot win a response race');

const invalidated=api.refreshMeasuredContextWindowUsage('a',{turnId:'t2'});
api.markSessionRunning('a','t3');
await api.refreshMeasuredContextWindowUsage('a',undefined);flush();
assert.equal(usage.a.turnId,'t2','empty pre-Turn history does not clear the meter');
requests.shift().resolve(meter('a','t2',999));await invalidated;flush();
assert.equal(usage.a.usedTokens,80000);
api.markSessionDone('a');
const reopened=api.refreshMeasuredContextWindowUsage('a',{turnId:'t3'});
requests.shift().resolve(meter('a','t3',10000));await reopened;flush();
assert.equal(usage.a.usedTokens,10000,'settled/reopened history remains loadable');
const foreign=api.refreshMeasuredContextWindowUsage('a',{turnId:'t3'});
requests.shift().resolve(meter('b','foreign',7));await foreign;flush();
assert.equal(usage.b,undefined,'foreign identity cannot write another session');

let read=api.beginHistoryRead('a');
const live=[...messages.a,{id:'live',role:'assistant',content:'streaming'}];
messageQueue.push(current=>({...current,a:live}));
api.applyHistoryRead(read,[{id:'stale'}]);flush();
assert.equal(messages.a,live,'queued live update is protected even before React commits a render');
read=api.beginHistoryRead('a');
api.markSessionRunning('a','t4');
api.applyHistoryRead(read,[{id:'stale'}]);flush();
assert.equal(messages.a,live,'starting a Turn invalidates earlier reads');
read=api.beginHistoryRead('a');
api.applyHistoryRead(read,[{id:'incomplete-history'}]);flush();
assert.equal(messages.a,live,'reads begun during a quiet live loop cannot erase it');
api.markSessionDone('a');
api.applyHistoryRead(read,[{id:'pre-commit-history'}]);flush();
assert.equal(messages.a,live,'clearing the live flag must not validate a pre-commit read');
read=api.beginHistoryRead('a');
const archived=[{id:'canonical',role:'assistant',content:'completed'}];
api.applyHistoryRead(read,archived);flush();
assert.equal(messages.a,archived,'terminal archival is still applied');

const stale=api.beginHistoryRead('a'), fresh=api.beginHistoryRead('a');
const replacement=[{id:'replacement-turn',role:'user'}];
api.applyHistoryRead(fresh,replacement);api.applyHistoryRead(stale,archived);flush();
assert.equal(messages.a,replacement,'edit/rerun replacement cannot be resurrected by older history');
read=api.beginHistoryRead('a');
messageQueue.push(current=>({...current,b:[{id:'unrelated'}]}));
api.applyHistoryRead(read,archived);flush();
assert.equal(messages.a,archived,'another session changing does not invalidate this read');
read=api.beginHistoryRead('a');
messageQueue.push(current=>{const next={...current};delete next.a;return next;});
api.applyHistoryRead(read,archived);flush();
assert.equal(messages.a,undefined,'a removed session is not revived');
read=api.beginHistoryRead('a');
bindings.historyReadsRef.current.invalidate('a');
api.applyHistoryRead(read,archived);flush();
assert.equal(messages.a,undefined,'deleting a not-yet-loaded session also invalidates its request');
console.log('Session read fences: delayed/order/compaction/live/terminal/replacement/isolation assertions passed.');
