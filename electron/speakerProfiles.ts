import { normalizeSpeakerVector, speakerSimilarity } from './speakerEmbedding';
import { speakerVersion } from './speakerManifest';
import type { SpeakerSampleInfo, SpeakerProfileInfo } from './voiceTypes';

export const speakerLimits = { profiles: 8, samples: 8, required: 3 };
export interface SpeakerSample extends SpeakerSampleInfo { vector: number[]; fingerprint?: string }
export interface SpeakerProfile { id: string; name: string; model: string; samples: SpeakerSample[] }
export interface SpeakerLibrary { version: 2; activeProfileId?: string; profiles: SpeakerProfile[] }
export const emptySpeakerLibrary = (): SpeakerLibrary => ({ version: 2, profiles: [] });
export const speakerMean = (vectors: number[][]) => normalizeSpeakerVector(vectors[0].map((_, index) => vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length));
export const speakerProfileReady = (profile: SpeakerProfile) => profile.samples.length >= speakerLimits.required;
export function speakerProfileInfo(profile: SpeakerProfile): SpeakerProfileInfo {
  return { id: profile.id, name: profile.name, ready: speakerProfileReady(profile),
    samples: profile.samples.map(({ id, prompt, voicedSeconds, recordedAt }) => ({ id, prompt, voicedSeconds, recordedAt })) };
}
export function speakerName(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f]/.test(value)) throw Error('请输入 1–40 个字符的人员名称。');
  return value.trim();
}
export function requireSpeakerProfile(library: SpeakerLibrary, id: unknown) {
  const profile = library.profiles.find(item => item.id === id);
  if (!profile) throw Error('声纹档案不存在，请重新选择人员。');
  return profile;
}
export function checkSpeakerConsistency(samples: SpeakerSample[]) {
  if (samples.some((sample, i) => samples.slice(i + 1).some(other => speakerSimilarity(sample.vector, other.vector) < .6))) {
    throw Error('本段与该人员的其他声纹不一致。请确认录入人员，或在安静环境重录这一段。');
  }
}
/** Read old single-person profiles without rewriting or discarding them. */
export function decodeSpeakerLibrary(value: unknown): SpeakerLibrary {
  let data = value as Record<string, any>;
  if (data && data.version === undefined && Array.isArray(data.vectors) && data.vectors.length === 3) {
    data = { version: 2, activeProfileId: 'legacy-profile', profiles: [{ id: 'legacy-profile', name: '我的声纹', model: data.model,
      samples: data.vectors.map((vector: number[], i: number) => ({ id: `legacy-sample-${i}`, prompt: '', recordedAt: data.enrolledAt, vector })) }] };
  }
  if (!data || data.version !== 2 || !Array.isArray(data.profiles) || data.profiles.length > speakerLimits.profiles) throw Error();
  const profiles = data.profiles.map((profile: any): SpeakerProfile => {
    if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(profile.id) || profile.model !== speakerVersion || !Array.isArray(profile.samples) || profile.samples.length > speakerLimits.samples) throw Error();
    const samples = profile.samples.map((sample: any): SpeakerSample => {
      if (!sample || typeof sample.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(sample.id) || typeof sample.prompt !== 'string' || sample.prompt.length > 500 || typeof sample.recordedAt !== 'string' || !Number.isFinite(Date.parse(sample.recordedAt)) ||
          sample.voicedSeconds !== undefined && (!Number.isFinite(sample.voicedSeconds) || sample.voicedSeconds < 3 || sample.voicedSeconds > 21) || sample.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(sample.fingerprint)) throw Error();
      return { id: sample.id, prompt: sample.prompt, recordedAt: sample.recordedAt, voicedSeconds: sample.voicedSeconds, fingerprint: sample.fingerprint, vector: normalizeSpeakerVector(sample.vector) };
    });
    if (new Set(samples.map((sample: SpeakerSample) => sample.id)).size !== samples.length || samples.some((sample: SpeakerSample) => sample.vector.length !== samples[0].vector.length)) throw Error();
    return { id: profile.id, name: speakerName(profile.name), model: profile.model, samples };
  });
  if (new Set(profiles.map((profile: SpeakerProfile) => profile.id)).size !== profiles.length || data.activeProfileId !== undefined && !profiles.some((profile: SpeakerProfile) => profile.id === data.activeProfileId)) throw Error();
  return { version: 2, activeProfileId: data.activeProfileId, profiles };
}
