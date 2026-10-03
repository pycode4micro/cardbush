import type { VoiceDesktopApi, VoiceSettings } from '../../../electron/voiceTypes';
import type { ChatMessage } from '../../types';
import { SpokenTranscript } from './speechText';
import { VoiceCapture, VoicePlayback } from './voiceAudio';
import { prepareVoiceRecording } from './voiceRecording';
import { voiceError } from './voiceError';
import { VoiceProgress, needsVoiceReview } from './voiceProgress';
import { isVoicePlaybackEcho } from './voiceActivity';

export interface VoiceTarget {
  environment: string; sessionId: string; messages: ChatMessage[]; sending: boolean; stopping?: boolean; activeTurnId?: string | null;
  language?: 'zh' | 'en'; waiting?: boolean;
  send(text: string, options?: { immediate?: boolean }): Promise<void | boolean>;
}
export interface VoiceState {
  mode: 'idle' | 'recording' | 'call';
  phase: 'idle' | 'connecting' | 'recording' | 'recorded' | 'listening' | 'transcribing' | 'submitting';
  activity: string; agentWorking: boolean; agentWaiting: boolean; spokenText: string;
  queuedClips: number; capturePaused: boolean; reviewText: string;
  background: boolean;
  speaking: boolean; muted: boolean; level: number; startedAt: number; transcript: string; error: string; retryAvailable: boolean; voice: 'female' | 'male';
}
const initial: VoiceState = { mode: 'idle', phase: 'idle', background: false, activity: '', agentWorking: false, agentWaiting: false, spokenText: '', queuedClips: 0, capturePaused: false, reviewText: '', speaking: false, muted: false, level: 0, startedAt: 0, transcript: '', error: '', retryAvailable: false, voice: 'female' };
let active: VoiceSession | undefined;
export interface VoiceDependencies {
  capture: (mode: 'recording' | 'call', callbacks: ConstructorParameters<typeof VoiceCapture>[1], microphoneId?: string) => Pick<VoiceCapture, 'start' | 'finish' | 'mute' | 'close'>;
  playback: (api: VoiceDesktopApi) => Pick<VoicePlayback, 'prepare' | 'speak' | 'stop' | 'close'>;
}
/** Voice owns microphone/playback; the existing conversation owns Agent execution. */
export class VoiceSession {
  private state: VoiceState = initial;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private playbackEpoch = 0;
  private capture?: ReturnType<VoiceDependencies['capture']>;
  private player?: ReturnType<VoiceDependencies['playback']>;
  private speechQueue: { text: string; kind: 'reply' | 'activity' }[] = [];
  private speechKind?: 'reply' | 'activity';
  private progress = new VoiceProgress();
  private spoken = new SpokenTranscript();
  private requests = new Set<string>();
  private target?: VoiceTarget;
  private sendingFirst = false;
  private serial: Promise<void> = Promise.resolve();
  private pending = 0;
  private inputEpoch = 0;
  private lastClip?: Blob;
  private manualSend = false;
  private failedText = '';
  private settings?: VoiceSettings;
  private recentSpeech: { text: string; at: number }[] = [];
  private settingsOpen = false;
  constructor(private api: VoiceDesktopApi | undefined, private deps: VoiceDependencies = {
    capture: (mode, callbacks, microphoneId) => new VoiceCapture(mode, callbacks, microphoneId), playback: api => new VoicePlayback(api),
  }) {}
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private patch(patch: Partial<VoiceState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  update(target: VoiceTarget) {
    const previous = this.target;
    if (previous && (previous.environment !== target.environment || previous.sessionId !== target.sessionId &&
      !(this.sendingFirst && !previous.sessionId && target.sessionId))) this.end();
    this.target = target;
    if (target.sessionId) this.sendingFirst = false;
    if (this.state.mode !== 'call' || this.state.phase === 'connecting') return;
    const progress = this.progress.update(target.messages, target.activeTurnId, target.language ?? 'zh');
    this.patch({ activity: progress.activity, agentWorking: target.sending, agentWaiting: Boolean(target.waiting) });
    if (target.stopping || this.spoken.revised(target.messages)) { this.interrupt(); return; }
    if (this.settingsOpen) { this.spoken.skip(target.messages); return; }
    const phrases = this.spoken.update(target.messages, target.activeTurnId, target.sending);
    if (phrases.length) {
      // Bound queued speech; very long outputs remain fully available as text.
      if (this.speechQueue.length + phrases.length > 80) { this.interrupt(); this.patch({ error: '回复较长，已暂停朗读，完整内容保留在对话中。' }); return; }
      if (this.speechKind === 'activity') { this.playbackEpoch++; this.player?.stop(); this.patch({ speaking: false }); }
      this.speechQueue = this.speechQueue.filter(item => item.kind === 'reply');
      this.speechQueue.push(...phrases.map(text => ({ text, kind: 'reply' as const }))); void this.drain(this.playbackEpoch);
    } else if (target.sending && progress.announcement && !this.speechQueue.some(item => item.kind === 'reply') && this.speechKind !== 'reply') {
      this.speechQueue = this.speechQueue.filter(item => item.kind !== 'activity');
      this.speechQueue.push({ text: progress.announcement, kind: 'activity' }); void this.drain(this.playbackEpoch);
    }
  }
  async start(mode: 'recording' | 'call') {
    if (this.state.mode !== 'idle') return;
    active?.end(); active = this;
    const epoch = ++this.epoch;
    this.manualSend = false; this.failedText = ''; this.lastClip = undefined;
    this.spoken.reset(this.target?.messages ?? []);
    this.progress.reset(this.target?.messages ?? []);
    this.patch({ ...initial, mode, phase: 'connecting', startedAt: Date.now(), agentWorking: Boolean(this.target?.sending), agentWaiting: Boolean(this.target?.waiting) });
    try {
      if (!this.api) throw Error('语音功能需要在 CardBush 桌面应用中使用。');
      this.settings = await this.api.settings();
      if (epoch !== this.epoch) return;
      const recognition = this.settings.recognitionEngine ?? this.settings.engine;
      if ((recognition === 'cloud' || mode === 'call' && this.settings.engine === 'cloud') && !this.settings.hasApiKey) throw Error('请配置云端语音 API Key，或在设置中选择本地语音。');
      if (recognition === 'sensevoice') {
        const model = await this.api.modelStatus();
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error('请在「语音设置」中安装本地识别模型，或选择其他识别方式。');
      }
      if (mode === 'call' && this.settings.engine === 'kokoro') {
        const model = await this.api.modelStatus('speech');
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error('请在「语音设置」中安装本地自然音色，或选择其他朗读方式。');
      }
      if (recognition === 'system' || mode === 'call' && this.settings.engine === 'system') {
        const capabilities = await this.api.capabilities();
        if (epoch !== this.epoch) return;
        if (!capabilities.available) throw Error(capabilities.error || '本地语音组件不可用。');
        if (recognition === 'system' && !capabilities.recognizers.some(item => item.language === this.settings!.language)) throw Error('未安装该语言的本地语音识别引擎，请在 Windows 语言设置中安装语音识别组件。');
        const selectedId = this.settings.voice === 'female' ? this.settings.systemFemaleVoice : this.settings.systemMaleVoice;
        if (mode === 'call' && this.settings.engine === 'system' && !capabilities.voices.some(item => item.language === this.settings!.language && item.gender === this.settings!.voice && (!selectedId || item.id === selectedId))) throw Error('未安装所选语言的男声或女声，请在语音设置中选择已有音色或安装 Windows 语音包。');
      }
      this.patch({ voice: this.settings.voice });
      if (mode === 'call') { this.player = this.deps.playback(this.api); await this.player.prepare(); }
      if (epoch !== this.epoch) return;
      this.capture = this.deps.capture(mode, {
        level: level => { if (epoch === this.epoch) this.patch({ level }); },
        // Activity alone may be a tap, cough or speaker echo. Keep playback and
        // queued replies until the recognized utterance passes review checks.
        speech: () => {},
        clip: blob => {
          if (epoch !== this.epoch) return;
          if (mode === 'recording') { this.capture?.close(); this.capture = undefined; this.patch({ level: 0 }); }
          this.lastClip = blob;
          if (mode === 'recording' && !this.manualSend) { this.patch({ phase: 'recorded' }); return; }
          this.queueClip(blob, epoch);
        },
        error: message => { if (epoch === this.epoch) { this.capture?.close(); this.capture = undefined; this.interrupt(); this.patch({ error: message, muted: true, phase: 'idle' }); } },
      }, this.settings.microphoneId);
      await this.capture.start();
      if (epoch === this.epoch) this.patch({ phase: mode === 'recording' ? 'recording' : 'listening' });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.capture?.close(); this.capture = undefined; this.player?.close();
      this.patch({ error: voiceError(error, '无法启动语音。'), phase: 'idle' });
    }
  }
  finishRecording() {
    if (this.state.mode !== 'recording' || !['recording', 'recorded'].includes(this.state.phase)) return;
    this.manualSend = true;
    // Dismiss the modal synchronously without cancelling the pending transcription.
    this.patch({ background: true, phase: 'transcribing', error: '', retryAvailable: false });
    if (this.lastClip) this.queueClip(this.lastClip, this.epoch, this.failedText);
    else this.capture?.finish();
  }
  private queueClip(blob: Blob, epoch: number, retryText = '') {
    if (this.pending >= 3) { this.capture?.mute(true); this.patch({ capturePaused: true }); return; }
    this.pending++;
    this.patch({ queuedClips: this.pending, capturePaused: this.pending >= 3 });
    if (this.pending >= 3) this.capture?.mute(true);
    const inputEpoch = this.inputEpoch;
    this.serial = this.serial.then(async () => {
      if (epoch !== this.epoch) return;
      if (inputEpoch !== this.inputEpoch) { this.releaseClip(); return; }
      this.patch({ phase: 'transcribing', error: '', retryAvailable: false });
      const id = crypto.randomUUID(); this.requests.add(id);
      try {
        const recording = retryText ? undefined : await prepareVoiceRecording(blob, this.settings?.recognitionEngine ?? (this.settings?.engine === 'cloud' ? 'cloud' : 'system'));
        if (epoch !== this.epoch) return;
        const result = retryText ? { text: retryText } : await this.api!.transcribe({ id, ...recording! });
        if (epoch !== this.epoch) return;
        if (!result.text.trim()) { if (this.state.mode === 'recording') throw Error('没有识别到语音，请取消后重新录音。'); return; }
        if (this.state.mode === 'call' && !retryText && (needsVoiceReview(result.text) ||
          isVoicePlaybackEcho(result.text, this.recentSpeech.filter(item => Date.now() - item.at < 20_000).map(item => item.text)))) {
          this.patch({ reviewText: result.text }); return;
        }
        if (this.state.mode === 'call') this.interrupt();
        this.patch({ transcript: result.text });
        this.failedText = result.text;
        this.patch({ phase: 'submitting', reviewText: '' });
        this.sendingFirst = !this.target?.sessionId;
        const accepted = await this.target?.send(result.text, this.state.mode === 'call' ? { immediate: true } : undefined);
        if (epoch !== this.epoch) return;
        if (accepted === false) throw Error('消息未发送，转写已保留，可重试。');
        this.failedText = ''; this.lastClip = undefined;
        if (this.state.mode === 'recording') this.end();
      } catch (error) {
        if (epoch === this.epoch) {
          this.inputEpoch++; this.lastClip = blob;
          // Pause a failed call instead of silently losing utterances or auto-retrying sends.
          if (this.state.mode === 'call') { this.capture?.mute(true); this.patch({ muted: true }); }
          this.patch({ error: voiceError(error, '语音转写失败。'), retryAvailable: true });
        }
      } finally {
        this.requests.delete(id);
        if (epoch === this.epoch) {
          this.releaseClip();
          this.patch({ phase: this.state.mode === 'call' ? 'listening' : this.state.mode === 'recording' ? 'recorded' : 'idle' });
        }
      }
    });
  }
  private releaseClip() {
    this.pending--;
    if (this.state.capturePaused && this.pending < 2) { this.patch({ capturePaused: false }); if (!this.state.muted) this.capture?.mute(false); }
    this.patch({ queuedClips: this.pending });
  }
  retry() {
    if (this.state.mode === 'recording') { this.finishRecording(); return; }
    if (this.lastClip && this.state.phase !== 'transcribing') {
      this.patch({ phase: 'transcribing', error: '', retryAvailable: false });
      this.queueClip(this.lastClip, this.epoch, this.failedText);
    }
  }
  review(text: string) {
    if (!this.state.reviewText) return;
    if (!text.trim()) { this.patch({ reviewText: '' }); return; }
    if (this.pending >= 3) return;
    this.patch({ reviewText: '' });
    this.queueClip(new Blob(), this.epoch, text.trim());
  }
  restart() { const mode = this.state.mode; this.end(); if (mode !== 'idle') void this.start(mode); }
  setSettingsOpen(open: boolean) {
    this.settingsOpen = open;
    if (open) {
      this.interrupt();
      if (this.state.mode === 'call' && !this.state.muted) this.mute();
      if (this.state.mode === 'recording' && this.state.phase === 'recording') this.capture?.finish();
    } else {
      const epoch = this.epoch;
      void this.api?.settings().then(settings => { if (epoch === this.epoch) { this.settings = settings; this.patch({ voice: settings.voice }); } }).catch(() => {});
    }
  }
  mute() { const muted = !this.state.muted; this.capture?.mute(muted || this.state.capturePaused); this.patch({ muted }); }
  interrupt() {
    this.playbackEpoch++; this.speechQueue = []; this.player?.stop();
    this.speechKind = undefined;
    this.spoken.skip(this.target?.messages ?? []); this.patch({ speaking: false });
  }
  private async drain(epoch: number) {
    if (this.state.speaking || !this.player || this.state.mode !== 'call') return;
    this.patch({ speaking: true });
    try {
      while (epoch === this.playbackEpoch && this.speechQueue.length) {
        const phrase = this.speechQueue.shift()!; this.speechKind = phrase.kind;
        this.patch({ spokenText: phrase.text });
        const spoken = { text: phrase.text, at: Date.now() };
        this.recentSpeech = [...this.recentSpeech.filter(item => Date.now() - item.at < 20_000), spoken].slice(-8);
        await this.player.speak(phrase.text, this.state.voice);
        spoken.at = Date.now();
      }
    } catch (error) { if (epoch === this.playbackEpoch) { this.speechQueue = []; this.patch({ error: voiceError(error, '语音播放失败，文字回复仍会正常显示。请检查语音设置。') }); } }
    finally { if (epoch === this.playbackEpoch) { this.speechKind = undefined; this.patch({ speaking: false }); } }
  }
  async setVoice(voice: 'female' | 'male') {
    if (!this.api || !this.settings) return;
    const epoch = this.epoch;
    try {
      if (this.settings.engine === 'system') {
        const capabilities = await this.api.capabilities();
        if (epoch !== this.epoch) return;
        if (!capabilities.voices.some(item => item.language === this.settings!.language && item.gender === voice)) throw Error('未安装该语言的所选系统音色，请先安装 Windows 语音包。');
      }
      const settings = await this.api.saveSettings({ ...this.settings, voice });
      if (epoch === this.epoch) { this.settings = settings; this.patch({ voice }); }
    } catch (error) { if (epoch === this.epoch) this.patch({ error: voiceError(error, '音色保存失败。') }); }
  }
  end() {
    ++this.epoch; this.interrupt(); this.capture?.close(); this.capture = undefined;
    this.player?.close(); this.player = undefined;
    for (const id of this.requests) void this.api?.cancel(id).catch(() => {});
    this.requests.clear(); this.pending = 0; this.serial = Promise.resolve(); this.lastClip = undefined; this.failedText = '';
    this.spoken.reset([]); this.recentSpeech = []; this.settingsOpen = false;
    this.sendingFirst = false; if (active === this) active = undefined;
    this.patch({ ...initial });
  }
}
