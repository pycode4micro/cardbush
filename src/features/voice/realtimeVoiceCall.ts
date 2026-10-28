import { uiText } from '../../i18n';
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
      activity: running ? uiText()('realtimeVoiceCall.running_value1_tasks_in_the_background', { value1: running }) : '' }); }, 1500,
      agentError => { if (!this.closed) patch({ agentError }); });
    this.audio=makeAudio(pcm=>{
      if (this.closed || !this.started || this.muted || this.transportPaused) return;
      // Renderer / IPC scheduling can deliver a burst of 20 ms frames after a short stall.
      // Preserve their order, with at most five seconds of capture and four IPCs in flight.
      if (this.queuedFrames.length+this.pendingFrames>=250) { this.fail(uiText()('realtimeVoiceCall.audio_uploads_have_been_delayed_for_over')); return; }
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
      void this.api.audio(this.id,pcm).catch(()=>this.fail(uiText()('realtimeVoiceCall.realtime_audio_upload_failed_start_the_call')))
        .finally(()=>{this.pendingFrames--;this.upload();});
    }
  }
  private diagnostic(event:string,reason?:string) {
    // Operational metadata only: never log PCM, transcripts, prompts or credentials.
    if (typeof window==='undefined') return;
    try {
      void window.cardbushDesktop?.writeDebugLog?.('realtime-voice',{
        event,callId:this.id,sessionId:this.ownerSessionId||this.target?.sessionId,reason,pendingFrames:this.pendingFrames,queuedFrames:this.queuedFrames.length,
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
    if (this.target?.environment!=='local') throw Error(uiText()('realtimeVoiceCall.start_realtime_calls_in_a_local_agent'));
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
      if (event.type==='closed') { this.fail(uiText()('realtimeVoiceCall.the_realtime_voice_connection_ended_start_the')); return; }
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
        })().catch(()=>{if (!this.closed) this.patch({contextNotice:uiText()('realtimeVoiceCall.call_memory_consolidation_is_incomplete_the_original')});});
      }
      if (event.type==='audio' && !this.suppressAudio) {
        try { this.audio.append(event.pcm,event.sampleRate); }
        catch (error) { this.fail(error instanceof Error ? error.message : uiText()('realtimeVoiceCall.realtime_audio_playback_failed_start_the_call')); return; }
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
            void record(entry).catch(() => record(entry)).catch(() => this.patch({ agentError: uiText()('realtimeVoiceCall.could_not_save_the_call_transcript_keep') }));
          }
        }
      }
      if (event.type==='tools') void this.runBatch(event.calls);
    } catch { this.fail(uiText()('realtimeVoiceCall.realtime_audio_processing_failed_start_the_call')); }
  }
  private async runBatch(calls:RealtimeToolCall[]) {
    try {
      // Each call returns a receipt/snapshot, never the child's completion promise.
      const results:RealtimeToolResult[]=await Promise.all(calls.map(async call=>{
        return {id:call.id,output:await this.bridge.run(call)};
      }));
      if (!this.closed) { await this.api.results(this.id,results); this.bridge.acknowledge(calls); }
    } catch { this.fail(uiText()('realtimeVoiceCall.could_not_send_task_results_to_the')); }
  }
  mute(value:boolean) {
    this.muted=value; this.audio.mute(value || this.transportPaused);
    if (value) this.queuedFrames=[];
    if (this.started && !this.closed) void this.api.control(this.id,value?'mute':'unmute').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_update_the_realtime_microphone_state')));
  }
  setOutputMuted(value:boolean) { this.audio.setOutputMuted?.(value); }
  interrupt() { this.audio.stop(); this.suppressAudio=true; if (this.started && !this.closed) void this.api.control(this.id,'interrupt').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_interrupt_the_voice_reply'))); }
  commit() { if (this.started && !this.closed) void this.api.control(this.id,'commit').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_submit_this_voice_turn'))); }
  async setVoice(voice:'female'|'male') { if (this.started && !this.closed) { this.interrupt(); await this.api.setVoice(this.id,voice); } }
  private fail(message:string) { if (this.closed) return; this.diagnostic('failed',message); this.close(); this.patch({phase:'idle',reconnecting:false,connectionNotice:'',error:message,speaking:false,muted:true,inputPending:false,level:0}); }
  close() { if (this.closed) return; this.diagnostic('closed'); this.closed=true; this.queuedFrames=[]; this.bridge.close();
    this.maintenance.abort(); this.patch({contextNotice:''});
    this.audio.close(); this.unsubscribe?.(); void this.api.close(this.id).catch(()=>{}); this.submitting(false); }
}
