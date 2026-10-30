import { uiText } from '../../i18n';
import type { CaptureCallbacks, VoiceClipTiming } from './voiceAudio';
import { VoiceActivity } from './voiceActivity';
import { pcm16Wave } from './voiceRecording';

const rate = 16_000;
/** Bounded PCM snapshots reuse every configured ASR engine without reopening the microphone. */
export class DictationCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private analyser?: AnalyserNode;
  private spectrum = new Float32Array(1024);
  private activity = new VoiceActivity();
  private frames: ArrayBuffer[] = [];
  private segmentFrames: ArrayBuffer[] = [];
  private samples = 0;
  private segmentSamples = 0;
  private segment = 0;
  private lastSpeech = 0;
  private lastPreview = 0;
  private voiced = false;
  private closed = false;
  private muted = false;
  private finishing = false;
  private finishReason: VoiceClipTiming['reason'] = 'manual';
  private flushTimeout?: number;
  constructor(private callbacks: CaptureCallbacks, private microphoneId = '') {}
  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw Error(uiText()('voiceAudio.recording_is_not_supported_in_this_environment'));
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
        ...(this.microphoneId ? { deviceId: { exact: this.microphoneId } } : {}),
      } });
    } catch (error) {
      if (error instanceof DOMException && ['NotFoundError', 'OverconstrainedError'].includes(error.name)) throw Error(uiText()('voiceAudio.the_selected_microphone_is_unavailable_choose_another'));
      throw error;
    }
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
      if (!this.closed && !this.finishing) this.callbacks.error(uiText()('voiceAudio.the_microphone_was_disconnected_reconnect_it_before'));
    }));
    this.context = new AudioContext({ sampleRate: rate });
    if (this.context.sampleRate !== rate) throw Error(uiText()('realtimeVoiceAudio.this_audio_device_does_not_support_16'));
    await this.context.audioWorklet.addModule(new URL('voice/realtime-capture-worklet.js', document.baseURI).href);
    if (this.closed) return;
    this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048;
    this.node = new AudioWorkletNode(this.context, 'cardbush-realtime-capture');
    this.node.port.onmessage = ({ data }) => {
      if (this.closed) return;
      if (data === 'flushed') { if (this.finishing) this.deliver(); return; }
      if (data instanceof ArrayBuffer && (!this.muted || this.finishing)) this.append(data);
    };
    const gain = this.context.createGain(); gain.gain.value = 0;
    this.context.createMediaStreamSource(stream).connect(this.analyser).connect(this.node).connect(gain).connect(this.context.destination);
    this.node.port.postMessage(!this.muted);
    await this.context.resume();
  }
  private append(frame: ArrayBuffer) {
    const pcm = new Int16Array(frame);
    if (!pcm.length) return;
    this.frames.push(frame); this.segmentFrames.push(frame);
    this.samples += pcm.length; this.segmentSamples += pcm.length;
    if (this.finishing) return;
    let sum = 0;
    for (const value of pcm) sum += (value / 32768) ** 2;
    const rms = Math.sqrt(sum / pcm.length), now = this.samples / rate * 1000;
    this.callbacks.level(Math.min(1, rms * 10));
    this.analyser!.getFloatFrequencyData(this.spectrum);
    const activity = this.activity.update(rms, this.spectrum, rate, now);
    if (activity.voiced) { this.lastSpeech = this.samples; this.voiced = true; }
    if (activity.started) this.callbacks.speech();
    if (this.voiced) {
      const final = this.samples - this.lastSpeech >= rate * .75 || this.segmentSamples >= rate * 12;
      if (final || this.samples - this.lastPreview >= rate * 1.5 && this.segmentSamples >= rate * 1.5) {
        this.callbacks.preview?.(this.wave(this.segmentFrames), { segment: this.segment, final });
        this.lastPreview = this.samples;
        if (final) { this.segment++; this.segmentFrames = []; this.segmentSamples = 0; this.voiced = false; }
      }
    } else if (this.segmentSamples > rate) {
      // Keep brief preroll, not an ever-growing silence prefix.
      while (this.segmentSamples > rate / 2 && this.segmentFrames.length > 1) this.segmentSamples -= this.segmentFrames.shift()!.byteLength / 2;
    }
    if (this.samples >= rate * 120) { this.finishReason = 'limit'; this.finish(); }
  }
  private wave(frames: ArrayBuffer[]) {
    const pcm = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
    let offset = 0;
    for (const frame of frames) { pcm.set(new Uint8Array(frame), offset); offset += frame.byteLength; }
    return new Blob([pcm16Wave(pcm, rate)], { type: 'audio/wav' });
  }
  finish() {
    if (this.closed || this.finishing) return this.finishing;
    this.finishing = true;
    this.stream?.getTracks().forEach(track => track.stop());
    // Drain the worklet's last partial frame before producing the final WAV.
    this.flushTimeout = window.setTimeout(() => this.deliver(), 500);
    if (this.node) this.node.port.postMessage('flush'); else this.deliver();
    return true;
  }
  private deliver() {
    if (this.closed) return;
    const blob = this.wave(this.frames), reason = this.finishReason;
    this.close();
    this.callbacks.clip(blob, { reason, lastSpeechAt: Date.now() });
  }
  mute(value: boolean) {
    if (this.closed || this.finishing) return;
    this.muted = value;
    this.node?.port.postMessage(!value);
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !value; });
    if (value) this.callbacks.level(0);
  }
  close() {
    this.closed = true; window.clearTimeout(this.flushTimeout);
    this.node?.disconnect(); this.node?.port.close();
    this.stream?.getTracks().forEach(track => track.stop());
    this.frames = []; this.segmentFrames = [];
    void this.context?.close().catch(() => {});
  }
}
