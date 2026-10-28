/** A short local acknowledgement; no asset download, microphone or speech service. */
export async function playDictationCue() {
  let context: AudioContext | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    context = new AudioContext();
    // Some output devices never resume. Do not strand the recording button.
    const unavailable = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('Audio cue unavailable')), 700); });
    await Promise.race([context.resume(), unavailable]);
    const oscillator = context.createOscillator(), gain = context.createGain(), now = context.currentTime;
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(660, now);
    oscillator.frequency.exponentialRampToValueAtTime(880, now + .1);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(.055, now + .012);
    gain.gain.exponentialRampToValueAtTime(.001, now + .13);
    oscillator.connect(gain).connect(context.destination);
    await Promise.race([new Promise<void>(resolve => { oscillator.onended = () => resolve(); oscillator.start(now); oscillator.stop(now + .15); }), unavailable]);
  } catch { /* A missing output device must not prevent dictation. */ }
  finally { clearTimeout(timeout); void context?.close().catch(() => {}); }
}
