import { uiText } from '../../i18n';
import type { RealtimeVoiceApi, RealtimeVoiceEvent, RealtimeToolCall, RealtimeToolResult } from '../../../electron/realtimeVoiceTypes';
import type { VoiceState, VoiceTarget } from './voiceSession';
import { RealtimeVoiceAudio } from './realtimeVoiceAudio';
import { RealtimeVoiceHangup } from './realtimeVoiceHangup';
import { RealtimeVoiceCaptions } from './realtimeVoiceCaptions';
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
  private captionTimes=new Map<string,string>();
  private suppressAudio=false;
  private outputId?:string;
  private outputActive=false;
  private outputAudioEnded=false;
  private playing=false;
  private inputId?:string;
  private cancelledOutputs=new Set<string>();
  private pendingCancels=0;
  private speechCaptions:RealtimeVoiceCaptions;
  private hangup:RealtimeVoiceHangup;
  private maintenance=new AbortController();
  constructor(private api:RealtimeVoiceApi, private patch:(state:Partial<VoiceState>)=>void, private submitting:(value:boolean)=>void,
    makeAudio=(...args:ConstructorParameters<typeof RealtimeVoiceAudio>)=>new RealtimeVoiceAudio(...args),
    private ended:()=>void=()=>this.close()) {
    this.speechCaptions=new RealtimeVoiceCaptions((id,text,final,status)=>{
      this.patch({spokenText:text});
      this.publishTranscript('assistant',id,text,final,status);
      if(final)this.audio.release?.(id);
    },id=>{void this.target?.agent?.discard?.(`${this.id}:assistant:${id}`).catch(()=>{});});
    this.hangup=new RealtimeVoiceHangup(complete=>{
      if (this.closed) return;
      this.finishCaptions('assistant',complete?'completed':'interrupted');
      this.diagnostic('model-hangup',complete?'playback-drained':'idle-timeout');
      this.ended();
    });
    this.bridge=new RealtimeAgentBridge(submitting, async result => {
      const language = this.target?.language ?? 'zh';
      if (!this.closed) await api.notify(this.id, JSON.stringify({ ...result, language }));
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
      this.playing=speaking;
      patch({speaking});
      if (this.started) void api.playback?.(this.id,speaking).catch(()=>{});
      this.hangup.playback(speaking);
    } },level=>{ if (!this.closed) patch({level}); },error=>this.fail(error.message),outputLevel=>{ if (!this.closed) patch({outputLevel}); },
      progress=>{if(!this.closed)this.speechCaptions.progress(progress);});
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
      if (event.type==='input-start' && !this.muted) {
        this.inputId=event.itemId;this.bargeIn();
        this.patch({inputPending:true,draftTranscript:''});
      }
      if (event.type==='connection-state') {
        const connected=event.state==='connected';
        this.transportPaused=event.state==='paused';
        if(!connected){this.stopOutput();this.finishCaptions('user');this.outputId=undefined;this.pendingCancels=0;this.suppressAudio=false;}
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
      if(event.type==='audio-start'&&!event.responseId&&((this.suppressAudio&&!this.pendingCancels)||this.outputAudioEnded)){
        this.outputId=undefined;this.suppressAudio=false;
      }
      if (event.type==='audio-start' && this.acceptOutput(event.responseId)) {this.outputAudioEnded=false;this.outputActive=true;this.hangup.audioStart(event.responseId);}
      if (event.type==='audio' && this.acceptOutput(event.responseId)) {
        this.outputActive=true;this.outputAudioEnded=false;
        this.hangup.audio(event.responseId);
        try { this.audio.append(event.pcm,event.sampleRate,this.outputId); }
        catch (error) { this.fail(error instanceof Error ? error.message : uiText()('realtimeVoiceCall.realtime_audio_playback_failed_start_the_call')); return; }
      }
      if (event.type==='audio-end' && (!event.responseId || event.responseId===this.outputId) && !this.suppressAudio) {
        this.outputActive=false;this.outputAudioEnded=true;this.speechCaptions.end(this.outputId??'legacy');this.hangup.audioEnd(event.responseId);
      }
      if (event.type==='interrupted') {
        // A cancellation ACK may arrive after the new answer has started. It
        // acknowledges our already-cleared output, not the new reply.
        if(this.pendingCancels&&(!event.responseId||this.cancelledOutputs.has(event.responseId))){this.pendingCancels--;}
        else if(!event.responseId || !this.cancelledOutputs.has(event.responseId)) {
          this.diagnostic('provider-interrupted');this.stopOutput();
        }
      }
      if (event.type==='input-discarded') {
        this.captions.delete('user:'+event.itemId);
        this.captionTimes.delete('user:'+event.itemId);
        void this.target?.agent?.discard?.(`${this.id}:user:${event.itemId}`).catch(()=>{});
        this.patch({inputPending:false,draftTranscript:'',transcript:''});
      }
      if (event.type==='transcript') {
        if (event.role==='assistant') {
          const id=event.responseId||(this.outputId?.startsWith('legacy-')?this.outputId:event.itemId)||this.outputId;
          if(!this.acceptOutput(id))return;
          this.hangup.activity();this.outputActive=!this.outputAudioEnded;
          this.speechCaptions.text(this.outputId!,event.text,event.final);return;
        }
        // Some compatible providers omit input-start. Recognized text is the
        // fallback; raw microphone amplitude alone never cancels speech.
        if(event.final && event.text.trim() && this.inputId!==event.itemId && !this.muted){this.inputId=event.itemId;this.bargeIn();}
        const key=event.role+':'+event.itemId;
        const text=event.final ? event.text || this.captions.get(key) || '' : (this.captions.get(key)??'')+event.text;
        this.captions.set(key,text.slice(-16000));
        if (this.captions.size>80) this.captions.delete(this.captions.keys().next().value!);
        this.patch({transcript:text.slice(-16000),draftTranscript:'',inputPending:!event.final});
        this.publishTranscript(event.role,event.itemId,text,event.final);
        if (event.final) {
          this.captions.delete(key);
        }
      }
      if (event.type==='tools') void this.runBatch(event.calls,event.responseId);
    } catch { this.fail(uiText()('realtimeVoiceCall.realtime_audio_processing_failed_start_the_call')); }
  }
  private publishTranscript(role:'user'|'assistant',id:string,text:string,final:boolean,status?:'completed'|'interrupted') {
    const key=role+':'+id,createdAt=this.captionTimes.get(key)??new Date().toISOString();this.captionTimes.set(key,createdAt);
    const entry={id:`${this.id}:${key}`,role,content:text.trim(),createdAt,source:'voice' as const,status,
      visibility:this.target?.assistant?'internal' as const:'conversation' as const};
    if(!final&&text.trim())void this.target?.agent?.preview?.(entry).catch(()=>{});
    if(final){this.captionTimes.delete(key);if(text.trim()&&this.target?.agent?.record){const record=this.target.agent.record.bind(this.target.agent);
      void record(entry).catch(()=>record(entry)).catch(()=>this.patch({agentError:uiText()('realtimeVoiceCall.could_not_save_the_call_transcript_keep')}));}}
  }
  private acceptOutput(id?:string) {
    if(id&&this.cancelledOutputs.has(id))return false;
    if(this.suppressAudio&&!id)return false;
    if(id){if(id!==this.outputId)this.outputAudioEnded=false;this.outputId=id;this.suppressAudio=false;}else this.outputId??=`legacy-${crypto.randomUUID()}`;
    return true;
  }
  private stopOutput() {
    for(const id of [...this.speechCaptions.ids(),...(this.outputId?[this.outputId]:[])])this.cancelledOutputs.add(id);
    while(this.cancelledOutputs.size>80)this.cancelledOutputs.delete(this.cancelledOutputs.values().next().value!);
    this.hangup.cancel();this.audio.stop();this.finishCaptions('assistant');this.outputActive=false;this.suppressAudio=true;
  }
  private bargeIn() {
    if(!this.outputActive&&!this.playing)return;
    this.diagnostic('user-interrupted');this.interrupt();
  }
  private async runBatch(calls:RealtimeToolCall[],responseId?:string) {
    try {
      let hangup=false;
      // Each call returns a receipt/snapshot, never the child's completion promise.
      const results:RealtimeToolResult[]=await Promise.all(calls.map(async call=>{
        if (call.name==='recall_conversation') {
          try {
            const args=JSON.parse(call.arguments);
            if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).some(key=>key!=='cursor') ||
              args.cursor!==undefined && (!Number.isSafeInteger(args.cursor) || args.cursor<0)) throw Error('Invalid history cursor.');
            return {id:call.id,output:JSON.stringify(await this.api.history(this.id,args.cursor))};
          } catch { return {id:call.id,output:JSON.stringify({status:'error',message:'Saved call history is unavailable.'})}; }
        }
        if (call.name==='hang_up') {
          let args: unknown;
          try { args=JSON.parse(call.arguments); } catch { /* Invalid calls receive a normal tool error. */ }
          if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).length)
            return { id:call.id, output:JSON.stringify({status:'error',message:'hang_up accepts an empty object.'}) };
          this.hangup.request(responseId); hangup=true;
          return {id:call.id,output:JSON.stringify({status:'ending',message:'The call will end after the goodbye finishes playing. Background tasks continue.'})};
        }
        return {id:call.id,output:await this.bridge.run(call)};
      }));
      if (!this.closed) {
        await this.api.results(this.id,results); this.bridge.acknowledge(calls);
        if (hangup) this.hangup.acknowledge();
      }
    } catch { this.fail(uiText()('realtimeVoiceCall.could_not_send_task_results_to_the')); }
  }
  private finishCaptions(role?:'assistant'|'user',status:'completed'|'interrupted'='interrupted') {
    if(!role||role==='assistant')this.speechCaptions.finish(status);
    for (const [key,content] of this.captions) {
      const entryRole=key.startsWith('user:') ? 'user' : 'assistant';
      if (role && entryRole!==role) continue;
      if (content.trim()) void this.target?.agent?.record?.({id:`${this.id}:${key}`,role:entryRole,content:content.trim(),
        createdAt:this.captionTimes.get(key) ?? new Date().toISOString(),source:'voice',status,
        visibility:this.target.assistant?'internal':'conversation'}).catch(()=>{});
      this.captions.delete(key); this.captionTimes.delete(key);
    }
  }
  mute(value:boolean) {
    this.muted=value; this.audio.mute(value || this.transportPaused);
    if (value) this.queuedFrames=[];
    if (this.started && !this.closed) void this.api.control(this.id,value?'mute':'unmute').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_update_the_realtime_microphone_state')));
  }
  setOutputMuted(value:boolean) { this.audio.setOutputMuted?.(value); }
  interrupt() { this.stopOutput(); if (this.started && !this.closed) {this.pendingCancels++;void this.api.control(this.id,'interrupt').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_interrupt_the_voice_reply')));} }
  commit() { if (this.started && !this.closed) void this.api.control(this.id,'commit').catch(()=>this.fail(uiText()('realtimeVoiceCall.could_not_submit_this_voice_turn'))); }
  async setVoice(voice:'female'|'male') { if (this.started && !this.closed) { this.interrupt(); await this.api.setVoice(this.id,voice); } }
  private fail(message:string) { if (this.closed) return; this.diagnostic('failed',message); this.close(); this.patch({phase:'idle',reconnecting:false,connectionNotice:'',error:message,speaking:false,muted:true,inputPending:false,level:0}); }
  close() { if (this.closed) return; this.diagnostic('closed'); this.closed=true; this.queuedFrames=[]; this.bridge.close();
    this.finishCaptions();
    this.hangup.close();
    this.maintenance.abort(); this.patch({contextNotice:''});
    this.audio.close(); this.unsubscribe?.(); void this.api.close(this.id).catch(()=>{}); this.submitting(false); }
}
