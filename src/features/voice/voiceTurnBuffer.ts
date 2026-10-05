/** Recording chunks are transport units, not conversation turns. */
export interface VoiceTurnDraft { text: string }
export interface VoiceTurnClock {
  now(): number;
  later(callback: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}
export const voiceTurnClock: VoiceTurnClock = {
  now: () => Date.now(), later: (callback, ms) => setTimeout(callback, ms),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
export function isImmediateVoiceCommand(text: string) {
  return /^(?:停|停止|停一下|先停一下|等一下|暂停|停止播报|先别说话|stop|stopspeaking|pause)$/i.test(text.replace(/[\s。，！？.!?,]/g, ''));
}
export class VoiceTurnBuffer {
  private parts: { text: string; allowImmediate: boolean }[] = [];
  private pending = 0;
  private open = false;
  private paused = false;
  private forced = false;
  private lastSpeech = 0;
  private timer?: unknown;
  constructor(private waitMs: () => number, private ready: (draft: VoiceTurnDraft) => void,
    private changed: (waiting: boolean, text: string) => void, private clock: VoiceTurnClock = voiceTurnClock) {}
  private clearTimer() { if (this.timer !== undefined) this.clock.cancel(this.timer); this.timer = undefined; }
  /** Even an onset before VAD confirmation postpones a pending send, without interrupting playback. */
  activity(at = this.clock.now()) { this.lastSpeech = Math.max(this.lastSpeech, at); this.forced = false; this.schedule(); }
  speech() { this.open = true; this.activity(); this.publish(); }
  beginClip(lastSpeechAt = this.clock.now() - 1250) {
    this.open = false; this.pending++; this.lastSpeech = Math.max(this.lastSpeech, lastSpeechAt);
    this.clearTimer(); this.publish();
  }
  append(text: string, allowImmediate: boolean) { this.parts.push({ text: text.trim(), allowImmediate }); this.publish(); }
  finishClip() { this.pending = Math.max(0, this.pending - 1); this.schedule(); this.publish(); }
  discardCapture() { this.open = false; this.schedule(); this.publish(); }
  force() { this.forced = true; this.schedule(); }
  pause(value: boolean) {
    if (this.paused && !value) this.lastSpeech = this.clock.now();
    this.paused = value; this.schedule();
  }
  refresh() { this.schedule(); }
  private publish() { this.changed(this.open || this.pending > 0 || this.parts.length > 0, this.parts.map(part => part.text).join(' ')); }
  private schedule() {
    this.clearTimer();
    if (this.paused || this.open || this.pending || !this.parts.length) return;
    const quick = this.parts.length === 1 && this.parts[0].allowImmediate && isImmediateVoiceCommand(this.parts[0].text);
    const delay = this.forced || quick ? 0 : Math.max(0, this.waitMs() - (this.clock.now() - this.lastSpeech));
    this.timer = this.clock.later(() => {
      this.timer = undefined;
      const draft = { text: this.parts.map(part => part.text).join(' ') };
      this.parts = []; this.forced = false; this.publish(); this.ready(draft);
    }, delay);
  }
  reset() { this.clearTimer(); this.parts = []; this.pending = 0; this.open = false; this.paused = false; this.forced = false; this.lastSpeech = 0; this.publish(); }
}
