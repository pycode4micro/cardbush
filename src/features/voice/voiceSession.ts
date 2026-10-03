import type { VoiceDesktopApi, VoiceSettings } from '../../../electron/voiceTypes';
import type { ChatMessage } from '../../types';
import { SpokenTranscript } from './speechText';
import { VoiceCapture, VoicePlayback, type VoiceClipTiming } from './voiceAudio';
import { VoiceTurnBuffer, type VoiceTurnClock, type VoiceTurnDraft } from './voiceTurnBuffer';
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
  speakerNotice?: string;
  speakerLocked: boolean;
  mode: 'idle' | 'recording' | 'call';
  phase: 'idle' | 'connecting' | 'recording' | 'recorded' | 'listening' | 'transcribing' | 'submitting';
  activity: string; agentWorking: boolean; agentWaiting: boolean; spokenText: string;
  queuedClips: number; capturePaused: boolean; reviewText: string;
  inputPending: boolean; inputFinishing: boolean; draftTranscript: string;
  background: boolean;
  speaking: boolean; muted: boolean; level: number; startedAt: number; transcript: string; error: string; retryAvailable: boolean; voice: 'female' | 'male';
}
const initial: VoiceState = { inputPending: false, inputFinishing: false, draftTranscript: '', speakerNotice: undefined, speakerLocked: false, mode: 'idle', phase: 'idle', background: false, activity: '', agentWorking: false, agentWaiting: false, spokenText: '', queuedClips: 0, capturePaused: false, reviewText: '', speaking: false, muted: false, level: 0, startedAt: 0, transcript: '', error: '', retryAvailable: false, voice: 'female' };
let active: VoiceSession | undefined;
export interface VoiceDependencies {
  clock?: VoiceTurnClock;
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
  private speechQueue: string[] = [];
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
  private input?: VoiceTurnBuffer;
  private get finishingInput() { return this.state.inputFinishing; }
  private set finishingInput(value: boolean) { this.patch({ inputFinishing: value }); }
  private submitting = false;
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
    this.input?.refresh();
    if (target.stopping || this.spoken.revised(target.messages)) { this.interrupt(); return; }
    if (this.settingsOpen) { this.spoken.skip(target.messages); return; }
    const phrases = this.spoken.update(target.messages, target.activeTurnId, target.sending);
    if (phrases.length) {
      // Bound queued speech; very long outputs remain fully available as text.
      if (this.speechQueue.length + phrases.length > 80) { this.interrupt(); this.patch({ error: '回复较长，已暂停朗读，完整内容保留在对话中。' }); return; }
      this.speechQueue.push(...phrases); void this.drain(this.playbackEpoch);
    }
  }
  async start(mode: 'recording' | 'call') {
    if (this.state.mode !== 'idle') return;
    active?.end(); active = this;
    const epoch = ++this.epoch;
    this.manualSend = false; this.failedText = ''; this.lastClip = undefined;
    this.spoken.reset(this.target?.messages ?? []);
    this.patch({ ...initial, mode, phase: 'connecting', startedAt: Date.now(), agentWorking: Boolean(this.target?.sending), agentWaiting: Boolean(this.target?.waiting) });
    try {
      if (!this.api) throw Error('语音功能需要在 CardBush 桌面应用中使用。');
      this.settings = await this.api.settings();
      if (epoch !== this.epoch) return;
      if (this.settings.speakerLockEnabled) {
        const model = await this.api.modelStatus('speaker');
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error('声纹锁定已开启，请安装声纹模型或在语音设置中关闭锁定。');
        const status = await this.api.speakerStatus();
        if (epoch !== this.epoch) return;
        if (status.enabled && !status.enrolled) throw Error('当前声纹尚未录入完整，请在语音设置中完成录入。');
        this.settings.speakerLockEnabled = status.enabled;
      }
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
      this.patch({ voice: this.settings.voice, speakerLocked: Boolean(this.settings.speakerLockEnabled) });
      if (mode === 'call') this.input = new VoiceTurnBuffer(
        () => this.settings?.turnEndPause === 'patient' ? 6000 : this.target?.sending ? 5000 : 3000,
        draft => { if (epoch === this.epoch) void this.commitTurn(draft, epoch); },
        (inputPending, draftTranscript) => { if (epoch === this.epoch) this.patch({ inputPending, draftTranscript }); }, this.deps.clock);
      if (mode === 'call') { this.player = this.deps.playback(this.api); await this.player.prepare(); }
      if (epoch !== this.epoch) return;
      this.capture = this.deps.capture(mode, {
        level: level => { if (epoch === this.epoch) this.patch({ level }); },
        // Activity alone may be a tap, cough or speaker echo. Keep playback and
        // queued replies until the recognized utterance passes review checks.
        speech: () => { if (epoch === this.epoch) this.input?.speech(); },
        activity: at => { if (epoch === this.epoch) this.input?.activity(at); },
        discarded: () => { if (epoch === this.epoch) this.input?.discardCapture(); },
        clip: (blob, timing) => {
          if (epoch !== this.epoch) return;
          if (mode === 'recording') { this.capture?.close(); this.capture = undefined; this.patch({ level: 0 }); }
          this.lastClip = blob;
          if (mode === 'recording' && !this.manualSend) { this.patch({ phase: 'recorded' }); return; }
          this.queueClip(blob, epoch, '', timing);
        },
        error: message => { if (epoch === this.epoch) { this.capture?.close(); this.capture = undefined; this.interrupt(); this.patch({ error: message, muted: true, phase: 'idle' }); this.syncCapture(); } },
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
  finishUtterance() {
    if (this.state.mode !== 'call' || ['idle', 'connecting', 'submitting'].includes(this.state.phase) || this.state.reviewText || this.settingsOpen || this.finishingInput) return;
    this.finishingInput = true;
    const flushing = this.capture?.finish();
    if (!flushing) this.input?.discardCapture();
    this.syncCapture(); this.input?.force();
    if (!flushing && !this.state.inputPending) { this.finishingInput = false; this.syncCapture(); }
  }
  private syncCapture() {
    this.input?.pause(this.submitting || (!this.finishingInput && (this.state.muted || this.state.capturePaused || this.state.retryAvailable)) || Boolean(this.state.reviewText) || this.settingsOpen);
    this.capture?.mute(this.finishingInput || this.submitting || this.state.muted || this.state.capturePaused || Boolean(this.state.reviewText) || this.settingsOpen);
  }
  private async commitTurn(draft: VoiceTurnDraft, epoch: number) {
    if (draft.review || needsVoiceReview(draft.text)) {
      this.finishingInput = false; this.inputEpoch++; this.lastClip = undefined;
      this.patch({ reviewText: draft.text }); this.syncCapture(); return;
    }
    try { await this.sendInput(draft.text, epoch); }
    catch (error) {
      if (epoch !== this.epoch) return;
      this.patch({ error: voiceError(error, '消息未发送，识别内容已保留。'), retryAvailable: true, muted: true }); this.syncCapture();
    }
  }
  private async sendInput(text: string, epoch: number) {
    if (this.state.mode === 'call') this.interrupt();
    this.submitting = true; this.failedText = text;
    this.patch({ transcript: text, phase: 'submitting', reviewText: '' }); this.syncCapture();
    this.sendingFirst = !this.target?.sessionId;
    try {
      const accepted = await this.target?.send(text, this.state.mode === 'call' ? { immediate: true } : undefined);
      if (epoch !== this.epoch) return;
      if (accepted === false) throw Error('消息未发送，转写已保留，可重试。');
      this.failedText = ''; this.lastClip = undefined;
      if (this.state.mode === 'recording') this.end();
    } finally {
      if (epoch === this.epoch) {
        this.submitting = false; this.finishingInput = false;
        this.patch({ phase: this.state.mode === 'call' ? this.pending ? 'transcribing' : 'listening' : 'recorded' }); this.syncCapture();
      }
    }
  }
  private queueClip(blob: Blob, epoch: number, retryText = '', timing?: VoiceClipTiming) {
    if (this.state.reviewText && !retryText) return;
    if (this.pending >= 3) { this.capture?.mute(true); this.patch({ capturePaused: true }); return; }
    this.pending++;
    const buffered = this.state.mode === 'call' && !retryText;
    if (buffered) this.input?.beginClip(timing?.lastSpeechAt);
    this.patch({ queuedClips: this.pending, capturePaused: this.pending >= 3 });
    if (this.pending >= 3) this.syncCapture();
    const inputEpoch = this.inputEpoch;
    this.serial = this.serial.then(async () => {
      if (epoch !== this.epoch) return;
      if (inputEpoch !== this.inputEpoch) { if (buffered) this.input?.finishClip(); this.releaseClip(); return; }
      this.patch({ phase: 'transcribing', error: '', retryAvailable: false, speakerNotice: undefined });
      const id = crypto.randomUUID(); this.requests.add(id);
      try {
        const recording = retryText ? undefined : await prepareVoiceRecording(blob, this.settings?.speakerLockEnabled ? 'system' : this.settings?.recognitionEngine ?? (this.settings?.engine === 'cloud' ? 'cloud' : 'system'));
        if (epoch !== this.epoch) return;
        const result: Awaited<ReturnType<VoiceDesktopApi['transcribe']>> = retryText ? { text: retryText } : await this.api!.transcribe({ id, ...recording! });
        if (epoch !== this.epoch) return;
        if (result.speaker) {
          this.lastClip = undefined; this.failedText = '';
          if (this.state.mode === 'recording') throw Error('声纹未通过，请由录入者说完整一句后重新录音。');
          this.patch({ speakerNotice: this.target?.language === 'en' ? 'Unverified voice ignored' : result.speaker === 'uncertain' ? '语音不足，未打断播报' : '已忽略未匹配的人声' });
          return;
        }
        if (!result.text.trim()) { if (this.state.mode === 'recording') throw Error('没有识别到语音，请取消后重新录音。'); return; }
        // Require proof for THIS clip, not a cached setting or an installed model.
        // Older hosts and a lock disabled mid-call safely fall back to review.
        if (!retryText && this.state.mode === 'call') this.patch({ speakerLocked: result.speakerVerified === true });
        if (buffered) {
          this.input?.append(result.text, result.speakerVerified !== true ||
            isVoicePlaybackEcho(result.text, this.recentSpeech.filter(item => Date.now() - item.at < 20_000).map(item => item.text)));
          return;
        }
        await this.sendInput(result.text, epoch);
      } catch (error) {
        if (epoch === this.epoch) {
          this.inputEpoch++; this.lastClip = blob;
          // Pause a failed call instead of silently losing utterances or auto-retrying sends.
          if (this.state.mode === 'call') { this.finishingInput = false; this.patch({ muted: true }); }
          this.patch({ error: voiceError(error, '语音转写失败。'), retryAvailable: true });
          this.syncCapture();
        }
      } finally {
        this.requests.delete(id);
        if (epoch === this.epoch) {
          this.releaseClip();
          if (buffered) this.input?.finishClip();
          if (!this.submitting) this.patch({ phase: this.state.mode === 'call' ? this.pending ? 'transcribing' : 'listening' : this.state.mode === 'recording' ? 'recorded' : 'idle' });
          if (this.finishingInput && !this.state.inputPending) { this.finishingInput = false; this.syncCapture(); }
        }
      }
    });
  }
  private releaseClip() {
    this.pending--;
    if (this.state.capturePaused && this.pending < 2) { this.patch({ capturePaused: false }); this.syncCapture(); }
    this.patch({ queuedClips: this.pending });
  }
  retry() {
    if (this.state.mode === 'recording') { this.finishRecording(); return; }
    if ((this.lastClip || this.failedText) && !['transcribing', 'submitting'].includes(this.state.phase)) {
      this.finishingInput = true;
      this.patch({ phase: 'transcribing', error: '', retryAvailable: false });
      this.queueClip(this.lastClip ?? new Blob(), this.epoch, this.failedText);
      this.syncCapture(); this.input?.force();
    }
  }
  review(text: string) {
    if (!this.state.reviewText) return;
    if (!text.trim()) { this.patch({ reviewText: '' }); this.syncCapture(); return; }
    if (this.pending >= 3) return;
    this.patch({ reviewText: '' });
    this.queueClip(new Blob(), this.epoch, text.trim());
    this.syncCapture();
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
      void this.api?.settings().then(settings => { if (epoch === this.epoch) { this.settings = settings; this.patch({ voice: settings.voice, speakerLocked: Boolean(settings.speakerLockEnabled) }); } }).catch(() => {});
    }
  }
  mute() { this.patch({ muted: !this.state.muted }); this.syncCapture(); }
  interrupt() {
    this.playbackEpoch++; this.speechQueue = []; this.player?.stop();
    this.spoken.skip(this.target?.messages ?? []); this.patch({ speaking: false });
  }
  private async drain(epoch: number) {
    if (this.state.speaking || !this.player || this.state.mode !== 'call') return;
    this.patch({ speaking: true });
    try {
      while (epoch === this.playbackEpoch && this.speechQueue.length) {
        let phrase = this.speechQueue.shift()!;
        // Combine already available short sentences for continuous intonation.
        // Never delay the first sentence waiting for future model output.
        if (this.settings?.engine === 'kokoro' && this.settings.kokoroStyle !== 'neutral') {
          while (this.speechQueue.length && phrase.length + this.speechQueue[0].length < 180) phrase += ' ' + this.speechQueue.shift();
        }
        this.patch({ spokenText: phrase });
        const spoken = { text: phrase, at: Date.now() };
        this.recentSpeech = [...this.recentSpeech.filter(item => Date.now() - item.at < 20_000), spoken].slice(-8);
        await this.player.speak(phrase, this.state.voice);
        spoken.at = Date.now();
      }
    } catch (error) { if (epoch === this.playbackEpoch) { this.speechQueue = []; this.patch({ error: voiceError(error, '语音播放失败，文字回复仍会正常显示。请检查语音设置。') }); } }
    finally { if (epoch === this.playbackEpoch) this.patch({ speaking: false }); }
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
    this.input?.reset(); this.input = undefined; this.finishingInput = false; this.submitting = false;
    ++this.epoch; this.interrupt(); this.capture?.close(); this.capture = undefined;
    this.player?.close(); this.player = undefined;
    for (const id of this.requests) void this.api?.cancel(id).catch(() => {});
    this.requests.clear(); this.pending = 0; this.serial = Promise.resolve(); this.lastClip = undefined; this.failedText = '';
    this.spoken.reset([]); this.recentSpeech = []; this.settingsOpen = false;
    this.sendingFirst = false; if (active === this) active = undefined;
    this.patch({ ...initial });
  }
}

/** Enrollment is explicit microphone use; avoid feeding its prompts to a live Agent. */
export function endVoiceForEnrollment() { active?.end(); }
