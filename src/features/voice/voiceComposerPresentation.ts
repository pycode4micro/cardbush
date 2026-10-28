import type { VoiceSession } from './voiceSession';

/** Only tracks whether a call has a visible composer. Audio lives in VoiceSession. */
class VoiceComposerPresentation {
  private listeners = new Set<() => void>();
  private owners = new Set<symbol>();
  snapshot = () => this.owners.size > 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  attach() {
    const owner = Symbol(); this.owners.add(owner); this.listeners.forEach(listener => listener());
    return () => { this.owners.delete(owner); this.listeners.forEach(listener => listener()); };
  }
}
const presentations = new WeakMap<VoiceSession, VoiceComposerPresentation>();
export function voiceComposerPresentation(session: VoiceSession) {
  let result = presentations.get(session);
  if (!result) { result = new VoiceComposerPresentation(); presentations.set(session, result); }
  return result;
}
export const emptyVoiceComposerPresentation = new VoiceComposerPresentation();
