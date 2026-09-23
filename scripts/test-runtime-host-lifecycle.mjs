import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as protocolExports from '@cardbush/bush-protocol';
const require = createRequire(import.meta.url);
const children = [];
const fakeElectron = { utilityProcess: { fork(_modulePath, _args, options) {
  assert.ok(Object.values(options.env).every(value => typeof value === 'string'), 'Electron requires string env values');
  const child = new EventEmitter();
  child.env = options.env;
  child.kill = () => {};
  child.postMessage = message => { child.lastMessage = message; };
  children.push(child);
  return child;
} } };
const compiled = ts.transpileModule(fs.readFileSync('electron/runtimeHostController.mts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const bridge = { exports: {} };
new Function('require', 'exports', 'module', ts.transpileModule(fs.readFileSync('electron/mcpHostBridge.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, bridge.exports, bridge);
const hostProcesses = { exports: {} };
new Function('require', 'exports', 'module', ts.transpileModule(fs.readFileSync('electron/hostProcesses.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, hostProcesses.exports, hostProcesses);
new Function('require','exports','module',compiled)(name => name === 'electron' ? fakeElectron : name === '@cardbush/bush-protocol' ? protocolExports : name === './mcpHostBridge.js' ? bridge.exports : name === './hostProcesses.js' ? hostProcesses.exports : require(name), module.exports, module);
const { RuntimeUtilityProcessController } = module.exports;
const protocol = 'bush.runtime_ipc.v1';
const readyMessage = {protocol,type:'ready',capabilities:{
  protocol:'bush.runtime_capabilities.v1',hostId:'test',runtimeVersion:'test',
  eventProtocol:'bush.runtime_event.v1',supportedEvents:[],supportedCommands:[],features:[],
}};
let readyNotifications = 0;
const env = { CARDBUSH_EXECUTION_SANDBOX: undefined, FUTURE_OPTION: undefined, EMPTY: '', POLICY: 'required' };
const controller = new RuntimeUtilityProcessController({ modulePath: 'unused-test-fixture', env, onReady: () => readyNotifications++ });
const firstReady = controller.start();
assert.deepEqual(children[0].env, { EMPTY: '', POLICY: 'required', CARDBUSH_RESOURCE_COORDINATION: 'desktop' });
assert.equal(Object.hasOwn(env, 'CARDBUSH_EXECUTION_SANDBOX'), true, 'the caller environment is not mutated');
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
children[0].emit('message', readyMessage);
assert.equal(readyNotifications, 2, 'a restarted worker notifies once; stale worker messages cannot restart automations');
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
await controller.cancelOperation({protocol,type:'cancel_operation',operationId:'expired'});
assert.equal(children.length,2,'cleanup must never restart a stopped host');
controller.dispose();
assert.equal((await controller.command({protocol,type:'command',operationId:'disposed',command:{kind:'test',payload:{}}})).error.code,'runtime_host_stopped');
assert.equal(children.length,2,'late initialization callbacks must not resurrect a disposed controller');
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
const registration=registerRuntimeHostIpc(ipc,fakeController,()=>true);
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
const pendingStart=start('pending');await new Promise(resolve=>setImmediate(resolve));owner.emit('destroyed');
await assert.rejects(start('pending',newFrame),/already in use/);
finishStart();await pendingStart;deferredStart=undefined;
assert.ok(stopped.filter(id=>id==='pending').length>=2,'cleanup is repeated after a delayed start has installed the worker subscription');
await start('dispose');registration.dispose();
assert.ok(stopped.includes('dispose'));assert.equal(handlers.size,0);assert.equal(owner.listenerCount('destroyed'),0);
console.log('Runtime subscriptions: ownership, navigation, detached frame, crash, startup race and disposal passed.');

// The real IPC router is installed before a host exists and stays installed
// through failures/retries. Control readiness independently of worker startup.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const makeOwner = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
const makeHost = () => ({
  commands: [], starts: [], stops: [], cancels: [], listeners: new Set(),
  async command(message) { this.commands.push(message.operationId); return { protocol, type: 'command_response', operationId: message.operationId, ok: true, result: message.operationId }; },
  async startStream(message) { this.starts.push(message.subscriptionId); },
  async stopStream(message) { this.stops.push(message.subscriptionId); },
  async cancelOperation(message) { this.cancels.push(message.operationId); },
  onStreamFrame(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
});
const bootHandlers = new Map();
const bootIpc = { handle(key, fn) { assert.equal(bootHandlers.has(key), false); bootHandlers.set(key, fn); }, removeHandler: key => bootHandlers.delete(key) };
let ready = deferred(), gets = 0;
const firstHost = makeHost(), secondHost = makeHost();
const bootRegistration = registerRuntimeHostIpc(bootIpc, () => { gets++; return ready.promise; }, sender => sender.id !== 999);
assert.equal(bootHandlers.size, 4, 'all channels are registered without a Runtime');
const originalHandlers = [...bootHandlers.values()];
const caller = { sender: makeOwner(3), senderFrame: makeFrame() };
const foreign = { sender: makeOwner(999), senderFrame: makeFrame() };
const dispatch = (id, event = caller) => bootHandlers.get(protocolExports.RUNTIME_IPC_COMMAND_CHANNEL)(event,
  { protocol, type: 'command', operationId: id, command: { kind: 'runtime.get_capabilities', payload: {} } });
const subscribe = (id, event = caller) => bootHandlers.get(protocolExports.RUNTIME_IPC_START_STREAM_CHANNEL)(event,
  { protocol, type: 'start_stream', subscriptionId: id, request: { sessionId: 'session', turnId: 'turn' } });
const cancel = (id, event = caller) => bootHandlers.get(protocolExports.RUNTIME_IPC_CANCEL_OPERATION_CHANNEL)(event,
  { protocol, type: 'cancel_operation', operationId: id });
const unsubscribe = id => bootHandlers.get(protocolExports.RUNTIME_IPC_STOP_STREAM_CHANNEL)(caller,
  { protocol, type: 'stop_stream', subscriptionId: id });
await assert.rejects(dispatch('foreign', foreign), /not allowed/);
assert.equal(gets, 0, 'unauthorized callers cannot start the host');
const early = Array.from({ length: 20 }, (_, i) => dispatch(`early-${i}`));
assert.equal((await dispatch('early-0')).error.code, 'duplicate_operation_id');
const cancelled = dispatch('cancel-before-ready');
assert.throws(() => cancel('cancel-before-ready', { sender: makeOwner(4), senderFrame: makeFrame() }), /different renderer/);
cancel('cancel-before-ready');
const quiet = subscribe('quiet'), cancelledStream = subscribe('cancelled-stream');
await unsubscribe('cancelled-stream');
assert.equal(firstHost.commands.length, 0); assert.equal(firstHost.starts.length, 0);
ready.resolve(firstHost);
assert.ok((await Promise.all(early)).every(response => response.ok));
assert.equal((await cancelled).error.code, 'runtime_operation_cancelled');
await Promise.all([quiet, cancelledStream]);
assert.deepEqual(firstHost.commands, Array.from({ length: 20 }, (_, i) => `early-${i}`));
assert.deepEqual(firstHost.starts, ['quiet']); assert.deepEqual(firstHost.cancels, []);
const oldDeliver = [...firstHost.listeners][0];
bootRegistration.reset(Error('fixture initialization failed'));
assert.equal(caller.senderFrame.sent.at(-1).frame.kind, 'error');
protocolExports.decodeRuntimeIpcOutboundMessage(caller.senderFrame.sent.at(-1));
assert.deepEqual(firstHost.stops, ['quiet']); assert.equal(firstHost.listeners.size, 0);
assert.deepEqual([...bootHandlers.values()], originalHandlers, 'reset never unregisters or replaces IPC handlers');
ready = deferred();
const failedRequest = dispatch('failed-boot');
ready.reject(Error('fixture worker refused to start'));
assert.match((await failedRequest).error.message, /fixture worker refused to start/);
ready = deferred();
const retried = dispatch('after-retry'); ready.resolve(secondHost);
assert.equal((await retried).ok, true); assert.deepEqual(secondHost.commands, ['after-retry']);
await subscribe('quiet');
const beforeOldFrame = caller.senderFrame.sent.length;
oldDeliver({ protocol, type: 'stream_frame', subscriptionId: 'quiet', frame: { kind: 'end' } });
assert.equal(caller.senderFrame.sent.length, beforeOldFrame, 'an old controller cannot deliver into a replacement subscription');
await unsubscribe('quiet');

ready = deferred();
const stale = dispatch('old-document');
caller.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
const nextCaller = { sender: caller.sender, senderFrame: makeFrame() };
const fresh = dispatch('new-document', nextCaller);
caller.sender.emit('did-navigate'); ready.resolve(secondHost);
assert.equal((await stale).ok, false); assert.equal((await fresh).ok, true);
assert.equal(secondHost.commands.includes('old-document'), false, 'queued work from a replaced document is never executed');
assert.equal(caller.sender.listenerCount('destroyed'), 0);

ready = deferred();
const destroyed = dispatch('closed-document'); caller.sender.emit('destroyed'); ready.resolve(secondHost);
assert.equal((await destroyed).ok, false); assert.equal(secondHost.commands.includes('closed-document'), false);
ready = deferred();
const disposed = dispatch('disposed-router'); bootRegistration.dispose(); ready.resolve(secondHost);
assert.equal((await disposed).ok, false); assert.equal(secondHost.commands.includes('disposed-router'), false);
assert.equal(bootHandlers.size, 0); assert.equal(caller.sender.listenerCount('destroyed'), 0);
console.log('Early IPC requests: readiness, validation, cancellation, failure/retry, stale controllers/documents and disposal passed.');
