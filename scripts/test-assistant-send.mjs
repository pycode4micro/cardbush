import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'vite';

const mocks = {
  '../../backend/api': 'export const createConversation=async()=>({});',
  '../../backend/conversationJournal': 'export const readConversationJournal=async()=>fixture.read();export const conversationJournalCommand=async payload=>fixture.command(payload);export const journalMessages=()=>[];',
  '../../backend/runtimeChat': 'export const prepareRuntimeAgentRequest=async config=>{fixture.prepared++;return {runtimeRequest:{sessionId:config.sessionId,metadata:{}}};};',
  '../../backend/realtimeAgent': 'export const createRealtimeAgentExecutor=()=>({});',
  '../../runtime-client/ElectronRuntimeSession': 'export const createDesktopRuntimeSession=()=>({dispose(){}});',
  './assistantProfile': 'export const readAssistantProfile=()=>({name:"assistant",targetAgent:""});',
};
const result = await build({configFile:false,logLevel:'silent',plugins:[{name:'assistant-send-fixture',enforce:'pre',
  resolveId(id,importer){if(importer?.replaceAll('\\','/').endsWith('/assistantBackend.ts')&&id in mocks)return '\0fixture:'+id;},
  load(id){if(id.startsWith('\0fixture:'))return mocks[id.slice('\0fixture:'.length)];},
}],build:{write:false,minify:false,lib:{entry:'src/features/assistant/assistantBackend.ts',formats:['es']}}});
const output=(Array.isArray(result)?result[0]:result).output.find(item=>item.type==='chunk').code;
const {assistantBackend}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));

test('assistant admission uses the visible input identity and reconciles lost acknowledgements without resending', async()=>{
  const originalWindow=globalThis.window,originalFixture=globalThis.fixture;
  const entries=[{id:'quoted-source',role:'assistant',content:'The original answer',source:'page',visibility:'conversation'}],commands=[];
  globalThis.window={cardbushDesktop:{},dispatchEvent(){}};
  globalThis.fixture={prepared:0,read:()=>({generation:0,entries}),command:payload=>{
    commands.push(payload);entries.push(payload.entry);throw Error('acknowledgement lost');
  }};
  try {
    const identity={id:'input-fixed',createdAt:'2026-10-30T07:06:00.000Z',replyTo:{messageId:'quoted-source',excerpt:'original answer'}};
    const text={text:'@C:/My Files/note.txt\n请查看',context:[{kind:'editing-location',content:'source selection'}]};
    const config={model:'fixture',standardImageInputEnabled:false};
    await assert.rejects(assistantBackend.send(text,config,false,assistantBackend.contextVersion(),identity),/acknowledgement lost/);
    assert.equal(commands.length,1);assert.equal(commands[0].entry.id,identity.id);assert.equal(commands[0].entry.createdAt,identity.createdAt);
    assert.equal(commands[0].entry.content,'请查看');assert.equal(commands[0].entry.attachments[0].path,'C:/My Files/note.txt');
    assert.deepEqual(commands[0].entry.promptContext,text.context);
    assert.deepEqual(commands[0].entry.replyTo,identity.replyTo,'the visible quote reaches the runtime with the same message identity');
    await assistantBackend.send(text,config,false,assistantBackend.contextVersion(),identity);
    assert.equal(commands.length,1,'an already saved input does not start a second turn');assert.equal(fixture.prepared,1);
    fixture.command=payload=>{commands.push(payload);if(payload.action==='reset')entries.length=0;};
    const version=assistantBackend.contextVersion();await assistantBackend.reset();
    await assert.rejects(assistantBackend.send(text,config,false,version,identity),/reset/i);
    assert.equal(commands.filter(item=>item.action==='turn').length,1,'reset rejects a delayed old input');
  } finally {globalThis.window=originalWindow;globalThis.fixture=originalFixture;}
});
