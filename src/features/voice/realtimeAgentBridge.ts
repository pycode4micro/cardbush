import type { VoiceTarget } from './voiceSession';
import type { RealtimeConversationExecutor } from '@cardbush/bush-runtime/realtime-conversation';
export { RealtimeAgentBridge } from '@cardbush/bush-runtime/realtime-conversation';
export interface RealtimeAgentExecutor extends RealtimeConversationExecutor { pin?(target: VoiceTarget): Promise<VoiceTarget> }

export function realtimeConversationContext(target?: VoiceTarget) {
  const pairs: {role:'user'|'assistant';text:string}[][]=[];
  let question='';
  for (const message of target?.historyMessages ?? target?.messages ?? []) {
    // Realtime transcripts already live in the encrypted voice journal. Import
    // only text-chat pairs, otherwise every reconnect appends the speech twice.
    if (message.metadata?.voice_transcript) { question=''; continue; }
    if (message.metadata?.visibility==='internal' || message.metadata?.__bush_superseded) continue;
    if (message.role==='user') question=message.content.trim();
    if (question && message.role==='assistant' && message.content.trim() && message.metadata?.cardbush_terminal_snapshot && message.status==='completed') {
      pairs.push([{role:'user',text:question.slice(0,4000)},{role:'assistant',text:message.content.slice(0,4000)}]); question='';
    }
  }
  let chars=0; const selected: typeof pairs=[];
  for (const pair of pairs.reverse().slice(0,20)) { const size=JSON.stringify(pair).length; if (chars+size>22000) break; chars+=size; selected.unshift(pair); }
  return selected.flat();
}
