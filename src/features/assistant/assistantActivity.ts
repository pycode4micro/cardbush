import { useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_SESSION, type AssistantWorkActivity, type AssistantReplyExpression } from '@cardbush/bush-protocol';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import type { VoiceState } from '../voice/voiceSession';
import type { AssistantCallPhase } from '../../../electron/assistantSurface';

export type AssistantActivity = AssistantWorkActivity | AssistantCallPhase;
let work: AssistantWorkActivity = 'idle';
let expression: AssistantReplyExpression | undefined;
let activeTool: string | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let capsuleCall: AssistantCallPhase | null = null;
let stopCapsuleCall: (() => void) | undefined;
const listeners = new Set<() => void>();
export function setAssistantActivity(next: AssistantWorkActivity, cue?: AssistantReplyExpression, toolName?: string) {
  if (cue && cue.expiresAt <= Date.now()) cue = undefined;
  if (work === next && cue?.replyId === expression?.replyId && toolName === activeTool) return;
  work = next;
  activeTool = toolName;
  if (cue?.replyId !== expression?.replyId) {
    clearTimeout(expiry);
    expression = cue;
    if (cue) expiry = setTimeout(() => setAssistantActivity(work, undefined, activeTool), cue.expiresAt - Date.now());
  }
  for (const notify of listeners) notify();
}
export function useAssistantExpression() {
  return useSyncExternalStore(subscribe, () => expression);
}
export function useAssistantTool() {
  return useSyncExternalStore(subscribe, () => activeTool);
}
function subscribe(notify: () => void) {
  listeners.add(notify);
  if (listeners.size === 1) stopCapsuleCall = window.cardbushDesktop?.onCapsuleCallPhase?.(phase => {
    if (capsuleCall === phase) return;
    capsuleCall = phase;
    for (const listener of listeners) listener();
  });
  return () => {
    listeners.delete(notify);
    if (!listeners.size) { stopCapsuleCall?.(); capsuleCall = null; }
  };
}
export function assistantVoiceActivity(state: VoiceState): AssistantCallPhase | null {
  return state.assistant && state.sessionId === PERSONAL_ASSISTANT_SESSION ? voiceCallActivity(state) : null;
}
export function voiceCallActivity(state: VoiceState): AssistantCallPhase | null {
  if (state.mode !== 'call') return null;
  if (state.error || state.agentError) return 'error';
  if (state.reconnecting || state.phase === 'connecting') return 'connecting';
  if (state.speaking && !state.outputMuted) return 'speaking';
  return state.muted ? 'muted' : 'listening';
}
export function useAssistantWorkActivity(): AssistantWorkActivity {
  return useSyncExternalStore(subscribe, () => work);
}
export function useAssistantActivity(): AssistantActivity {
  const voice = applicationVoiceSession();
  const call = useSyncExternalStore(voice.subscribe, () => assistantVoiceActivity(voice.snapshot()));
  const phase = useSyncExternalStore(subscribe, () => capsuleCall ?? work);
  return call ?? phase;
}
