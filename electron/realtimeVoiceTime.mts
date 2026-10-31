import { createTurnTimeContext } from '@cardbush/bush-product-agent';

/** A speech-start snapshot, using the same clock facts as submitted text turns. */
export class RealtimeVoiceTime {
  context: string;
  private inputs = new Set<string>();
  private activeInput = false;
  private activeId = '';
  constructor(private timeZone?: unknown) { this.context = this.snapshot(); }

  private snapshot() {
    return createTurnTimeContext({ createdAt: new Date().toISOString(), timeZone: this.timeZone });
  }

  reconnect() {
    // Item IDs belong to one connection; retain the latest utterance's clock.
    this.inputs.clear(); this.activeInput = false; this.activeId = '';
  }

  observe(event: Record<string, unknown>): boolean {
    const type = event.type;
    const started = type === 'input_audio_buffer.speech_started' || type === 'conversation.item.input_audio_transcription.started';
    const delta = type === 'conversation.item.input_audio_transcription.delta';
    const completed = type === 'conversation.item.input_audio_transcription.completed';
    const id = typeof event.item_id === 'string' && event.item_id || typeof event.response_id === 'string' && event.response_id || '';
    if (type === 'conversation.item.input_audio_transcription.failed') {
      if (!id || id === this.activeId) this.activeInput = false;
      return false;
    }
    if (!started && !delta && !completed) return false;
    // Some compatible services omit the start event. Use their first nonempty
    // transcript, never an empty ASR completion, as the fallback input boundary.
    if (!started && ![event.transcript, event.text, event.delta].some(value => typeof value === 'string' && value.trim())) {
      if (completed && (!id || id === this.activeId)) this.activeInput = false;
      return false;
    }
    if (id && this.inputs.has(id)) {
      if (completed && id === this.activeId) this.activeInput = false;
      return false;
    }
    const fresh = !this.activeInput || Boolean(id && this.activeId && id !== this.activeId);
    if (id) {
      this.inputs.add(id);
      if (this.inputs.size > 256) this.inputs.delete(this.inputs.values().next().value!);
    }
    if (fresh) { this.context = this.snapshot(); this.activeId = id; }
    else if (id) this.activeId = id;
    this.activeInput = !completed;
    return fresh;
  }
}
