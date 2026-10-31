/** Shared desktop/device lifecycle: model hangup drains playback; manual Stop is immediate. */
export class RealtimeVoiceHangup {
  private output?: { responseId?: string; received: boolean; ended: boolean };
  private pending?: { acknowledged: boolean; heard: boolean; previousResponseId?: string };
  private playing = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private finish: (complete: boolean) => void) {}

  request(responseId?: string) {
    if (this.pending || this.closed) return;
    // An older reply says nothing about the farewell, even while it is still
    // playing. Without response IDs, wait for fresh output instead of guessing.
    const sameReply = !!responseId && responseId === this.output?.responseId;
    this.pending = { acknowledged: false, heard: sameReply && !!this.output?.received,
      previousResponseId: !sameReply ? this.output?.responseId : undefined };
  }

  acknowledge() {
    if (!this.pending || this.pending.acknowledged) return;
    this.pending.acknowledged = true;
    this.activity();
  }

  audioStart(responseId?: string) {
    this.output = { responseId, received: false, ended: false };
    if (this.pending) this.pending.heard = false;
    this.activity();
  }

  audio(responseId?: string) {
    if (!this.output || this.output.ended || responseId && responseId !== this.output.responseId) this.audioStart(responseId);
    this.output!.received = true;
    if (this.pending && (!responseId || responseId !== this.pending.previousResponseId)) this.pending.heard = true;
    this.activity();
  }

  audioEnd(responseId?: string) {
    if (!this.output || responseId && this.output.responseId && responseId !== this.output.responseId) return;
    this.output.ended = true;
    this.activity();
  }

  playback(playing: boolean) {
    this.playing = playing;
    this.activity();
  }

  resetOutput() {
    this.output = undefined;
    if (this.pending) this.pending.heard = false;
    this.activity();
  }

  cancel() {this.pending=undefined;this.resetOutput();}

  activity() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.pending?.acknowledged || this.playing) return;
    const complete = this.pending.heard && !!this.output?.ended;
    // Allow trailing captions and adjacent audio to settle after the queue drains.
    // The fallback measures inactivity, never total speech duration: buffered or
    // arriving audio must finish even if it takes longer than fifteen seconds.
    this.timer = setTimeout(() => {
      this.close();
      this.finish(complete);
    }, complete ? 300 : 15_000);
  }

  close() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
}
