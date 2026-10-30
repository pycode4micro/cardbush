export interface VoicePlaybackProgress { id: string; played: number; received: number; pending: boolean }
type Caption = { text:string; shown:string; final:boolean; audioEnded:boolean; played:number; received:number; pending:boolean; saved:boolean };

/** Seeduplex has no word timestamps. Reveal a conservative text prefix using the
 * actual audio clock, then the measured utterance duration once synthesis ends. */
export class RealtimeVoiceCaptions {
  private replies=new Map<string,Caption>();
  constructor(private emit:(id:string,text:string,final:boolean,status?:'completed'|'interrupted')=>void,
    private discard:(id:string)=>void=()=>{}) {}
  private get(id:string) {
    let reply=this.replies.get(id);
    if(!reply){reply={text:'',shown:'',final:false,audioEnded:false,played:0,received:0,pending:false,saved:false};this.replies.set(id,reply);}
    // Completed records already belong to the conversation journal.
    if(this.replies.size>80){const [key,value]=this.replies.entries().next().value!;
      if(!value.saved&&value.shown.trim())this.emit(key,value.shown,true,'interrupted');this.replies.delete(key);}
    return reply;
  }
  text(id:string,text:string,final:boolean) {
    const reply=this.get(id);reply.text=(final?text||reply.text:reply.text+text).slice(0,16000);reply.final=final;
    this.render(id,reply);
  }
  progress(progress:VoicePlaybackProgress) {
    const reply=this.get(progress.id);Object.assign(reply,{played:progress.played,received:progress.received,pending:progress.pending});
    this.render(progress.id,reply);
  }
  end(id:string) {const reply=this.get(id);reply.audioEnded=true;this.render(id,reply);}
  ids(){return [...this.replies].filter(([,reply])=>!reply.saved).map(([id])=>id);}
  private render(id:string,reply:Caption) {
    if(reply.saved || !reply.text || reply.played<=0 || reply.received<=0)return;
    const points=Array.from(reply.text);
    const weights=points.map(point=>/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(point)?1:/[\p{L}\p{N}]/u.test(point)?.3:/\s/u.test(point)?.1:.5);
    const units=weights.reduce((sum,value)=>sum+value,0);
    const complete=reply.audioEnded&&!reply.pending&&reply.played>=reply.received-.01;
    const duration=reply.audioEnded?reply.received:Math.max(reply.received,units/5);
    const budget=units*Math.min(1,reply.played/Math.max(.01,duration));
    let count=0,used=0;
    while(count<points.length&&used+weights[count]<=budget){used+=weights[count++];}
    if(!complete)count=Math.min(count,Math.max(0,points.length-1));
    const shown=complete?reply.text:points.slice(0,Math.max(count,Array.from(reply.shown).length)).join('');
    if(shown!==reply.shown){reply.shown=shown;this.emit(id,shown,false);}
    if(complete&&reply.final){reply.saved=true;this.emit(id,reply.text,true,'completed');}
  }
  finish(status:'completed'|'interrupted'='interrupted') {
    for(const [id,reply] of this.replies)if(!reply.saved) {
      if(reply.shown.trim())this.emit(id,reply.shown,true,status);
      else this.discard(id);
    }
    this.replies.clear();
  }
}
