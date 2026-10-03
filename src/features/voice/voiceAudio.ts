import type { VoiceDesktopApi } from '../../../electron/voiceTypes';
import { VoiceActivity } from './voiceActivity';

export class VoicePlayback {
  private context?: AudioContext;
  private sources = new Set<AudioBufferSourceNode>();
  private current?: { id: string; cancel(): void };
  private cursor = 0;
  private tail: number | undefined;
  private epoch = 0;
  constructor(private api: VoiceDesktopApi) {}
  async prepare() { this.context ??= new AudioContext({ sampleRate: 24_000 }); await this.context.resume(); }
  async speak(text: string, voice?: 'male' | 'female') {
    const epoch = this.epoch;
    await this.prepare();
    if (epoch !== this.epoch) return;
    const context = this.context!, id = crypto.randomUUID(); let cancelled = false;
    let finish!: () => void;
    const ended = new Promise<void>(resolve => { finish = resolve; });
    let last: AudioBufferSourceNode | undefined;
    this.cursor = context.currentTime; this.tail = undefined;
    this.current = { id, cancel: () => { cancelled = true; finish(); } };
    const unsubscribe = this.api.onAudio(chunk => {
      if (chunk.id !== id || cancelled) return;
      const raw = atob(chunk.pcm), bytes = new Uint8Array(raw.length + (this.tail === undefined ? 0 : 1));
      let start = 0; if (this.tail !== undefined) bytes[start++] = this.tail;
      for (let i = 0; i < raw.length; i++) bytes[start + i] = raw.charCodeAt(i);
      const length = Math.floor(bytes.length / 2); this.tail = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
      if (!length) return;
      const buffer = context.createBuffer(1, length, chunk.sampleRate), samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
      this.cursor = Math.max(this.cursor, context.currentTime + .025); source.start(this.cursor); this.cursor += buffer.duration; last = source;
    });
    try {
      await this.api.speak({ id, text, voice });
      if (cancelled || !last || this.cursor <= context.currentTime) finish();
      else { const source = last; const onended = source.onended; source.onended = event => { onended?.call(source, event); finish(); }; }
      await ended;
    } catch (error) { if (this.current?.id === id) this.stop(); throw error; }
    finally { unsubscribe(); if (this.current?.id === id) this.current = undefined; }
  }
  stop() {
    this.epoch++;
    if (this.current) { void this.api.cancel(this.current.id).catch(() => {}); this.current.cancel(); this.current = undefined; }
    for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); } this.sources.clear();
  }
  close() { this.stop(); const context = this.context; this.context = undefined; void context?.close().catch(() => {}); }
}

export interface VoiceClipTiming { lastSpeechAt: number; reason: 'silence' | 'limit' | 'manual' }
interface CaptureCallbacks {
  level(value: number): void; speech(): void; activity?(at: number): void; discarded?(): void;
  clip(blob: Blob, timing?: VoiceClipTiming): void; error(message: string): void;
}
/** Local VAD segments a continuous call and discards silence; microphone constraints request echo cancellation. */
export class VoiceCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private recorder?: MediaRecorder;
  private timer?: number;
  private closed = false;
  private muted = false;
  private chunks: Blob[] = [];
  private rotating = false;
  private started = 0;
  private speaking = false;
  private activity = new VoiceActivity();
  private lastSpeech = 0;
  private lastSpeechAt = 0;
  constructor(private mode: 'recording' | 'call', private callbacks: CaptureCallbacks, private microphoneId = '') {}
  async start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('当前环境不支持录音。');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(this.microphoneId ? { deviceId: { exact: this.microphoneId } } : {}) } }); }
    catch (error) {
      if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw Error('所选麦克风不可用，请在语音设置中重新选择。');
      throw error;
    }
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (!this.closed) this.callbacks.error('麦克风已断开，请重新连接后开始录音。'); }));
    this.context = new AudioContext(); await this.context.resume();
    if (this.closed) return;
    const analyser = this.context.createAnalyser(); analyser.fftSize = 2048;
    this.context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const spectrum = new Float32Array(analyser.frequencyBinCount);
    this.begin();
    this.timer = window.setInterval(() => {
      if (this.closed || this.muted || !this.recorder || this.recorder.state !== 'recording') return;
      analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
      this.callbacks.level(Math.min(1, rms * 10));
      const now = performance.now();
      analyser.getFloatFrequencyData(spectrum);
      const activity = this.activity.update(rms, spectrum, this.context!.sampleRate, now);
      if (activity.voiced) { this.lastSpeech = now; this.lastSpeechAt = Date.now(); this.callbacks.activity?.(this.lastSpeechAt); }
      if (activity.started && !this.speaking) { this.speaking = true; this.callbacks.speech(); }
      // Cut audio for ASR, but only VoiceTurnBuffer decides when the user has finished.
      if (this.mode === 'call' && this.speaking && now - this.lastSpeech > 1250) this.rotate(true, 'silence');
      else if (now - this.started > (this.mode === 'call' ? 45_000 : 120_000)) this.rotate(this.mode === 'recording' || this.speaking, 'limit');
      else if (this.mode === 'call' && !this.speaking && now - this.started > 15_000) this.rotate(false);
    }, 60);
  }
  private begin() {
    if (this.closed || this.muted || !this.stream || this.rotating || this.recorder) return;
    this.chunks = []; this.started = performance.now(); this.speaking = false; this.activity.reset();
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 128_000 });
    this.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) this.chunks.push(event.data); };
    recorder.onerror = () => this.callbacks.error('录音失败，请检查麦克风。');
    recorder.start(250);
  }
  private rotate(deliver: boolean, reason: VoiceClipTiming['reason'] = 'manual'): boolean {
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') return this.rotating;
    this.recorder = undefined;
    this.rotating = true;
    const timing = { lastSpeechAt: this.lastSpeechAt, reason };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: recorder.mimeType }); this.chunks = [];
      this.rotating = false;
      if (!this.closed) {
        if (deliver && blob.size > 0) this.callbacks.clip(blob, timing);
        else this.callbacks.discarded?.();
      }
      if (this.mode === 'call') this.begin();
    };
    recorder.stop();
    // stop() flushes recorded audio asynchronously; release the device now while
    // allowing ondataavailable/onstop to deliver that last chunk.
    if (this.mode === 'recording') {
      window.clearInterval(this.timer);
      this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
      void this.context?.close().catch(() => {}); this.context = undefined;
    }
    return deliver;
  }
  finish() { return this.rotate(this.mode === 'recording' || this.speaking); }
  mute(value: boolean) {
    this.muted = value; this.stream?.getAudioTracks().forEach(track => { track.enabled = !value; });
    if (value) this.callbacks.level(0);
    if (value) this.rotate(false); else if (!this.recorder) this.begin();
  }
  close() {
    this.closed = true; window.clearInterval(this.timer);
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined; this.chunks = [];
    void this.context?.close().catch(() => {}); this.context = undefined;
  }
}
