// A muted node stays clocked but never forwards microphone samples.
class CardBushRealtimeCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.frame = new Int16Array(320); this.offset = 0; this.enabled = false;
    this.clock = 0; this.position = 0; this.history = new Float32Array(64);
    // The hardware clock may be 44.1/48/96 kHz. A fractional, low-pass FIR
    // produces the protocol's 16 kHz PCM without forcing a device format.
    const cutoff = .45 * Math.min(1, 16000 / sampleRate);
    this.filters = Array.from({ length: 128 }, (_, phase) => {
      const coefficients = new Float64Array(64); let sum = 0;
      for (let tap = 0; tap < 64; tap++) {
        const x = tap - 31 - phase / 128;
        const sinc = Math.abs(x) < 1e-9 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        coefficients[tap] = sinc * (.5 - .5 * Math.cos(2 * Math.PI * tap / 63)); sum += coefficients[tap];
      }
      for (let tap = 0; tap < 64; tap++) coefficients[tap] /= sum;
      return coefficients;
    });
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
      // Repeated mute synchronization must not discard a partial audio frame.
      if (this.enabled === (data === true)) return;
      this.enabled = data === true; this.offset = 0;
      this.clock = 0; this.position = 0; this.history.fill(0);
    };
  }
  process(inputs) {
    const channels = inputs[0], samples = channels?.[0];
    if (!this.enabled || !samples) return true;
    for (let i = 0; i < samples.length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      sample /= channels.length;
      if (sampleRate === 16000) { this.append(sample); continue; }
      this.history[this.position] = sample;
      this.clock += 16000;
      while (this.clock >= sampleRate) {
        this.clock -= sampleRate;
        const coefficients = this.filters[Math.min(127, Math.floor(this.clock / 16000 * 128))];
        let converted = 0;
        for (let tap = 0; tap < 64; tap++) converted += this.history[(this.position - tap + 64) % 64] * coefficients[tap];
        this.append(converted);
      }
      this.position = (this.position + 1) % 64;
    }
    return true;
  }
  append(value) {
    const sample = Math.max(-1, Math.min(1, value));
    this.frame[this.offset++] = sample < 0 ? sample * 32768 : sample * 32767;
    if (this.offset === 320) {
      this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
      this.frame = new Int16Array(320); this.offset = 0;
    }
  }
}
registerProcessor('cardbush-realtime-capture', CardBushRealtimeCapture);
