import { uiText } from '../../i18n';
import type { VoiceDesktopApi, VoiceSettings } from '../../../electron/voiceTypes';
import type { ChatMessage } from '../../types';
import { SpokenTranscript } from './speechText';
import { VoiceCapture, VoicePlayback, type VoiceClipTiming } from './voiceAudio';
import { VoiceTurnBuffer, type VoiceTurnClock, type VoiceTurnDraft } from './voiceTurnBuffer';
import { prepareVoiceRecording } from './voiceRecording';
import { voiceError } from './voiceError';
import { VoiceProgress, isAmbiguousVoiceFragment } from './voiceProgress';
import { isVoicePlaybackEcho } from './voiceActivity';
import { RealtimeVoiceCall } from './realtimeVoiceCall';
import { DictationCapture } from './dictationCapture';
import { DictationPreview, type DictationUpdate } from './dictationPreview';

export interface VoiceTarget {
  assistant?: { name: string; persona: string };
  historyMessages?: ChatMessage[];
  contextGeneration?: number;
  refresh?(): VoiceTarget;
  audioPreferences?(): { microphoneMuted: boolean; outputMuted: boolean };
  onMicrophoneMuteChange?(muted: boolean): void;
  agent?: import('./realtimeAgentBridge').RealtimeAgentExecutor;
  environment: string; sessionId: string; messages: ChatMessage[]; sending: boolean; stopping?: boolean; activeTurnId?: string | null;
  language?: string; waiting?: boolean;
  send(text: string, options?: { immediate?: boolean }): Promise<void | boolean>;
}
export interface VoiceState {
  sessionId?: string;
  assistant?: boolean;
  contextNotice?: string;
  reconnecting?: boolean;
  connectionNotice?: string;
  agentError?: string;
  realtime?: boolean;
  outputMuted: boolean;
  outputLevel?: number;
  speakerNotice?: string;
  speakerLocked: boolean;
  mode: 'idle' | 'recording' | 'call';
  phase: 'idle' | 'connecting' | 'recording' | 'recorded' | 'listening' | 'transcribing' | 'submitting';
  activity: string; agentWorking: boolean; agentWaiting: boolean; spokenText: string;
  queuedClips: number; capturePaused: boolean;
  inputPending: boolean; inputFinishing: boolean; draftTranscript: string;
  speaking: boolean; muted: boolean; level: number; startedAt: number; transcript: string; error: string; retryAvailable: boolean; voice: 'female' | 'male';
}
const initial: VoiceState = { reconnecting:false, connectionNotice:'', contextNotice:'', outputMuted: false, agentError: '', realtime: false, inputPending: false, inputFinishing: false, draftTranscript: '', speakerNotice: undefined, speakerLocked: false, mode: 'idle', phase: 'idle', activity: '', agentWorking: false, agentWaiting: false, spokenText: '', queuedClips: 0, capturePaused: false, speaking: false, muted: false, level: 0, startedAt: 0, transcript: '', error: '', retryAvailable: false, voice: 'female' };
let active: VoiceSession | undefined;
export interface VoiceDependencies {
  clock?: VoiceTurnClock;
  capture: (mode: 'recording' | 'call', callbacks: ConstructorParameters<typeof VoiceCapture>[1], microphoneId?: string) => Pick<VoiceCapture, 'start' | 'finish' | 'mute' | 'close'>;
  playback: (api: VoiceDesktopApi) => Pick<VoicePlayback, 'prepare' | 'speak' | 'stop' | 'close'> & Partial<Pick<VoicePlayback, 'setOutputMuted'>>;
}
/** Voice owns microphone/playback; the existing conversation owns Agent execution. */
export class VoiceSession {
  private realtime?: RealtimeVoiceCall;
  private refreshTimer?: ReturnType<typeof setInterval>;
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
  private insertTranscript?: (text: string) => void;
  private updateTranscript?: (text: string, update: DictationUpdate) => void;
  private dictationPreview?: DictationPreview;
  private dictationId = '';
  private failedText = '';
  private settings?: VoiceSettings;
  private recentSpeech: { text: string; at: number }[] = [];
  private settingsOpen = false;
  private appliedAudioPreferences?: { microphoneMuted: boolean; outputMuted: boolean };
  private input?: VoiceTurnBuffer;
  private get finishingInput() { return this.state.inputFinishing; }
  private set finishingInput(value: boolean) { this.patch({ inputFinishing: value }); }
  private submitting = false;
  constructor(private api: VoiceDesktopApi | undefined, private deps: VoiceDependencies = {
    capture: (mode, callbacks, microphoneId) => mode === 'recording' && callbacks.preview
      ? new DictationCapture(callbacks, microphoneId) : new VoiceCapture(mode, callbacks, microphoneId),
    playback: api => new VoicePlayback(api, outputLevel => this.patch({outputLevel})),
  }) {}
  snapshot = () => this.state;
  matchesTarget(target: Pick<VoiceTarget, 'environment' | 'sessionId'>) {
    return this.target?.environment === target.environment && this.target?.sessionId === target.sessionId;
  }
  ownsVoice(target: Pick<VoiceTarget, 'environment' | 'sessionId'>) {
    return this.state.mode !== 'idle' && this.matchesTarget(target);
  }
  ownsCall(target: Pick<VoiceTarget, 'environment' | 'sessionId'>) {
    return this.state.mode === 'call' && this.ownsVoice(target);
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private patch(patch: Partial<VoiceState>) {
    if (patch.phase === 'idle' && patch.error) { clearInterval(this.refreshTimer); this.refreshTimer = undefined; void this.api?.setCallActive?.(false).catch(() => {}); }
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  update(target: VoiceTarget) {
    const previous = this.target;
    if (previous && (previous.environment !== target.environment || previous.sessionId !== target.sessionId &&
      !(this.sendingFirst && !previous.sessionId && target.sessionId))) {
      if (this.state.mode === 'call') return; // Navigation never retargets or terminates an active call.
      this.end();
    }
    // A pinned call owns its callbacks and executor; view rerenders only refresh its transcript.
    if (this.state.mode === 'call' && previous?.refresh) target = previous.refresh();
    this.target = target;
    if (target.sessionId) this.sendingFirst = false;
    this.realtime?.update(target);
    if (this.state.mode !== 'idle') this.applyAudioPreferences();
    if (this.state.mode !== 'call' || this.state.phase === 'connecting') return;
    if (this.realtime) return;
    const progress = this.progress.update(target.messages, target.activeTurnId, target.language ?? 'zh');
    this.patch({ activity: progress.activity, agentWorking: target.sending, agentWaiting: Boolean(target.waiting) });
    this.input?.refresh();
    if (target.stopping || this.spoken.revised(target.messages)) { this.interrupt(); return; }
    if (this.settingsOpen) { this.spoken.skip(target.messages); return; }
    const phrases = this.spoken.update(target.messages, target.activeTurnId, target.sending);
    if (phrases.length) {
      // Bound queued speech; very long outputs remain fully available as text.
      if (this.speechQueue.length + phrases.length > 80) { this.interrupt(); this.patch({ error: uiText()('voiceSession.speech_was_paused_because_the_reply_is') }); return; }
      this.speechQueue.push(...phrases); void this.drain(this.playbackEpoch);
    }
  }
  /** Leaving a recording view cancels its capture/ASR, while calls live at app scope. */
  releaseRecording(target: Pick<VoiceTarget, 'environment' | 'sessionId'>) {
    if ((this.state.mode === 'recording' || this.state.mode === 'idle' && this.state.error) && this.matchesTarget(target)) this.end();
  }
  async start(mode: 'recording' | 'call', insertTranscript?: (text: string) => void,
    updateTranscript?: (text: string, update: DictationUpdate) => void) {
    if (this.state.mode !== 'idle') return;
    active?.end(); active = this;
    const epoch = ++this.epoch;
    this.manualSend = false; this.failedText = ''; this.lastClip = undefined;
    this.insertTranscript = insertTranscript;
    this.updateTranscript = updateTranscript; this.dictationId = crypto.randomUUID();
    this.spoken.reset(this.target?.messages ?? []);
    this.patch({ ...initial, mode, phase: 'connecting', sessionId: this.target?.sessionId, assistant: Boolean(this.target?.assistant), startedAt: Date.now(), agentWorking: Boolean(this.target?.sending), agentWaiting: Boolean(this.target?.waiting) });
    try {
      if (!this.api) throw Error(uiText()('voiceSession.voice_features_require_the_cardbush_desktop_app'));
      if (mode === 'call' && this.target?.agent?.pin) {
        const pinned = await this.target.agent.pin(this.target);
        if (epoch !== this.epoch) return;
        this.target = pinned;
      }
      this.patch({ sessionId: this.target?.sessionId, assistant: Boolean(this.target?.assistant) });
      this.appliedAudioPreferences = undefined; this.applyAudioPreferences();
      if (mode === 'call') {
        await this.api.setCallActive?.(true);
        if (epoch !== this.epoch) { void this.api.setCallActive?.(false); return; }
        this.refreshTimer = setInterval(() => { if (this.target?.refresh) this.update(this.target.refresh()); }, 400);
      }
      this.settings = await this.api.settings();
      if (epoch !== this.epoch) return;
      if (mode === 'call' && this.api.realtime) {
        const config = await this.api.realtime.settings();
        if (epoch !== this.epoch) return;
        if (config.mode === 'realtime') {
          this.patch({ realtime: true, voice: this.settings.voice });
          if (this.settings.speakerLockEnabled) throw Error(uiText()('voiceSession.realtime_calls_do_not_support_voice_lock'));
          if (!config.hasApiKey) throw Error(uiText()('voiceSession.enter_a_volcengine_realtime_voice_api_key'));
          this.realtime = new RealtimeVoiceCall(this.api.realtime,
            patch => { if (epoch === this.epoch) this.patch(patch); },
            submitting => { if (epoch === this.epoch && submitting && !this.target?.sessionId) this.sendingFirst = true; }, undefined,
            () => { if (epoch === this.epoch) this.end(); });
          if (this.target) this.realtime.update(this.target);
          this.realtime.mute(this.state.muted); this.realtime.setOutputMuted(this.state.outputMuted);
          await this.realtime.start(this.settings.microphoneId, this.settings.voice);
          return;
        }
      }
      if (this.settings.speakerLockEnabled) {
        const model = await this.api.modelStatus('speaker');
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error(uiText()('voiceSession.voice_lock_is_enabled_install_the_voiceprint'));
        const status = await this.api.speakerStatus();
        if (epoch !== this.epoch) return;
        if (status.enabled && !status.enrolled) throw Error(uiText()('voiceSession.the_voiceprint_profile_is_incomplete_finish_enrollment'));
        this.settings.speakerLockEnabled = status.enabled;
      }
      const recognition = this.settings.recognitionEngine ?? this.settings.engine;
      if ((recognition === 'cloud' || mode === 'call' && this.settings.engine === 'cloud') && !this.settings.hasApiKey) throw Error(uiText()('voiceSession.configure_a_cloud_voice_api_key_or'));
      if (recognition === 'sensevoice') {
        const model = await this.api.modelStatus();
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error(uiText()('voiceSession.install_a_local_recognition_model_in_voice'));
      }
      if (mode === 'call' && this.settings.engine === 'kokoro') {
        const model = await this.api.modelStatus('speech');
        if (epoch !== this.epoch) return;
        if (model.state !== 'installed') throw Error(uiText()('voiceSession.install_a_local_natural_voice_in_voice'));
      }
      if (recognition === 'system' || mode === 'call' && this.settings.engine === 'system') {
        const capabilities = await this.api.capabilities();
        if (epoch !== this.epoch) return;
        if (!capabilities.available) throw Error(capabilities.error || uiText()('voiceSession.local_voice_components_are_unavailable'));
        if (recognition === 'system' && !capabilities.recognizers.some(item => item.language === this.settings!.language)) throw Error(uiText()('voiceSession.no_local_recognizer_is_installed_for_this'));
        const selectedId = this.settings.voice === 'female' ? this.settings.systemFemaleVoice : this.settings.systemMaleVoice;
        if (mode === 'call' && this.settings.engine === 'system' && !capabilities.voices.some(item => item.language === this.settings!.language && item.gender === this.settings!.voice && (!selectedId || item.id === selectedId))) throw Error(uiText()('voiceSession.the_selected_voice_is_not_installed_for'));
      }
      this.patch({ voice: this.settings.voice, speakerLocked: Boolean(this.settings.speakerLockEnabled) });
      if (mode === 'call') this.input = new VoiceTurnBuffer(
        () => this.settings?.turnEndPause === 'patient' ? 6000 : this.target?.sending ? 5000 : 3000,
        draft => { if (epoch === this.epoch) void this.commitTurn(draft, epoch); },
        (inputPending, draftTranscript) => { if (epoch === this.epoch) this.patch({ inputPending, draftTranscript }); }, this.deps.clock);
      if (mode === 'call') { this.player = this.deps.playback(this.api); this.player.setOutputMuted?.(this.state.outputMuted); await this.player.prepare(); }
      if (epoch !== this.epoch) return;
      if (mode === 'recording' && updateTranscript) this.dictationPreview = new DictationPreview(
        async (blob, id) => this.api!.transcribe({ id, audio: await blob.arrayBuffer(), mimeType: blob.type }),
        text => {
          if (epoch !== this.epoch) return;
          this.patch({ transcript: text });
          this.updateTranscript?.(text, { id: this.dictationId, final: false });
        }, id => { void this.api!.cancel(id).catch(() => {}); }, Boolean(this.settings.speakerLockEnabled));
      this.capture = this.deps.capture(mode, {
        level: level => { if (epoch === this.epoch) this.patch({ level }); },
        // Activity alone may be a tap, cough or speaker echo. Keep playback and
        // queued replies until a complete, usable utterance is recognized.
        speech: () => { if (epoch === this.epoch) this.input?.speech(); },
        activity: at => { if (epoch === this.epoch) this.input?.activity(at); },
        discarded: () => { if (epoch === this.epoch) this.input?.discardCapture(); },
        ...(this.dictationPreview ? { preview: (blob: Blob, segment: import('./dictationPreview').DictationSegment) => {
          if (epoch === this.epoch) this.dictationPreview?.append(blob, segment);
        } } : {}),
        clip: (blob, timing) => {
          if (epoch !== this.epoch) return;
          if (mode === 'recording') { this.dictationPreview?.close(); this.capture?.close(); this.capture = undefined; this.patch({ level: 0 }); }
          this.lastClip = blob;
          if (mode === 'recording' && !this.manualSend) { this.patch({ phase: 'recorded' }); return; }
          this.queueClip(blob, epoch, '', timing);
        },
        error: message => {
          if (epoch !== this.epoch) return;
          if (mode === 'recording') { this.end(message); return; }
          this.capture?.close(); this.capture = undefined; this.interrupt(); this.patch({ error: message, muted: true, phase: 'idle' }); this.syncCapture();
        },
      }, this.settings.microphoneId);
      await this.capture.start();
      if (epoch === this.epoch) { this.patch({ phase: mode === 'recording' ? 'recording' : 'listening' }); this.syncCapture(); }
    } catch (error) {
      if (epoch !== this.epoch) return;
      const message = voiceError(error, uiText()('voiceSession.could_not_start_voice'));
      // A device/startup failure has no recording to retry. Release ownership;
      // keep only the notice, so the next click starts a fresh attempt.
      if (mode === 'recording') { this.end(message); return; }
      this.realtime?.close();
      this.capture?.close(); this.capture = undefined; this.player?.close();
      this.patch({ error: message, phase: 'idle' });
    }
  }
  finishRecording() {
    if (this.state.mode !== 'recording' || !['recording', 'recorded'].includes(this.state.phase)) return;
    this.manualSend = true;
    this.dictationPreview?.close();
    // Keep capture ownership until transcription has been inserted into its draft.
    this.patch({ phase: 'transcribing', error: '', retryAvailable: false });
    if (this.lastClip) this.queueClip(this.lastClip, this.epoch, this.failedText);
    else this.capture?.finish();
  }
  finishUtterance() {
    if (this.realtime) { this.realtime.commit(); return; }
    if (this.state.mode !== 'call' || ['idle', 'connecting', 'submitting'].includes(this.state.phase) || this.settingsOpen || this.finishingInput) return;
    this.finishingInput = true;
    const flushing = this.capture?.finish();
    if (!flushing) this.input?.discardCapture();
    this.syncCapture(); this.input?.force();
    if (!flushing && !this.state.inputPending) { this.finishingInput = false; this.syncCapture(); }
  }
  private syncCapture() {
    this.input?.pause(this.submitting || (!this.finishingInput && (this.state.muted || this.state.capturePaused || this.state.retryAvailable)) || this.settingsOpen);
    this.capture?.mute(this.finishingInput || this.submitting || this.state.muted || this.state.capturePaused || this.settingsOpen);
  }
  private async commitTurn(draft: VoiceTurnDraft, epoch: number) {
    if (isAmbiguousVoiceFragment(draft.text)) {
      this.finishingInput = false; this.lastClip = undefined;
      this.patch({ speakerNotice: uiText(this.target?.language)('voiceSession.unclearSpeechIgnoredKeepTalking') });
      this.syncCapture(); return;
    }
    try { await this.sendInput(draft.text, epoch); }
    catch (error) {
      if (epoch !== this.epoch) return;
      this.patch({ error: voiceError(error, uiText()('voiceSession.the_message_was_not_sent_recognized_text')), retryAvailable: true, muted: true }); this.syncCapture();
    }
  }
  private async sendInput(text: string, epoch: number) {
    if (epoch !== this.epoch) return;
    if (this.state.mode === 'recording') {
      // Dictation is draft editing, never Agent input, including during a running turn.
      // The callback belongs to the composer that started capture; navigation cancels it.
      this.failedText = text;
      this.patch({ transcript: text });
      if (this.updateTranscript) this.updateTranscript(text, { id: this.dictationId, final: true });
      else if (this.insertTranscript) this.insertTranscript(text);
      else throw Error(uiText()('voiceSession.the_composer_is_unavailable_the_transcript_was'));
      this.end();
      return;
    }
    if (this.state.mode === 'call') this.interrupt();
    this.submitting = true; this.failedText = text;
    this.patch({ transcript: text, phase: 'submitting' }); this.syncCapture();
    this.sendingFirst = !this.target?.sessionId;
    try {
      const accepted = await this.target?.send(text, this.state.mode === 'call' ? { immediate: true } : undefined);
      if (epoch !== this.epoch) return;
      if (accepted === false) throw Error(uiText()('voiceSession.the_message_was_not_sent_the_transcript'));
      this.failedText = ''; this.lastClip = undefined;
    } finally {
      if (epoch === this.epoch) {
        this.submitting = false; this.finishingInput = false;
        this.patch({ phase: this.state.mode === 'call' ? this.pending ? 'transcribing' : 'listening' : 'recorded' }); this.syncCapture();
      }
    }
  }
  private queueClip(blob: Blob, epoch: number, retryText = '', timing?: VoiceClipTiming) {
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
          if (this.state.mode === 'recording') throw Error(uiText()('voiceSession.voice_verification_failed_ask_the_enrolled_speaker'));
          this.patch({ speakerNotice: uiText(this.target?.language)(result.speaker === 'uncertain' ? 'voice.uncertainIgnored' : 'voice.unmatchedIgnored') });
          return;
        }
        if (!result.text.trim()) { if (this.state.mode === 'recording') throw Error(uiText()('voiceSession.no_speech_was_recognized_cancel_and_record')); return; }
        // A configured lock still requires proof for THIS clip. Removing the
        // confirmation UI must not turn a missing verification into permission.
        if (!retryText && this.state.mode === 'call' && this.settings?.speakerLockEnabled && result.speakerVerified !== true) {
          this.lastClip = undefined; this.failedText = '';
          this.patch({ speakerNotice: uiText(this.target?.language)('voiceSession.unverifiedVoiceIgnored') });
          return;
        }
        if (buffered) {
          if (isVoicePlaybackEcho(result.text, this.recentSpeech.filter(item => Date.now() - item.at < 20_000).map(item => item.text))) {
            this.lastClip = undefined; this.failedText = '';
            this.patch({ speakerNotice: uiText(this.target?.language)('voiceSession.playbackEchoIgnoredKeepTalking') });
            return;
          }
          this.input?.append(result.text, result.speakerVerified === true);
          return;
        }
        await this.sendInput(result.text, epoch);
      } catch (error) {
        if (epoch === this.epoch) {
          this.inputEpoch++; this.lastClip = blob;
          // Pause a failed call instead of silently losing utterances or auto-retrying sends.
          if (this.state.mode === 'call') { this.finishingInput = false; this.patch({ muted: true }); }
          this.patch({ error: voiceError(error, uiText()('voiceSession.voice_transcription_failed')), retryAvailable: true });
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
  restart() { const mode = this.state.mode, insert = this.insertTranscript, update = this.updateTranscript; this.end(); if (mode !== 'idle') void this.start(mode, insert, update); }
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
  mute() { this.setMuted(!this.state.muted); }
  setMuted(value: boolean, remember = true) {
    if (remember) this.target?.onMicrophoneMuteChange?.(value);
    if (this.state.muted === value) return;
    this.patch({ muted: value }); if (this.realtime) this.realtime.mute(value); else this.syncCapture();
  }
  setOutputMuted(value: boolean) {
    if (this.state.outputMuted === value) return;
    if (value) this.recentSpeech = [];
    else if (this.state.speaking && this.state.spokenText) this.recentSpeech.push({ text: this.state.spokenText, at: Date.now() });
    this.patch({ outputMuted: value }); this.realtime?.setOutputMuted(value); this.player?.setOutputMuted?.(value);
  }
  private applyAudioPreferences() {
    const next = this.target?.audioPreferences?.();
    if (!next) return;
    const previous = this.appliedAudioPreferences;
    this.appliedAudioPreferences = { microphoneMuted: next.microphoneMuted, outputMuted: next.outputMuted };
    if (previous?.microphoneMuted !== next.microphoneMuted) this.setMuted(next.microphoneMuted, false);
    if (previous?.outputMuted !== next.outputMuted) this.setOutputMuted(next.outputMuted);
  }
  interrupt() {
    if (this.realtime) { this.realtime.interrupt(); this.patch({ speaking: false }); return; }
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
        if (!this.state.outputMuted) this.recentSpeech = [...this.recentSpeech.filter(item => Date.now() - item.at < 20_000), spoken].slice(-8);
        await this.player.speak(phrase, this.state.voice);
        spoken.at = Date.now();
      }
    } catch (error) { if (epoch === this.playbackEpoch) { this.speechQueue = []; this.patch({ error: voiceError(error, uiText()('voiceSession.speech_playback_failed_text_replies_remain_available')) }); } }
    finally { if (epoch === this.playbackEpoch) this.patch({ speaking: false }); }
  }
  async setVoice(voice: 'female' | 'male') {
    if (!this.api || !this.settings) return;
    const epoch = this.epoch;
    try {
      if (this.settings.engine === 'system' && !this.realtime) {
        const capabilities = await this.api.capabilities();
        if (epoch !== this.epoch) return;
        if (!capabilities.voices.some(item => item.language === this.settings!.language && item.gender === voice)) throw Error(uiText()('voiceSession.the_selected_system_voice_is_not_installed'));
      }
      const settings = await this.api.saveSettings({ ...this.settings, voice });
      if (epoch === this.epoch) { this.settings = settings; this.patch({ voice }); await this.realtime?.setVoice(voice); }
    } catch (error) { if (epoch === this.epoch) this.patch({ error: voiceError(error, uiText()('voiceSession.could_not_save_the_voice')) }); }
  }
  end(error = '') {
    clearInterval(this.refreshTimer); this.refreshTimer = undefined;
    void this.api?.setCallActive?.(false).catch(() => {});
    this.realtime?.close(); this.realtime = undefined;
    this.input?.reset(); this.input = undefined; this.finishingInput = false; this.submitting = false;
    ++this.epoch; this.interrupt(); this.capture?.close(); this.capture = undefined;
    this.dictationPreview?.close(); this.dictationPreview = undefined;
    this.player?.close(); this.player = undefined;
    for (const id of this.requests) void this.api?.cancel(id).catch(() => {});
    this.requests.clear(); this.pending = 0; this.serial = Promise.resolve(); this.lastClip = undefined; this.failedText = '';
    this.spoken.reset([]); this.recentSpeech = []; this.settingsOpen = false;
    this.sendingFirst = false; this.insertTranscript = undefined; this.updateTranscript = undefined; if (active === this) active = undefined;
    this.patch({ ...initial, error });
  }
}

/** Enrollment is explicit microphone use; avoid feeding its prompts to a live Agent. */
export function endVoiceForEnrollment() { active?.end(); }
