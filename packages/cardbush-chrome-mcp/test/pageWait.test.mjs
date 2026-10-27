import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForPage, waitSchema } from '../dist/pageWait.js';
import { createCardbushChromeServer } from '../dist/index.js';
import { ChromeConnectorError } from '../dist/bridgeClient.js';

test('one wait entry validates unambiguous bounded conditions and exact state types', () => {
  for (const input of [{}, {text:'x',conditions:[{kind:'text',text:'x'}]},
    {conditions:[]}, {conditions:[{kind:'state',uid:'cb_1',name:'haspopup',value:false}]},
    {conditions:[{kind:'url',value:'x',match:'regex'}]}, {timeout:30001,text:'x'}]) assert.equal(waitSchema.safeParse(input).success,false);
  assert.equal(waitSchema.parse({text:'x'}).timeout,10000);
  assert.equal(waitSchema.parse({conditions:[{kind:'text',text:'Loading',present:false}]}).conditions[0].present,false);
});

test('text absence and URL conditions use observed values without dispatching input', async () => {
  const calls=[];
  const command=async(name,params)=>{
    calls.push(name);assert.equal(name,'Runtime.evaluate');
    return {result:{value:params.expression==='location.href'?'https://test/result':false}};
  };
  const result=await waitForPage(command,waitSchema.parse({conditions:[{kind:'text',text:'Loading',present:false},{kind:'url',value:'/result',match:'includes'}]}));
  assert.equal(result.matched,true); assert.equal(calls.length,2);
});

test('timeout returns last evidence and transport failures keep their original cause', async () => {
  await assert.rejects(waitForPage(async()=>({result:{value:false}}),waitSchema.parse({text:'not ready',timeout:100})),
    error=>error.code==='wait_for_timeout' && error.details.observations[0].matched===false);
  const offline=new Error('connector disconnected');
  await assert.rejects(waitForPage(async()=>{throw offline},waitSchema.parse({text:'x'})),error=>error===offline);
});

test('aborting a wait stops polling without a page timer or observer left behind', async () => {
  const abort=new AbortController();let calls=0;
  const command=async()=>{calls++;abort.abort();return {result:{value:false}}};
  await assert.rejects(waitForPage(command,waitSchema.parse({text:'x'}),abort.signal),{name:'AbortError'});
  assert.equal(calls,1);
  const duringSuccess = new AbortController();
  await assert.rejects(waitForPage(async () => { duringSuccess.abort(); return {result:{value:true}}; }, waitSchema.parse({text:'x'}), duringSuccess.signal), {name:'AbortError'});
});

test('navigation during a targeted condition cannot turn a stale element into success', async () => {
  let frames=0;
  const command=async name=>{
    assert.equal(name,'Page.getFrameTree');frames++;
    return {frameTree:{frame:{id:'main',loaderId:frames===1?'first':'navigated'}}};
  };
  await assert.rejects(waitForPage(command,waitSchema.parse({conditions:[{kind:'visible',uid:'cb_1',value:false}]})),{code:'wait_document_changed'});
  assert.equal(frames,2);
});

test('a missing initial target is not proof of disappearance, and child-frame navigation invalidates uids', async () => {
  const frame={frameTree:{frame:{id:'main',loaderId:'one'}}};
  const command=async name=>{
    if(name==='Page.getFrameTree')return frame;
    assert.equal(name,'DOM.resolveNode');throw new Error('No node with given id found');
  };
  await assert.rejects(waitForPage(command,waitSchema.parse({conditions:[{kind:'visible',uid:'cb_999',value:false}]})),{code:'wait_target_missing'});
  let count=0;
  const navigated=async name=>{
    assert.equal(name,'Page.getFrameTree');
    return {frameTree:{frame:{id:'main',loaderId:'one'},childFrames:[{frame:{id:'child',loaderId:++count===1?'one':'two'}}]}};
  };
  await assert.rejects(waitForPage(navigated,waitSchema.parse({conditions:[{kind:'visible',uid:'cb_1',value:false}]})),{code:'wait_document_changed'});
});

test('public wait propagates its remaining budget into CDP requests and keeps last evidence on connector timeout', async () => {
  const budgets=[];
  const server=createCardbushChromeServer({connector:async(method,params,options)=>{
    if(method==='tabs.list')return [{id:42,active:true}];
    assert.equal(method,'debugger.command');budgets.push(options.timeoutMs);
    if(budgets.length===1)return {result:{value:false}};
    throw new ChromeConnectorError('browser_connector_timeout','Delayed response', { stage: 'command_pending' });
  }});
  const context={mcpReq:{signal:new AbortController().signal,_meta:{cardbush_session_id:'bounded-wait'}}};
  try {
    const result=await server._registeredTools.wait_for.handler({text:'ready',timeout:200},context);
    assert.equal(result.structuredContent.error.code,'wait_for_timeout');
    assert.equal(result.structuredContent.error.details.observations[0].matched,false);
    assert.equal(result.structuredContent.error.details.lastRequestError.details.stage, 'command_pending');
    assert.ok(budgets[0]<=200 && budgets[1]<budgets[0]);
  } finally {await server.close();}
});

test('an elapsed deadline never sends another polling request, including within a condition batch', async () => {
  let calls = 0;
  const input = waitSchema.parse({ conditions: [{kind:'text', text:'ready'}, {kind:'url', value:'result', match:'includes'}], timeout:100 });
  await assert.rejects(waitForPage(async () => { calls++; }, input, undefined, Date.now() - 1), {code:'wait_for_timeout'});
  assert.equal(calls, 0);
  await assert.rejects(waitForPage(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 110));
    return {result:{value:false}};
  }, input), error => error.code === 'wait_for_timeout' && error.details.observations[0].matched === false);
  assert.equal(calls, 1, 'the second condition must not start after the shared deadline');
});

test('waits preserve permission, offline and cancellation errors instead of relabelling them as timeouts', async () => {
  for (const code of ['site_permission_required', 'browser_unavailable']) {
    const error = new ChromeConnectorError(code, 'Original cause');
    await assert.rejects(waitForPage(async () => { throw error; }, waitSchema.parse({text:'ready'})), value => value === error);
  }
  const abort = new AbortController();
  await assert.rejects(waitForPage(async () => {
    abort.abort(); throw new ChromeConnectorError('browser_connector_timeout', 'Delayed abort');
  }, waitSchema.parse({text:'ready'}), abort.signal), {name:'AbortError'});
});
