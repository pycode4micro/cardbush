import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, ProxyAgent, WebSocket, type Dispatcher } from 'undici';
import { type RealtimeVoiceSettings, type RealtimeVoiceSettingsInput, type RealtimeVoiceEvent, type RealtimeToolResult } from './realtimeVoiceTypes';
import { realtimeVoiceProviders as providers } from './realtimeVoiceRegistry';
import { realtimeVoiceCatalog } from './realtimeVoiceCatalog';
import { RealtimeVoiceConfiguration } from './realtimeVoiceConfiguration';
import type { RealtimeVoiceProvider } from './realtimeVoiceProvider';
import { realtimeVoiceNotification } from './realtimeVoiceNotification';
import { RealtimeVoiceHistory, type VoiceContextMessage } from './realtimeVoiceHistory';
import { RealtimeVoiceContext } from './realtimeVoiceContext';
import type { RealtimeContextResult } from './realtimeVoiceTypes';

export interface RealtimeSocket {
  readyState: number; bufferedAmount: number;
  send(data: string): void; close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export interface RealtimeConnection { socket: RealtimeSocket; dispose(): void }
interface Dependencies {
  encrypt(value: string): string;
  decrypt(value: string): string;
  connect(url: string, headers: Record<string, string>): Promise<RealtimeConnection>;
}
interface LiveCall {
  assistant?: { name: string; persona: string };
  id: string; owner: number; provider: RealtimeVoiceProvider;
  settings: RealtimeVoiceSettings; secret: string;
  emit(event: RealtimeVoiceEvent): void;
  connection?: RealtimeConnection; ready: boolean; closing: boolean;
  resolve(): void; reject(error: Error): void; timeout?: NodeJS.Timeout;
  batches: Map<string, Set<string>>; seen: Set<string>;
  inputSpeaking?: boolean; outputSpeaking?: boolean; notificationTimer?: NodeJS.Timeout;
  notifications: ReturnType<typeof realtimeVoiceNotification>[]; notified: Set<string>;
  muted?: boolean;
  voice: 'female' | 'male'; history?: RealtimeVoiceHistory; memory?: RealtimeVoiceContext;
  playback?: boolean; transitioning?: boolean; bufferedFrames: string[];
  userText?: string; userItemId?: string; assistantText?: string;
  partials: Map<string,string>;
  restoring?: { eventId:string; context:VoiceContextMessage[] };
  generation:number; retryCount:number; everReady?:boolean; retryTimer?:NodeJS.Timeout;
  recovery?:Promise<void>; recoveryDeadline?:number; capturePaused?:boolean;
  deferredContext:VoiceContextMessage[]; orphanedBatches:Set<string>;
  audioDrainTimer?:NodeJS.Timeout;
}
export async function connectRealtimeVoice(proxy: string, url: string, headers: Record<string, string>): Promise<RealtimeConnection> {
  const dispatcher: Dispatcher = proxy ? new ProxyAgent(proxy) : new Agent();
  try {
    const socket = new WebSocket(url, { headers, dispatcher });
    return { socket: socket as unknown as RealtimeSocket, dispose: () => { void dispatcher.destroy(); } };
  } catch (error) { void dispatcher.destroy(); throw error; }
}
/** One owner-bound call. No credentials, vendor event objects or arbitrary tools cross IPC. */
export class RealtimeVoiceService {
  private calls = new Map<number, LiveCall>();
  private configuration: RealtimeVoiceConfiguration;
  constructor(private file: string, private deps: Dependencies) { this.configuration = new RealtimeVoiceConfiguration(file, value => deps.encrypt(value)); }
  private read() { return this.configuration.current(); }
  settings() { return this.read().settings; }
  save(input: RealtimeVoiceSettingsInput) { return this.configuration.save(input); }
  async start(owner: number, input: { id: string; sessionId?: string; assistant?: { name: string; persona: string }; voice: 'female' | 'male'; context: {role:'user'|'assistant';text:string}[] }, emit: LiveCall['emit']) {
    if (!input || !/^[a-zA-Z0-9-]{1,100}$/.test(input.id) || !['male','female'].includes(input.voice)) throw Error('Invalid realtime call.');
    if (this.calls.has(owner)) throw Error('语音通话正在关闭，请稍后重试。');
    const saved = this.read();
    if (!saved.secret && realtimeVoiceCatalog[saved.settings.provider].apiKeyRequired) throw Error('请在语音设置中配置实时语音 API Key。');
    if (saved.settings.mode !== 'realtime') throw Error('请先选择实时语音通话模式。');
    if (!Array.isArray(input.context) || input.context.length > 40 || input.context.length % 2 || input.context.some((item,i) => !item || item.role !== (i%2 ? 'assistant':'user') || typeof item.text !== 'string' || item.text.length > 4000) || JSON.stringify(input.context).length > 24000) throw Error('Invalid voice context.');
    if (input.sessionId!==undefined && (typeof input.sessionId!=='string' || !input.sessionId || input.sessionId.length>200)) throw Error('Invalid voice conversation.');
    if (input.assistant && (input.sessionId !== 'personal-assistant' || typeof input.assistant.name !== 'string' || !input.assistant.name.trim() || input.assistant.name.length > 60 || typeof input.assistant.persona !== 'string' || input.assistant.persona.length > 2000)) throw Error('Invalid assistant profile.');
    let resolve!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>((yes,no) => { resolve = yes; reject = no; });
    // Attach immediately: cancellation may happen while the proxy is resolving.
    void started.catch(() => {});
    const call: LiveCall = { id: input.id, owner, settings: saved.settings, secret: saved.secret, provider: providers[saved.settings.provider], emit, ready: false, closing: false, resolve, reject, batches: new Map(), seen: new Set(), notifications: [], notified: new Set(), voice:input.voice, bufferedFrames:[], partials:new Map(), generation:0, retryCount:0, deferredContext:[], orphanedBatches:new Set() };
    call.assistant = input.assistant;
    {
      call.history=new RealtimeVoiceHistory(input.sessionId ? path.join(path.dirname(this.file),'voice-history') : undefined,input.sessionId ?? `voice-${call.id}`,this.deps);
      call.history.seed(input.context);
      call.memory=new RealtimeVoiceContext(call.history,Buffer.byteLength(JSON.stringify(call.provider.start(saved.settings,input.voice,call.assistant)))/2,{
        send:event=>this.send(call,event), create:items=>call.provider.context(items),
        request:job=>call.emit({id:call.id,type:'context-compact',job}),
        status:message=>{call.emit({id:call.id,type:'context-status',message});if (!message) this.scheduleNotification(call);},
        idle:()=>call.ready && !call.closing && !call.transitioning && !call.capturePaused && !call.inputSpeaking && !call.outputSpeaking && !call.playback && !call.batches.size,
        restart:()=>this.restart(call),
      });
    }
    this.calls.set(owner,call);
    call.timeout = setTimeout(() => this.fail(call, '通话记忆恢复暂未完成，历史仍已保留，请稍后重试。'), 90_000);
    // Do not make cancellation/timeout wait for a potentially slow system proxy lookup.
    void this.connect(call);
    return started;
  }
  private async connect(call:LiveCall) {
    const owner=call.owner, generation=++call.generation;
    const current=()=>this.calls.get(owner)===call && !call.closing && generation===call.generation;
    let context:VoiceContextMessage[];
    try {
      const sessionBytes=Buffer.byteLength(JSON.stringify(call.provider.start(call.settings,call.voice,call.assistant)));
      context=await call.memory!.prepareInitial(Math.max(3000,16000-sessionBytes));
    } catch { if(current())this.fail(call,'通话记忆暂未恢复，原始记录和后台任务已保留，请稍后重试。');return; }
    if (!current()) return;
    call.deferredContext=[];
    clearTimeout(call.timeout);
    call.timeout=setTimeout(()=>this.connectionLost(call,'实时语音连接或上下文确认超时。'),Math.max(1,Math.min(20_000,(call.recoveryDeadline??Date.now()+20_000)-Date.now())));
    try {
      const connection = await this.deps.connect(typeof call.provider.endpoint === 'function' ? call.provider.endpoint(call.settings) : call.provider.endpoint, call.provider.headers(call.secret ? this.deps.decrypt(call.secret) : ''));
      if (!current()) { connection.socket.close(); connection.dispose(); return; }
      call.connection = connection;
      connection.socket.addEventListener('open', () => {
        if(!current() || call.connection!==connection)return;
        try { this.send(call,call.provider.start(call.settings,call.voice,call.assistant)); }
        catch { this.connectionLost(call,'实时语音启动连接失败。'); }
      });
      connection.socket.addEventListener('message', event => {
        if (this.calls.get(owner)!==call || generation!==call.generation || call.connection!==connection) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 1_000_000) throw Error('Invalid event');
          const decoded = JSON.parse(event.data);
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw Error('Invalid event');
          const raw = call.provider.normalize?.(decoded) ?? decoded;
          if (call.restoring && raw.type==='conversation.item.added') {
            const matches=Array.isArray(raw.items) && call.restoring.context.every(message=>(raw.items as any[]).some((item:any)=>
              item?.id===message.id && item.role===message.role && Array.isArray(item.content) && item.content.every((part:any)=>typeof part?.text==='string') &&
              item.content.map((part:any)=>part.text).join('')===message.text));
            // Some providers assign a new event_id to the ACK. Full stable item
            // identity and content, scoped to this socket generation, prove restore.
            if(!matches){if(!raw.event_id || raw.event_id===call.restoring.eventId)throw Error('Restored memory was not acknowledged.');return;}
            call.restoring=undefined;this.restoreOrReady(call);return;
          }
          if (call.memory?.event(raw)) return;
          if (raw.type === 'conversation.item.input_audio_transcription.started' || raw.type === 'conversation.item.input_audio_transcription.delta') call.inputSpeaking = true;
          if (raw.type === 'conversation.item.input_audio_transcription.completed' || raw.type === 'conversation.item.input_audio_transcription.failed') call.inputSpeaking = false;
          if (raw.type === 'response.output_audio.started' || raw.type === 'response.output_text.delta') call.outputSpeaking = true;
          if (raw.type === 'response.done' || raw.type === 'response.canceled') {
            call.outputSpeaking = false;
            this.archive(call,raw.type==='response.canceled');
          }
          if (raw.type !== 'response.output_audio.delta') this.scheduleNotification(call);
          for (const parsed of call.provider.parse(raw)) {
            if (parsed.type === 'closed') { if(call.closing)this.finish(call);else this.connectionLost(call,'语音服务关闭了连接。'); return; }
            if (call.closing) continue;
            if (parsed.type === 'error') { this.fail(call, parsed.message); return; }
            if (parsed.type === 'ready') {
              if (call.ready || call.restoring) continue;
              // The provider requires mute keepalive while context ACKs are pending.
              this.send(call,call.provider.control('mute'));
              if (context.length) {
                const eventId=this.send(call,call.provider.context(context));
                call.restoring={eventId,context};continue;
              }
              this.restoreOrReady(call);
            }
            if (!call.ready) continue;
            if (parsed.type==='input-discarded') call.partials.delete('user:'+parsed.itemId);
            if (parsed.type==='transcript' && call.history) {
              const key=parsed.role+':'+parsed.itemId;
              const text=parsed.final ? parsed.text || call.partials.get(key) || '' : (call.partials.get(key)??'')+parsed.text;
              if (text.length>32000) throw Error('Voice transcript overflow');
              call.partials.set(key,text);
              if (call.partials.size>80) call.partials.delete(call.partials.keys().next().value!);
              if (parsed.role==='assistant') call.assistantText=text;
              if (parsed.final) {
                call.partials.delete(key);
                if (parsed.role==='user') {
                  if (call.userText && call.userItemId!==parsed.itemId) this.archive(call,true);
                  call.userText=text; call.userItemId=parsed.itemId;
                }
              }
            }
            if (parsed.type === 'tools') {
              const fresh = parsed.calls.filter(item => !call.seen.has(item.id));
              if (!fresh.length) continue;
              if (fresh.length !== parsed.calls.length || call.seen.size + fresh.length > 256 || call.batches.size >= 4) throw Error('Invalid tool replay');
              for (const item of fresh) call.seen.add(item.id);
              call.batches.set(fresh[0].id,new Set(fresh.map(item => item.id)));
            }
            call.emit({ ...parsed, ...(parsed.type==='transcript' || parsed.type==='input-discarded' ? {itemId:`${generation}:${parsed.itemId}`} : {}), id: call.id });
          }
          call.memory?.tick();
        } catch { this.fail(call,'实时语音协议异常，通话已停止。已启动的 Agent 任务会继续执行。'); }
      });
      connection.socket.addEventListener('error', () => { if (current() && call.connection===connection) this.connectionLost(call,'实时语音网络连接暂时不可用。'); });
      connection.socket.addEventListener('close', () => {
        if (call.connection!==connection) return;
        if (call.closing) this.finish(call);
        else if(current()) this.connectionLost(call,'实时语音网络连接已断开。');
      });
    } catch { if(current())this.connectionLost(call,'无法建立实时语音连接，请检查网络与配置。'); }
  }
  private restoreOrReady(call:LiveCall) {
    const context=call.deferredContext.splice(0);
    if(context.length){call.restoring={eventId:this.send(call,call.provider.context(context)),context};return;}
    this.ready(call);
  }
  private owned(owner: number,id: string,preparing=false) { const call=this.calls.get(owner); if (!call || call.id!==id || call.closing || !preparing && !call.ready && !call.transitioning) throw Error('语音通话已结束。'); return call; }
  private ready(call:LiveCall) {
    call.ready=true;call.everReady=true;clearTimeout(call.timeout);clearTimeout(call.retryTimer);call.resolve();call.recovery=undefined;call.retryCount=0;call.recoveryDeadline=undefined;
    call.transitioning=false;
    if(!call.muted)this.send(call,call.provider.control('unmute'));
    else call.bufferedFrames=[];
    const discarded=call.capturePaused;
    const finish=()=>{
      call.audioDrainTimer=undefined;call.capturePaused=false;
      call.emit({id:call.id,type:'connection-state',state:'connected',message:discarded?'已恢复原来的上下文，请重说断线期间那一句。':''});
      call.memory?.resumed();this.scheduleNotification(call);
    };
    if(!call.bufferedFrames.length){finish();return;}
    call.capturePaused=true;
    call.emit({id:call.id,type:'connection-state',state:'paused',message:'连接已恢复，正在接续刚才的录音，请稍等片刻。'});
    const drain=()=>{
      if(this.calls.get(call.owner)!==call || call.closing || call.transitioning)return;
      if(call.muted)call.bufferedFrames=[];
      const pcm=call.bufferedFrames.shift();
      if(!pcm){finish();return;}
      try{this.send(call,call.provider.audio(pcm));}catch{this.connectionLost(call,'接续录音时连接暂时不可用。');return;}
      call.audioDrainTimer=setTimeout(drain,20);
    };
    call.audioDrainTimer=setTimeout(drain,20);
  }
  private send(call: LiveCall, event: object) {
    const socket=call.connection?.socket;
    if (!socket || socket.readyState!==1 || socket.bufferedAmount>256_000) throw Error('Realtime transport unavailable.');
    const eventId=randomUUID();
    const message = { ...event, event_id: eventId };
    socket.send(JSON.stringify(call.provider.encode?.(message) ?? message));
    return eventId;
  }
  audio(owner:number,id:string,pcm:ArrayBuffer) {
    const call=this.owned(owner,id);
    if (!(pcm instanceof ArrayBuffer) || pcm.byteLength!==640) throw Error('Invalid PCM frame.');
    if (call.muted) return;
    if(call.capturePaused)return;
    if (call.transitioning) {
      if(call.capturePaused)return;
      if (call.bufferedFrames.length>=250) {
        call.bufferedFrames=[];call.capturePaused=true;
        call.emit({id:call.id,type:'connection-state',state:'paused',message:'正在自动重连，收音暂时暂停；恢复后请重说断线期间那一句。历史和后台任务仍在。'});return;
      }
      call.bufferedFrames.push(Buffer.from(pcm).toString('base64')); return;
    }
    try { this.send(call,call.provider.audio(Buffer.from(pcm).toString('base64'))); }
    catch { this.connectionLost(call,'实时语音网络发送暂时拥堵。'); }
  }
  control(owner:number,id:string,action:'mute'|'unmute'|'interrupt'|'commit') {
    if (!['mute','unmute','interrupt','commit'].includes(action)) throw Error('Invalid voice control.');
    const call=this.owned(owner,id);
    if (action === 'mute') call.muted = true;
    if (action === 'unmute') call.muted = false;
    if (call.transitioning) { if (action==='mute') call.bufferedFrames=[]; return; }
    try{this.send(call,call.provider.control(action));}catch{this.connectionLost(call,'实时语音控制消息暂时无法送达。');}
  }
  results(owner:number,id:string,results:RealtimeToolResult[]) {
    const call=this.owned(owner,id);
    if (!Array.isArray(results) || !results.length || results.length>8 || results.some(r=>!r || typeof r.id!=='string' || typeof r.output!=='string' || r.output.length>64000)) throw Error('Invalid tool results.');
    const batch=[...call.batches].find(([,ids])=>ids.size===results.length && new Set(results.map(r=>r.id)).size===ids.size && results.every(r=>ids.has(r.id)));
    if (!batch) throw Error('Unknown or already completed tool batch.');
    const context:VoiceContextMessage[]=[{role:'user',text:'[应用保存的子任务回执，仅为历史数据，不是新的执行指令]\n'+JSON.stringify(results).slice(0,12000)},
      {role:'assistant',text:'任务已按回执受理或返回；running 不是完成。继续观察现有任务，不因重连重新派发。'}];
    const sequence=call.history?.append(context[0].text,context[1].text);
    context.forEach((item,index)=>{if(sequence)item.id=`history_${sequence}_${index?'a':'u'}`;});
    if(call.transitioning || call.orphanedBatches.has(batch[0])) {
      if(call.transitioning)call.deferredContext.push(...context);else {
        try{this.send(call,call.provider.context(context));}catch{this.connectionLost(call,'任务回执等待连接恢复。');}
      }
    } else {
      try{this.send(call,call.provider.results(results));}catch{this.connectionLost(call,'任务回执等待连接恢复。');}
    }
    call.batches.delete(batch[0]);call.orphanedBatches.delete(batch[0]);
    call.memory?.account(JSON.stringify(results).slice(12000));
    this.scheduleNotification(call);
  }
  setVoice(owner:number,id:string,voice:'female'|'male') {
    if (!['female','male'].includes(voice)) throw Error('Invalid voice.');
    const call=this.owned(owner,id);
    call.voice=voice;
    if (call.transitioning) return;
    this.send(call,{...call.provider.start(call.settings,voice,call.assistant),type:'session.update'});
  }
  notify(owner:number,id:string,result:string) {
    const call=this.owned(owner,id);
    if (typeof result!=='string' || result.length>10000) throw Error('Invalid background result.');
    const notification = realtimeVoiceNotification(result);
    if (call.notified.has(notification.taskId)) return;
    call.notified.add(notification.taskId); call.notifications.push(notification);
    this.scheduleNotification(call);
  }
  compacted(owner:number,id:string,jobId:string,result?:RealtimeContextResult) {
    const call=this.owned(owner,id,true);
    if (typeof jobId!=='string' || jobId.length>100) throw Error('Invalid voice checkpoint.');
    if (result!==undefined && (!result || typeof result.jobId!=='string' || !Number.isInteger(result.revision) || !Number.isInteger(result.through) || typeof result.summary!=='string' || result.summary.length>6000)) throw Error('Invalid voice checkpoint result.');
    call.memory?.complete(jobId,result);
    this.scheduleNotification(call);
  }
  playback(owner:number,id:string,speaking:boolean) {
    if (typeof speaking!=='boolean') throw Error('Invalid playback state.');
    const call=this.owned(owner,id); call.playback=speaking;
    call.memory?.tick(); this.scheduleNotification(call);
  }
  private archive(call:LiveCall,interrupted=false) {
    if (!call.history) return;
    if (!call.userText) {call.assistantText=undefined;return;}
    if (!call.assistantText && !interrupted) return;
    const text=(call.assistantText || '')+(interrupted ? '\n[本轮已中断，未确认完整播报或完成任务]' : '');
    const sequence=call.history.append(call.userText,text);
    if (sequence) call.memory?.bind(sequence,call.userItemId??'');
    call.userText=undefined; call.userItemId=undefined; call.assistantText=undefined; call.partials.clear();
  }
  private restart(call:LiveCall):Promise<void> {
    if (this.calls.get(call.owner)!==call || call.closing || call.batches.size) return Promise.reject(Error('Call is not idle.'));
    return this.recover(call);
  }
  private connectionLost(call:LiveCall,message:string) {
    if(this.calls.get(call.owner)!==call || call.closing)return;
    if(!call.everReady){this.fail(call,message);return;}
    void this.recover(call).catch(()=>{});
  }
  private recover(call:LiveCall):Promise<void> {
    const old=call.connection;call.connection=undefined;call.generation++;
    clearTimeout(call.timeout);clearTimeout(call.retryTimer);clearTimeout(call.audioDrainTimer);clearTimeout(call.notificationTimer);
    old?.socket.close();old?.dispose();call.restoring=undefined;
    if(!call.recovery){
      this.archive(call,true);call.memory?.detach();call.bufferedFrames=[];call.capturePaused=false;
      call.recoveryDeadline=Date.now()+90_000;call.retryCount=0;
      call.recovery=new Promise<void>((resolve,reject)=>{call.resolve=resolve;call.reject=reject;});void call.recovery.catch(()=>{});
    }
    const pending=call.recovery;
    call.transitioning=true;call.ready=false;call.inputSpeaking=false;call.outputSpeaking=false;call.playback=false;
    for(const id of call.batches.keys())call.orphanedBatches.add(id);
    if(++call.retryCount>3 || Date.now()>=call.recoveryDeadline!){this.fail(call,'自动重连暂未成功，原来的上下文和后台任务已保留，请稍后重新接通。');return pending;}
    call.emit({id:call.id,type:'connection-state',state:call.capturePaused?'paused':'reconnecting',message:`正在自动重连（${call.retryCount}/3），恢复原来的上下文和后台任务。`});
    call.timeout=setTimeout(()=>this.fail(call,'恢复通话等待超时，原始上下文仍已保留，请稍后重试。'),Math.max(1,call.recoveryDeadline!-Date.now()));
    call.retryTimer=setTimeout(()=>{void this.connect(call);},call.retryCount===1?0:call.retryCount===2?1000:3000);
    return pending;
  }
  private scheduleNotification(call:LiveCall) {
    clearTimeout(call.notificationTimer);
    if (call.closing || !call.ready || call.capturePaused || call.inputSpeaking || call.outputSpeaking || call.playback || call.memory?.busy || call.batches.size || !call.notifications.length) return;
    call.notificationTimer=setTimeout(()=>{
      if (this.calls.get(call.owner)!==call || call.closing || !call.ready || call.capturePaused || call.inputSpeaking || call.outputSpeaking || call.playback || call.memory?.busy || call.batches.size) return;
      const notice=call.notifications.shift(); if (!notice) return;
      try {
        // Store full task data with its independently generated spoken summary.
        const sequence=call.history?.append(notice.context[0].text,notice.context[1].text);
        const context=notice.context.map((item,index)=>({...item,...(sequence ? {id:`history_${sequence}_${index ? 'a' : 'u'}`} : {})}));
        this.send(call,call.provider.context(context));
        if (sequence) call.memory?.bind(sequence,`history_${sequence}_u`);
        this.send(call,call.provider.speak(notice.speech)); call.outputSpeaking=true;
      } catch { this.connectionLost(call,'后台任务结果等待语音连接恢复。'); }
    },750);
  }
  close(owner:number,id?:string) {
    const call=this.calls.get(owner); if (!call || id && call.id!==id || call.closing) return;
    call.closing=true; clearTimeout(call.timeout); clearTimeout(call.retryTimer);clearTimeout(call.audioDrainTimer);clearTimeout(call.notificationTimer); call.reject(Error('语音通话已取消。'));
    call.memory?.close();
    if (!call.connection || call.connection.socket.readyState!==1) { this.finish(call); return; }
    try { this.send(call,call.provider.control('close')); } catch { this.finish(call); return; }
    call.timeout=setTimeout(()=>this.finish(call),1500);
  }
  closeAll() { for (const owner of this.calls.keys()) this.close(owner); }
  forgetHistory(sessionId?:string) {
    if (sessionId!==undefined && (typeof sessionId!=='string' || !sessionId || sessionId.length>200)) throw Error('Invalid voice conversation.');
    for (const call of this.calls.values()) if (sessionId===undefined || call.history?.sessionId===sessionId) this.finish(call);
    RealtimeVoiceHistory.forget(path.join(path.dirname(this.file),'voice-history'),sessionId);
  }
  private fail(call:LiveCall,message:string) {
    if (this.calls.get(call.owner)!==call) return;
    call.reject(Error(message)); if (!call.closing) call.emit({id:call.id,type:'error',message});
    this.finish(call);
  }
  private finish(call:LiveCall) {
    if (this.calls.get(call.owner)!==call) return;
    call.memory?.close();
    try { this.archive(call,true); } catch { call.emit({id:call.id,type:'context-status',message:'本次通话记录保存失败，请检查本地磁盘。'}); }
    clearTimeout(call.timeout);clearTimeout(call.retryTimer);clearTimeout(call.audioDrainTimer);clearTimeout(call.notificationTimer); this.calls.delete(call.owner);call.generation++; call.reject(Error('语音通话已结束。'));
    call.connection?.socket.close(); call.connection?.dispose(); call.emit({id:call.id,type:'closed'});
  }
}
