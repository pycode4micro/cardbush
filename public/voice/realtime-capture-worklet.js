// A muted node stays clocked but never forwards microphone samples.
class CardBushRealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.frame = new Int16Array(320); this.offset = 0; this.enabled = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') {
        this.enabled = false;
        if (this.offset) {
          const tail = this.frame.slice(0, this.offset);
          this.port.postMessage(tail.buffer, [tail.buffer]);
        }
        this.offset = 0; this.port.postMessage('flushed');
        return;
      }
      this.enabled = data === true; this.offset = 0;
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!this.enabled || !samples) return true;
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      this.frame[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
      if (this.offset === 320) {
        this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
        this.frame = new Int16Array(320); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('cardbush-realtime-capture', CardBushRealtimeCapture);
