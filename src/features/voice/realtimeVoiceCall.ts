import type { RealtimeVoiceApi, RealtimeVoiceEvent, RealtimeToolCall, RealtimeToolResult } from '../../../electron/realtimeVoiceTypes';
import type { VoiceState, VoiceTarget } from './voiceSession';
import { RealtimeVoiceAudio } from './realtimeVoiceAudio';
import { RealtimeAgentBridge, realtimeConversationContext } from './realtimeAgentBridge';

export class RealtimeVoiceCall {
  readonly id=crypto.randomUUID();
  private closed=false;
  private started=false;
  private muted=false;
  private transportPaused=false;
  private unsubscribe?:()=>void;
  private audio:RealtimeVoiceAudio;
  private bridge:RealtimeAgentBridge;
  private target?:VoiceTarget;
  private pendingFrames=0;
  private queuedFrames:ArrayBuffer[]=[];
  private captions=new Map<string,string>();
  private suppressAudio=false;
  private maintenance=new AbortController();
  constructor(private api:RealtimeVoiceApi, private patch:(state:Partial<VoiceState>)=>void, private submitting:(value:boolean)=>void,
    makeAudio=(...args:ConstructorParameters<typeof RealtimeVoiceAudio>)=>new RealtimeVoiceAudio(...args)) {
    this.bridge=new RealtimeAgentBridge(submitting, async result => {
      const language = this.target?.language ?? 'zh';
      let speech: string | undefined;
      try { speech = await this.target?.agent?.summarize?.(String(result.taskId), language, this.maintenance.signal); }
      catch { /* Keep the call live; the notifier has an honest status-only fallback. */ }
      if (!this.closed) await api.notify(this.id, JSON.stringify({ ...result, speech, language }));
    }, running => { if (!this.closed) patch({ agentWorking: running > 0, agentWaiting: false,
      activity: running ? `后台执行 ${running} 个任务` : '' }); }, 1500,
      agentError => { if (!this.closed) patch({ agentError }); });
    this.audio=makeAudio(pcm=>{
      if (this.closed || !this.started || this.muted || this.transportPaused) return;
      // Renderer / IPC scheduling can deliver a burst of 20 ms frames after a short stall.
      // Preserve their order, with at most five seconds of capture and four IPCs in flight.
      if (this.queuedFrames.length+this.pendingFrames>=250) { this.fail('音频上传持续积压超过 5 秒，通话已暂停，请检查网络。'); return; }
      this.queuedFrames.push(pcm); this.upload();
    }, speaking=>{ if (!this.closed) {
      patch({speaking});
      if (this.started) void api.playback?.(this.id,speaking).catch(()=>{});
    } },level=>{ if (!this.closed) patch({level}); },error=>this.fail(error.message));
  }
  private upload() {
    while (!this.closed && !this.muted && this.pendingFrames<4 && this.queuedFrames.length) {
      const pcm=this.queuedFrames.shift()!;
      this.pendingFrames++;
      void this.api.audio(this.id,pcm).catch(()=>this.fail('实时语音上传失败，请重新开始通话。'))
        .finally(()=>{this.pendingFrames--;this.upload();});
    }
  }
  private diagnostic(event:string,reason?:string) {
    // Operational metadata only: never log PCM, transcripts, prompts or credentials.
    if (typeof window==='undefined') return;
    try {
      void window.cardbushDesktop?.writeDebugLog?.('realtime-voice',{
        event,callId:this.id,reason,pendingFrames:this.pendingFrames,queuedFrames:this.queuedFrames.length,
      }).catch(()=>{});
    } catch { /* Logging must not affect the audio lifecycle. */ }
  }
  private ownerSessionId?: string;
  update(target:VoiceTarget) {
    if (this.ownerSessionId && target.sessionId !== this.ownerSessionId) return;
    this.target = this.ownerSessionId ? { ...target, agent: this.target?.agent } : target;
    this.bridge.update(this.target);
  }
  async start(microphoneId:string,voice:'female'|'male') {
    if (this.target?.environment!=='local') throw Error('请在本地 Agent 会话中开始实时通话。');
    this.unsubscribe=this.api.onEvent(event=>{ if (event.id===this.id && !this.closed) this.event(event); });
    await this.audio.prepare(microphoneId);
    if (this.closed) return;
    let sessionId=this.target?.sessionId;
    if (this.target?.agent?.prepareConversation) {
      this.submitting(true);
      try {sessionId=await this.target.agent.prepareConversation();} finally {this.submitting(false);}
    }
    if (this.closed) return;
    this.ownerSessionId = sessionId || undefined;
    await this.api.start({id:this.id,sessionId:sessionId||undefined,voice,context:realtimeConversationContext(this.target), assistant:this.target?.assistant});
    if (this.closed) return;
    this.started=true; this.audio.mute(this.muted); this.diagnostic('connected');
    if (this.muted) await this.api.control(this.id,'mute');
    if (!this.closed) this.patch({phase:'listening',realtime:true,speakerLocked:false,muted:this.muted});
  }
  private event(event:RealtimeVoiceEvent) {
    try {
      if (event.type==='error') { this.fail(event.message); return; }
      if (event.type==='closed') { this.fail('实时语音连接已结束，请重新开始通话。'); return; }
      if (event.type==='context-status') this.patch({contextNotice:event.message});
      if (event.type==='connection-state') {
        const connected=event.state==='connected';
        this.transportPaused=event.state==='paused';
        if(!connected){this.audio.stop();this.captions.clear();this.suppressAudio=false;}
        if(this.transportPaused)this.queuedFrames=[];
        this.audio.mute(this.muted || this.transportPaused);
        this.diagnostic(connected?'reconnected':'reconnecting');
        this.patch({reconnecting:!connected,connectionNotice:event.message,phase:connected?'listening':'connecting',speaking:false,inputPending:false,draftTranscript:'',level:0});
      }
      if (event.type==='context-compact') {
        const agent=this.target?.agent;
        void (async()=>{
          let result;
          try {result=await agent?.compact?.(event.job,this.maintenance.signal);} catch { /* Originals remain authoritative. */ }
          if (!this.closed) await this.api.compacted(this.id,event.job.jobId,result);
        })().catch(()=>{if (!this.closed) this.patch({contextNotice:'通话记忆整理暂未完成，原始记录已保留。'});});
      }
      if (event.type==='audio' && !this.suppressAudio) {
        try { this.audio.append(event.pcm,event.sampleRate); }
        catch (error) { this.fail(error instanceof Error ? error.message : '实时音频播放失败，请重新开始通话。'); return; }
      }
      if (event.type==='audio-end') this.suppressAudio=false;
      if (event.type==='interrupted') { this.diagnostic('provider-interrupted'); this.audio.stop(); this.suppressAudio=false; }
      if (event.type==='input-discarded') {
        this.captions.delete('user:'+event.itemId);
        this.patch({inputPending:false,draftTranscript:'',transcript:''});
      }
      if (event.type==='transcript') {
        const key=event.role+':'+event.itemId;
        const text=event.final ? event.text || this.captions.get(key) || '' : (this.captions.get(key)??'')+event.text;
        this.captions.set(key,text.slice(-16000));
        if (this.captions.size>80) this.captions.delete(this.captions.keys().next().value!);
        this.patch(event.role==='user' ? {transcript:text.slice(-16000),draftTranscript:'',inputPending:!event.final} : {spokenText:text.slice(-16000)});
        if (event.final) {
          this.captions.delete(key);
          if (text.trim() && this.target?.agent?.record) {
            const record = this.target.agent.record.bind(this.target.agent);
            const entry = { id: `${this.id}:${key}`, role: event.role, content: text.trim(), createdAt: new Date().toISOString(), source: 'voice' as const,
              visibility: this.target.assistant ? 'internal' as const : 'conversation' as const };
            // Persistence belongs to the call's captured target, even after navigation or hangup.
            void record(entry).catch(() => record(entry)).catch(() => this.patch({ agentError: '通话转写保存失败，请保留当前文字并检查存储。' }));
          }
        }
      }
      if (event.type==='tools') void this.runBatch(event.calls);
    } catch { this.fail('实时音频处理失败，请重新开始通话。'); }
  }
  private async runBatch(calls:RealtimeToolCall[]) {
    try {
      // Each call returns a receipt/snapshot, never the child's completion promise.
      const results:RealtimeToolResult[]=await Promise.all(calls.map(async call=>{
        return {id:call.id,output:await this.bridge.run(call)};
      }));
      if (!this.closed) { await this.api.results(this.id,results); this.bridge.acknowledge(calls); }
    } catch { this.fail('任务结果无法回传到语音服务，结果仍保留在会话中。'); }
  }
  mute(value:boolean) {
    this.muted=value; this.audio.mute(value || this.transportPaused);
    if (value) this.queuedFrames=[];
    if (this.started && !this.closed) void this.api.control(this.id,value?'mute':'unmute').catch(()=>this.fail('无法更新实时麦克风状态。'));
  }
  setOutputMuted(value:boolean) { this.audio.setOutputMuted?.(value); }
  interrupt() { this.audio.stop(); this.suppressAudio=true; if (this.started && !this.closed) void this.api.control(this.id,'interrupt').catch(()=>this.fail('无法打断语音回复。')); }
  commit() { if (this.started && !this.closed) void this.api.control(this.id,'commit').catch(()=>this.fail('无法提交本轮语音。')); }
  async setVoice(voice:'female'|'male') { if (this.started && !this.closed) { this.interrupt(); await this.api.setVoice(this.id,voice); } }
  private fail(message:string) { if (this.closed) return; this.diagnostic('failed',message); this.close(); this.patch({phase:'idle',reconnecting:false,connectionNotice:'',error:message,speaking:false,muted:true,inputPending:false,level:0}); }
  close() { if (this.closed) return; this.diagnostic('closed'); this.closed=true; this.queuedFrames=[]; this.bridge.close();
    this.maintenance.abort(); this.patch({contextNotice:''});
    this.audio.close(); this.unsubscribe?.(); void this.api.close(this.id).catch(()=>{}); this.submitting(false); }
}
