import assert from 'node:assert/strict';
import test from 'node:test';
import { modelApiGateway, modelRequestHeaders, modelRequestSchema, modelEventSchema } from '@cardbush/bush-protocol';
import { modelReplayMessageHash } from '@cardbush/bush-runtime';
import { createModelProvider, OpenAIChatCompletionsProvider, toChatCompletionsParams } from '../dist/index.js';

const baseURL = 'https://openrouter.ai/api/v1';
const request = (extra = {}) => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r1', sessionId: 'parent', turnId: 't1',
  model: 'vendor/model', messages: [{ role: 'user', content: 'Check the file' }],
  tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }], ...extra });
const collect = async stream => { const result = []; for await (const event of stream) result.push(modelEventSchema.parse(event)); return result; };
const chunk = (delta = {}, finish_reason = null) => ({ id: 'c1', object: 'chat.completion.chunk', model: 'vendor/model', created: 1, choices: [{ index: 0, delta, finish_reason }] });
const sse = events => new Response(new ReadableStream({ start(controller) {
  const bytes = new TextEncoder().encode(events.map(e=>`${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n');
  for(let i=0;i<bytes.length;i+=17)controller.enqueue(bytes.slice(i,i+17));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const tool = { index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } };
const response = { id: 'resp-1', object: 'response', created_at: 1, model: 'vendor/model', status: 'completed', output: [], tools: [], store: false };

test('OpenRouter detection uses exact destination; session headers cannot be frozen by custom defaults', () => {
  const defaults = { 'X-Session-ID': 'old-session', 'X-Trace': '{{sessionId}}' };
  assert.equal(modelApiGateway('https://OPENROUTER.AI/api/v1'), 'openrouter');
  for (const url of ['https://openrouter.ai.evil.invalid/v1','https://example.com/openrouter.ai', 'https://openrouter.ai@example.com/v1', 'https://user@openrouter.ai/api/v1', 'file://openrouter.ai/v1']) {
    assert.equal(modelApiGateway(url), undefined);
    assert.equal(modelRequestHeaders(url, {}, 'parent')['x-session-id'], undefined);
  }
  for(const session of ['parent','child','other','parent']) {
    const headers=modelRequestHeaders(baseURL, defaults, session);
    assert.equal(headers['x-session-id'],session);assert.equal(headers['x-trace'],session);
    assert.equal(headers['x-openrouter-title'],'CardBush');assert.equal(headers['x-opencode-session'],undefined);
  }
  assert.equal(defaults['X-Session-ID'],'old-session');
  assert.equal(modelRequestHeaders(baseURL, {'X-Title':'My app'},'parent')['x-openrouter-title'],undefined);
  assert.equal(modelRequestHeaders(baseURL, {'X-OpenRouter-Title':'My app'},'parent')['x-openrouter-title'],'My app');
  assert.throws(()=>modelRequestHeaders(baseURL,{},'x'.repeat(257)));
  assert.equal(modelRequestHeaders('https://opencode.ai/zen/go/v1',{},'parent')['x-opencode-session'],'parent');
});

for(const [adapter,path,events] of [
  ['openai_chat_completions','/chat/completions',()=>[chunk({content:'OK'}),chunk({},'stop')]],
  ['openai_responses','/responses',()=>[{type:'response.created',response},{type:'response.completed',response}]],
  ['anthropic_messages','/messages',()=>[
    {type:'message_start',message:{id:'m1',role:'assistant',type:'message',content:[],model:'vendor/model',usage:{input_tokens:2,output_tokens:0}}},
    {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}, {type:'message_stop'},
  ]],
]) test(`${adapter}: OpenRouter auth and concurrent parent/child session isolation`, async()=>{
  const seen=[];
  const provider=createModelProvider({adapter,baseURL,apiKey:'fixture-secret',fetch:async(url,init)=>{
    seen.push({url:String(url),headers:new Headers(init.headers)});return sse(events());
  }});
  for(const sessionId of ['parent','parent','child']) assert.equal((await collect(provider.stream(request({sessionId})))).at(-1).kind,'response_completed');
  await Promise.all(['other','parent'].map(sessionId=>collect(provider.stream(request({sessionId})))));
  assert.deepEqual(seen.map(item=>item.headers.get('x-session-id')),['parent','parent','child','other','parent']);
  for(const item of seen) {
    assert.equal(item.url,baseURL+path);assert.equal(item.headers.get('authorization'),'Bearer fixture-secret');
    assert.equal(item.headers.get('x-api-key'),null);assert.equal(item.headers.get('x-openrouter-title'),'CardBush');
  }
});

test('OpenRouter Chat uses unified reasoning without changing the product three-level policy or other gateways',()=>{
  for(const effort of ['low','medium','high','max']) {
    const req=request({reasoningEffort:effort,maxOutputTokens:20000});
    const params=toChatCompletionsParams(req,baseURL);
    assert.deepEqual(params.reasoning,{effort:effort==='max'?'high':effort});assert.equal(params.reasoning_effort,undefined);
    assert.equal(params.max_completion_tokens,20000);
    assert.equal(toChatCompletionsParams(req,'https://opencode.ai/zen/go/v1').reasoning,undefined);
  }
  assert.equal(toChatCompletionsParams(request(),baseURL).reasoning,undefined);
});

test('reasoning details survive tool round trips verbatim without duplicate display or cross-binding replay',async()=>{
  const details=[{type:'reasoning.text',text:'检查',signature:null,id:'think',index:0,format:'anthropic-claude-v1'},
    {type:'reasoning.text',text:'文件',signature:'signature',id:'think',index:0,format:'anthropic-claude-v1'},
    {type:'reasoning.encrypted',data:'opaque',id:'opaque',index:1,format:'google-gemini-v1'}];
  const bodies=[],projections=[];
  const provider=new OpenAIChatCompletionsProvider({baseURL,apiKey:'fixture',fetch:async(_url,init)=>{
    bodies.push(JSON.parse(init.body));return sse([
      chunk({reasoning:'检查',reasoning_details:[details[0]]}),chunk({reasoning:'文件',reasoning_details:[details[1],details[2]]}),
      chunk({tool_calls:[tool]}),chunk({},'tool_calls'),
      {...chunk(),choices:[],usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:60}}},
    ]);
  }});
  const req=request({reasoningEffort:'high',providerBinding:{bindingId:'or',revision:'v1'}}),options={onInputProjection:p=>projections.push(p)};
  await provider.estimateInputTokens(req,options);
  const events=await collect(provider.stream(req,options));
  assert.equal(events.filter(e=>e.kind==='reasoning_delta').map(e=>e.delta).join(''),'检查文件');
  assert.deepEqual(events.at(-1).providerReplay.data.reasoning_details,details);
  assert.deepEqual(projections[0],projections[1]);
  assert.equal(events.findLast(e=>e.kind==='usage').cachedInputTokens,60);
  const assistant={role:'assistant',content:'',reasoningContent:'检查文件',toolCalls:[{id:'call-1',name:'read_file',argumentsText:'{"path":"a.txt"}'}]};
  assistant.providerReplay={...events.at(-1).providerReplay,model:req.model,providerBinding:req.providerBinding,messageHash:modelReplayMessageHash(assistant)};
  const follow=request({...req,messages:[...req.messages,assistant,{role:'tool',toolCallId:'call-1',content:'file content'}]});
  await collect(provider.stream(follow));
  assert.deepEqual(bodies[1].messages[1].reasoning_details,details);assert.equal(bodies[1].messages[2].tool_call_id,'call-1');
  assert.equal(bodies[1].messages[1].reasoning,undefined);
  for(const changed of [request({...follow,model:'other/model'}),request({...follow,providerBinding:{bindingId:'or',revision:'v2'}}),
    request({...follow,messages:follow.messages.map(m=>m.role==='assistant'?{...m,content:'changed'}:m)})]) {
    assert.equal(toChatCompletionsParams(changed,baseURL).messages[1].reasoning_details,undefined);
  }
  assert.equal(toChatCompletionsParams(follow).messages[1].reasoning_details,undefined);
  assert.ok(projections[1].parameterDigests.reasoning);
});

for(const [name,deltas,text] of [
  ['plain reasoning',[{reasoning:'分析'}],'分析'],
  ['legacy reasoning',[{reasoning_content:'分析'}],'分析'],
  ['details only',[{reasoning_details:[{type:'reasoning.summary',summary:'摘要',index:0},{type:'reasoning.text',text:'细节',index:1}]}],'摘要细节'],
  ['encrypted only',[{reasoning_details:[{type:'reasoning.encrypted',data:'secret-opaque',index:0}]}],''],
]) test(`${name}: display and replay`,async()=>{
  const provider=new OpenAIChatCompletionsProvider({baseURL,apiKey:'fixture',fetch:async()=>sse([...deltas.map(d=>chunk(d)),chunk({tool_calls:[tool]}),chunk({},'tool_calls')])});
  const events=await collect(provider.stream(request()));
  assert.equal(events.filter(e=>e.kind==='reasoning_delta').map(e=>e.delta).join(''),text);
  assert.ok(events.at(-1).providerReplay);
  assert.equal(events.at(-1).finishReason,'tool_calls');
});

for(const finish of ['length','missing','error','stream-error']) test(`OpenRouter ${finish} never executes incomplete tools or replays partial thinking`,async()=>{
  const events=[chunk({reasoning:'partial',reasoning_details:[{type:'reasoning.text',text:'partial',index:0}],tool_calls:[tool]})];
  if(finish==='stream-error')events.push({error:{code:429,message:'rate limited'}});
  else if(finish!=='missing')events.push(chunk({},finish));
  const provider=new OpenAIChatCompletionsProvider({baseURL,apiKey:'fixture',fetch:async()=>sse(events)});
  const result=await collect(provider.stream(request()));
  assert.equal(result.some(e=>e.kind==='tool_call_delta'),false);
  assert.equal(result.at(-1).providerReplay,undefined);
  if(finish==='length'){assert.equal(result.at(-1).finishReason,'length');assert.deepEqual(result.at(-1).completedToolCallIndices,[]);}
  else assert.equal(result.at(-1).kind,'response_failed');
});
