import { uiText } from '@cardbush/platform/i18n';
import { NativeVoiceError } from './voiceUiError';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeSpeakerVector, speakerSimilarity, SpeakerAudioUncertain, type SpeakerEmbeddingBackend } from './speakerEmbedding';
import { speakerVersion } from './speakerManifest';
import { checkSpeakerConsistency, decodeSpeakerLibrary, emptySpeakerLibrary, requireSpeakerProfile, speakerLimits, speakerMean, speakerName, speakerProfileInfo, speakerProfileReady, type SpeakerLibrary, type SpeakerSample } from './speakerProfiles';
import type { SpeakerLockStatus, SpeakerLockMode, SpeakerSampleInput } from './voiceTypes';

interface Saved { enabled: boolean; mode: SpeakerLockMode; profile?: string }
export interface SpeakerDecision { allowed: boolean; revision: number; verified?: boolean; reason?: 'rejected' | 'uncertain' }

/** Profiles and samples stay encrypted locally. Only the explicitly selected person is accepted. */
export class SpeakerLock {
  private revision = 0;
  private enrolling = false;
  constructor(private file: string, private backend: SpeakerEmbeddingBackend, private crypto: { encrypt(value: string): string; decrypt(value: string): string }, private installed: () => boolean, private uiLanguage?: () => string) {}
  private read(): Saved {
    if (!fs.existsSync(this.file)) return { enabled: false, mode: 'strict' };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof saved.enabled !== 'boolean' || !['standard', 'strict'].includes(saved.mode) || saved.profile !== undefined && typeof saved.profile !== 'string') throw Error();
      return saved;
    } catch { throw new NativeVoiceError('voiceNative.speakerConfigUnreadable'); }
  }
  private library(saved: Saved): SpeakerLibrary {
    if (!saved.profile) return emptySpeakerLibrary();
    try { return decodeSpeakerLibrary(JSON.parse(this.crypto.decrypt(saved.profile))); }
    catch { throw new NativeVoiceError('voiceNative.speakerProfileUnreadable'); }
  }
  status(): SpeakerLockStatus {
    const saved = this.read(), library = this.library(saved);
    const active = library.profiles.find(profile => profile.id === library.activeProfileId);
    return { enabled: saved.enabled, mode: saved.mode, enrolled: Boolean(active && speakerProfileReady(active)),
      enrolledAt: active?.samples.at(-1)?.recordedAt, activeProfileId: library.activeProfileId, profiles: library.profiles.map(speakerProfileInfo) };
  }
  enabled() {
    // Corrupt configuration stays locked while the settings UI remains repairable.
    try { return this.read().enabled; } catch { return true; }
  }
  private write(saved: Saved, library?: SpeakerLibrary) {
    const value = library ? { ...saved, profile: this.crypto.encrypt(JSON.stringify(library)) } : saved;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temporary, this.file); this.revision++; }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return this.status();
  }
  configure(input: { enabled: boolean; mode: SpeakerLockMode }) {
    if (typeof input?.enabled !== 'boolean' || !['standard', 'strict'].includes(input.mode)) throw new NativeVoiceError('voiceNative.speakerSettingsInvalid');
    const saved = this.read();
    if (input.enabled) {
      const library = this.library(saved), active = requireSpeakerProfile(library, library.activeProfileId);
      if (!speakerProfileReady(active)) throw new NativeVoiceError('voiceNative.speakerActiveNeedsSamples');
      if (!this.installed()) throw new NativeVoiceError('voiceNative.speakerInstallRequired');
    }
    return this.write({ ...saved, ...input });
  }
  saveProfile(input: { profileId?: string; name: string }) {
    const name = speakerName(input?.name), saved = this.read(), library = this.library(saved);
    if (input.profileId !== undefined) requireSpeakerProfile(library, input.profileId).name = name;
    else {
      if (library.profiles.length >= speakerLimits.profiles) throw new NativeVoiceError('voiceNative.speakerProfilesLimit');
      const id = randomUUID();
      library.profiles.push({ id, name, model: speakerVersion, samples: [] });
      library.activeProfileId ??= id;
    }
    return this.write(saved, library);
  }
  selectProfile(profileId: string) {
    const saved = this.read(), library = this.library(saved), profile = requireSpeakerProfile(library, profileId);
    if (!speakerProfileReady(profile)) throw new NativeVoiceError('voiceNative.speakerProfileNeedsSamples');
    library.activeProfileId = profile.id;
    return this.write(saved, library);
  }
  remove(profileId?: string) {
    // Explicit reset repairs corrupt data too. Removing one person never removes the others.
    if (profileId === undefined) {
      if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
      this.revision++; return this.status();
    }
    const saved = this.read(), library = this.library(saved);
    requireSpeakerProfile(library, profileId);
    library.profiles = library.profiles.filter(profile => profile.id !== profileId);
    if (library.activeProfileId === profileId) { library.activeProfileId = undefined; saved.enabled = false; }
    return this.write(saved, library);
  }
  removeSample(input: { profileId: string; sampleId: string }) {
    const saved = this.read(), library = this.library(saved), profile = requireSpeakerProfile(library, input?.profileId);
    if (!profile.samples.some(sample => sample.id === input.sampleId)) throw new NativeVoiceError('voiceNative.speakerSampleMissing');
    if (saved.enabled && library.activeProfileId === profile.id && profile.samples.length <= speakerLimits.required) throw new NativeVoiceError('voiceNative.speakerActiveSampleRequired');
    profile.samples = profile.samples.filter(sample => sample.id !== input.sampleId);
    return this.write(saved, library);
  }
  private async sample(audio: ArrayBuffer, prompt: string, signal: AbortSignal): Promise<SpeakerSample> {
    if (!(audio instanceof ArrayBuffer) || audio.byteLength < 44 || audio.byteLength > 640044) throw new NativeVoiceError('voiceNative.speakerSampleLength');
    if (typeof prompt !== 'string' || prompt.length > 500) throw new NativeVoiceError('voiceNative.speakerPromptLimit');
    signal.throwIfAborted();
    const result = await this.backend.extract(audio, signal);
    if (result.voicedSeconds < 3 || !result.vectors.length) throw new NativeVoiceError('voiceNative.speakerVoicedAudioRequired');
    const normalized = result.vectors.map(normalizeSpeakerVector), center = speakerMean(normalized);
    if (normalized.some(vector => speakerSimilarity(vector, center) < .6)) throw new NativeVoiceError('voiceNative.speakerSampleInconsistent');
    return { id: randomUUID(), prompt: prompt.trim(), recordedAt: new Date().toISOString(), voicedSeconds: result.voicedSeconds, vector: center,
      fingerprint: createHash('sha256').update(Buffer.from(audio)).digest('hex') };
  }
  async saveSample(input: SpeakerSampleInput, signal: AbortSignal) {
    if (this.enrolling) throw new NativeVoiceError('voiceNative.speakerVerificationBusy');
    const revision = this.revision, saved = this.read(), library = this.library(saved), profile = requireSpeakerProfile(library, input?.profileId);
    if (input.sampleId !== undefined && !profile.samples.some(sample => sample.id === input.sampleId)) throw new NativeVoiceError('voiceNative.speakerReplacementMissing');
    if (!input.sampleId && profile.samples.length >= speakerLimits.samples) throw new NativeVoiceError('voiceNative.speakerSamplesLimit');
    this.enrolling = true;
    try {
      const sample = await this.sample(input.audio, input.prompt, signal);
      const remaining = profile.samples.filter(item => item.id !== input.sampleId);
      if (remaining.some(item => item.fingerprint === sample.fingerprint)) throw new NativeVoiceError('voiceNative.speakerSampleDuplicate');
      checkSpeakerConsistency([...remaining, sample]); signal.throwIfAborted();
      if (revision !== this.revision) throw new NativeVoiceError('voiceNative.speakerSampleSettingsChanged');
      if (input.sampleId) profile.samples = profile.samples.map(item => item.id === input.sampleId ? { ...sample, id: item.id } : item);
      else profile.samples.push(sample);
      return this.write(saved, library);
    } finally { this.enrolling = false; }
  }
  /** Compatibility for the first version's atomic three-clip enrollment API. */
  async enroll(clips: ArrayBuffer[], signal: AbortSignal) {
    if (this.enrolling) throw new NativeVoiceError('voiceNative.speakerEnrollmentBusy');
    if (!Array.isArray(clips) || clips.length !== 3 || clips.some(clip => !(clip instanceof ArrayBuffer) || clip.byteLength < 44 || clip.byteLength > 640044)) throw new NativeVoiceError('voiceNative.speakerEnrollmentSampleLength');
    if (new Set(clips.map(clip => createHash('sha256').update(Buffer.from(clip)).digest('hex'))).size !== 3) throw new NativeVoiceError('voiceNative.speakerEnrollmentSamplesDistinct');
    const revision = this.revision, saved = this.read(), library = this.library(saved); this.enrolling = true;
    try {
      const samples: SpeakerSample[] = [];
      for (const clip of clips) samples.push(await this.sample(clip, '', signal));
      checkSpeakerConsistency(samples); signal.throwIfAborted();
      if (revision !== this.revision) throw new NativeVoiceError('voiceNative.speakerEnrollmentSettingsChanged');
      let active = library.profiles.find(profile => profile.id === library.activeProfileId);
      if (!active) {
        if (library.profiles.length >= speakerLimits.profiles) throw new NativeVoiceError('voiceNative.speakerProfilesLimit');
        active = { id: randomUUID(), name: uiText(this.uiLanguage?.())('voiceNative.speakerDefaultProfile'), model: speakerVersion, samples: [] };
        library.profiles.push(active); library.activeProfileId = active.id;
      }
      active.samples = samples;
      return this.write(saved, library);
    } finally { this.enrolling = false; }
  }
  current(decision: SpeakerDecision) { return decision.revision === this.revision; }
  async check(audio: ArrayBuffer, signal: AbortSignal): Promise<SpeakerDecision> {
    const saved = this.read(), revision = this.revision;
    if (!saved.enabled) return { allowed: true, revision };
    const library = this.library(saved), profile = requireSpeakerProfile(library, library.activeProfileId);
    if (!speakerProfileReady(profile)) throw new NativeVoiceError('voiceNative.speakerEnrollmentIncomplete');
    const vectors = profile.samples.map(sample => sample.vector), threshold = saved.mode === 'strict' ? .68 : .6;
    try {
      const result = await this.backend.extract(audio, signal); signal.throwIfAborted();
      const center = speakerMean(vectors);
      const allowed = result.vectors.length > 0 && result.vectors.every(raw => {
        const vector = normalizeSpeakerVector(raw);
        return speakerSimilarity(vector, center) >= threshold && vectors.filter(sample => speakerSimilarity(vector, sample) >= threshold - .05).length >= 2;
      });
      return { allowed: allowed && revision === this.revision, verified: allowed && revision === this.revision, revision, reason: allowed ? undefined : 'rejected' };
    } catch (error) {
      if (error instanceof SpeakerAudioUncertain) return { allowed: false, revision, reason: 'uncertain' };
      throw error;
    }
  }
}
