/** Conservative local activity gate, not speaker identification. ASR confirms interruptions. */
export class VoiceActivity {
  private noise = .004;
  private previous = 0;
  private candidateMs = 0;
  private lastVoiced = -Infinity;
  private started = false;
  reset() { this.previous = 0; this.candidateMs = 0; this.lastVoiced = -Infinity; this.started = false; }
  update(rms: number, spectrum: Float32Array, sampleRate: number, now: number) {
    let total = 0, band = 0, peak = 0;
    const binHz = sampleRate / (spectrum.length * 2);
    for (let i = 1; i < spectrum.length; i++) {
      const power = Number.isFinite(spectrum[i]) ? 10 ** (spectrum[i] / 10) : 0;
      total += power;
      if (i * binHz >= 120 && i * binHz <= 4000) { band += power; peak = Math.max(peak, power); }
    }
    let occupied = 0;
    for (let i = Math.ceil(120 / binHz); i < Math.min(spectrum.length, Math.floor(4000 / binHz) + 1); i++) {
      if (10 ** (spectrum[i] / 10) > peak * .03) occupied++;
    }
    // Suppress short taps, steady hum, narrow tones and broadband noise before ASR.
    const speechBand = total > 0 && band / total > .52 && occupied >= 5 && peak / band < .65;
    const threshold = Math.max(.012, this.noise * 2.4) * (this.started ? .7 : 1);
    const voiced = speechBand && rms > threshold;
    const step = this.previous ? Math.min(120, Math.max(0, now - this.previous)) : 0;
    this.previous = now;
    if (voiced) { this.candidateMs += step; this.lastVoiced = now; }
    else {
      if (now - this.lastVoiced > 150) this.candidateMs = 0;
      if (!this.started) this.noise = this.noise * .97 + Math.min(rms, .02) * .03;
    }
    const started = !this.started && this.candidateMs >= 240;
    if (started) this.started = true;
    return { started, voiced };
  }
}

/** A likely echo goes to review; it must not stop speech or create an Agent turn. */
export function isVoicePlaybackEcho(text: string, spoken: string[]) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const input = normalize(text);
  if (input.length < 6) return false;
  return spoken.some(value => {
    const reference = normalize(value);
    if (reference.includes(input)) return true;
    if (reference.length < 6 || Math.abs(reference.length - input.length) > Math.max(input.length, reference.length) * .2) return false;
    let row = Array.from({ length: reference.length + 1 }, (_, i) => i);
    for (let i = 1; i <= input.length; i++) {
      const next = [i];
      for (let j = 1; j <= reference.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (input[i - 1] === reference[j - 1] ? 0 : 1));
      row = next;
    }
    return row[reference.length] / Math.max(input.length, reference.length) <= .18;
  });
}
