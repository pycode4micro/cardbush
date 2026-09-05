import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as protocolExports from '@cardbush/bush-protocol';
const require = createRequire(import.meta.url);
const children = [];
const fakeElectron = { utilityProcess: { fork() {
  const child = new EventEmitter();
  child.kill = () => {};
  child.postMessage = message => { child.lastMessage = message; };
  children.push(child);
  return child;
} } };
const compiled = ts.transpileModule(fs.readFileSync('electron/runtimeHostController.mts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('require','exports','module',compiled)(name => name === 'electron' ? fakeElectron : name === '@cardbush/bush-protocol' ? protocolExports : require(name), module.exports, module);
const { RuntimeUtilityProcessController } = module.exports;
const protocol = 'bush.runtime_ipc.v1';
const readyMessage = {protocol,type:'ready',capabilities:{
  protocol:'bush.runtime_capabilities.v1',hostId:'test',runtimeVersion:'test',
  eventProtocol:'bush.runtime_event.v1',supportedEvents:[],supportedCommands:[],features:[],
}};
const controller = new RuntimeUtilityProcessController({ modulePath: 'unused-test-fixture' });
const firstReady = controller.start();
children[0].emit('message', readyMessage);
await firstReady;
const stoppedCommand = controller.command({protocol,type:'command',operationId:'old',command:{kind:'test',payload:{}}});
await new Promise(resolve=>setImmediate(resolve));
const stoppedResult = assert.rejects(stoppedCommand, error=>error.fact?.code === 'runtime_host_stopped');
controller.stop();
await stoppedResult;
const nextReady = controller.start();
children[1].emit('message', readyMessage);
await nextReady;
const command = controller.command({protocol,type:'command',operationId:'new',command:{kind:'test',payload:{}}});
await new Promise(resolve=>setImmediate(resolve));
children[0].emit('error','crashed','old-process',{});
children[0].emit('message',{protocol,type:'command_response',operationId:'new',ok:true,result:'stale'});
children[0].emit('exit',1);
children[1].emit('message',{protocol,type:'command_response',operationId:'new',ok:true,result:'fresh'});
assert.equal((await command).result,'fresh','old process must not settle new-process commands');
await controller.start();
assert.equal(children.length,2,'late exit must not orphan the replacement process');
controller.stop();
children[1].emit('exit',0);
await controller.stopStream({protocol,type:'stop_stream',subscriptionId:'expired'});
assert.equal(children.length,2,'cleanup must never restart a stopped host');
console.log('Runtime host lifecycle: pending stop, stale message/error/exit and replacement identity passed.');

const {registerRuntimeHostIpc} = module.exports;
const handlers=new Map();
const ipc={handle:(key,fn)=>handlers.set(key,fn),removeHandler:key=>handlers.delete(key)};
const stopped=[],started=[];
let deliver, deferredStart;
const fakeController={
  command:()=>{throw new Error('no command may be submitted by subscription cleanup');},
  cancelOperation:()=>{throw new Error('subscription cleanup must never cancel an operation');},
  startStream:async message=>{started.push(message);if(deferredStart)await deferredStart;},
  stopStream:async message=>{stopped.push(message.subscriptionId);},
  onStreamFrame:listener=>{deliver=listener;return()=>{deliver=undefined;};},
};
const owner=new EventEmitter();owner.id=1;owner.isDestroyed=()=>false;
const other=new EventEmitter();other.id=2;other.isDestroyed=()=>false;
const makeFrame=()=>({isDestroyed:()=>false,detached:false,sent:[],send(_channel,value){this.sent.push(value);}});
const oldFrame=makeFrame(),newFrame=makeFrame();
const stopIpc=registerRuntimeHostIpc(ipc,fakeController,()=>true);
const start=(id,frame=oldFrame,sender=owner)=>handlers.get(protocolExports.RUNTIME_IPC_START_STREAM_CHANNEL)(
  {sender,senderFrame:frame},{protocol,type:'start_stream',subscriptionId:id,request:{sessionId:'s',turnId:'t'}},
);
const stop=(id,frame=oldFrame,sender=owner)=>handlers.get(protocolExports.RUNTIME_IPC_STOP_STREAM_CHANNEL)(
  {sender,senderFrame:frame},{protocol,type:'stop_stream',subscriptionId:id},
);
const emit=(id,kind='event')=>deliver({protocol,type:'stream_frame',subscriptionId:id,frame:{kind,event:{}}});
for(let i=0;i<12;i++)await start('old'+i);
assert.equal(owner.listenerCount('destroyed'),1,'subscriptions share owner lifecycle listeners');
await assert.rejects(start('old0',newFrame,other),/already in use/);
await assert.rejects(stop('old0',newFrame),/different renderer/);
assert.equal(stopped.length,0,'foreign cleanup cannot stop the legitimate subscription');
owner.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});
owner.emit('did-navigate');assert.equal(stopped.length,0,'same-document navigation stays connected');
owner.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});
emit('old0');assert.equal(oldFrame.sent.length,1,'attempted/cancelled navigation does not stop a live stream');
await start('fresh',newFrame);
owner.emit('did-navigate');
assert.equal(stopped.length,12,'committed navigation retires its captured old subscriptions');
assert.equal(stopped.includes('fresh'),false,'old document cleanup cannot stop a new subscription');
emit('fresh');assert.equal(newFrame.sent.length,1);
emit('old0');assert.equal(oldFrame.sent.length,1,'late old frames are not retargeted');
emit('fresh','end');
assert.equal(stopped.includes('fresh'),false,'natural end needs no worker cancellation');
assert.equal(owner.listenerCount('destroyed'),0,'last terminal stream releases owner listeners');

await start('detached',oldFrame);oldFrame.detached=true;emit('detached');oldFrame.detached=false;
assert.ok(stopped.includes('detached'));
const throwingFrame=makeFrame();throwingFrame.send=()=>{throw new Error('disposed');};
await start('send-failure',throwingFrame);emit('send-failure');assert.ok(stopped.includes('send-failure'));
await start('crashed');owner.emit('render-process-gone');assert.ok(stopped.includes('crashed'));
await start('destroyed');owner.emit('destroyed');assert.ok(stopped.includes('destroyed'));
let finishStart;
deferredStart=new Promise(resolve=>{finishStart=resolve;});
const pendingStart=start('pending');owner.emit('destroyed');
await assert.rejects(start('pending',newFrame),/already in use/);
finishStart();await pendingStart;deferredStart=undefined;
assert.ok(stopped.filter(id=>id==='pending').length>=2,'cleanup is repeated after a delayed start has installed the worker subscription');
await start('dispose');stopIpc();
assert.ok(stopped.includes('dispose'));assert.equal(handlers.size,0);assert.equal(owner.listenerCount('destroyed'),0);
console.log('Runtime subscriptions: ownership, navigation, detached frame, crash, startup race and disposal passed.');
