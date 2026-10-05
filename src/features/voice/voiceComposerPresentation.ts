import type { VoiceSession } from './voiceSession';

/** UI presentation only; changing it never starts, stops or retargets audio. */
class VoiceComposerPresentation {
  private listeners = new Set<() => void>();
  private owners = new Set<symbol>();
  private state = { callId: 0, text: false, docked: false, details: 0, settings: 0, right: 28, bottom: 28 };
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<typeof this.state>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  begin(callId: number) { if (callId !== this.state.callId) this.patch({ callId, text: false }); }
  setText(text: boolean) { if (text !== this.state.text) this.patch({ text }); }
  showDetails() { this.patch({ details: this.state.details + 1 }); }
  showSettings() { this.patch({ settings: this.state.settings + 1 }); }
  origin(button: HTMLElement) {
    const surface = button.closest('.composer-surface'); if (!surface) return;
    const container = surface.getBoundingClientRect(), rect = button.getBoundingClientRect();
    this.patch({ right: container.right - rect.left - rect.width / 2, bottom: container.bottom - rect.top - rect.height / 2 });
  }
  attach() {
    const owner = Symbol(); this.owners.add(owner);
    if (!this.state.docked) this.patch({ docked: true });
    return () => { this.owners.delete(owner); if (!this.owners.size && this.state.docked) this.patch({ docked: false }); };
  }
}
const presentations = new WeakMap<VoiceSession, VoiceComposerPresentation>();
export function voiceComposerPresentation(session: VoiceSession) {
  let result = presentations.get(session);
  if (!result) { result = new VoiceComposerPresentation(); presentations.set(session, result); }
  return result;
}
export const emptyVoiceComposerPresentation = new VoiceComposerPresentation();
