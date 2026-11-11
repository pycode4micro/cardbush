import { useSyncExternalStore } from 'react';
import { PERSONAL_ASSISTANT_SESSION, type AssistantWorkActivity } from '@cardbush/bush-protocol';
import { applicationVoiceSession } from '../voice/VoiceConversation';
import type { VoiceState } from '../voice/voiceSession';
import type { AssistantCallPhase } from '../../../electron/assistantSurface';

export type AssistantActivity = AssistantWorkActivity | AssistantCallPhase;
let work: AssistantWorkActivity = 'idle';
let capsuleCall: AssistantCallPhase | null = null;
let stopCapsuleCall: (() => void) | undefined;
const listeners = new Set<() => void>();
export function setAssistantActivity(next: AssistantWorkActivity) {
  if (work === next) return;
  work = next;
  for (const notify of listeners) notify();
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
