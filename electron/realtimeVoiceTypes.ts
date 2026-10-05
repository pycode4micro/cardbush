/** Voice providers are transport adapters, deliberately independent of tool plugins. */
import type { RealtimeContextJob, RealtimeContextResult } from '@cardbush/bush-protocol' with { 'resolution-mode': 'import' };
export type { RealtimeContextResult };
export interface RealtimeVoiceSettings {
  mode: 'realtime' | 'chained';
  provider: 'volcengine' | 'cardbush';
  model?: string;
  endpoint?: string;
  profiles?: Partial<Record<RealtimeVoiceSettings['provider'], RealtimeVoiceConnectionProfile>>;
  instructions: string;
  femaleVoice: string;
  maleVoice: string;
  hasApiKey: boolean;
}
export interface RealtimeVoiceConnectionProfile {
  model: string; endpoint: string; femaleVoice: string; maleVoice: string; hasApiKey: boolean;
}
export const defaultRealtimeVoiceSettings: RealtimeVoiceSettings = {
  mode: 'realtime', provider: 'volcengine', hasApiKey: false,
  femaleVoice: 'zh_female_vv_jupiter_bigtts', maleVoice: 'zh_male_yunzhou_jupiter_bigtts',
  instructions: '自然交流，使用正常语速，给用户留出思考和停顿的时间。跟随用户使用中文或英文。',
};
export type RealtimeVoiceSettingsInput = Omit<RealtimeVoiceSettings, 'hasApiKey' | 'profiles'> & { apiKey?: string };
export interface RealtimeToolCall { id: string; name: string; arguments: string }
export interface RealtimeToolResult { id: string; output: string }
export type RealtimeVoiceEvent = { id: string } & (
  | { type: 'ready' | 'closed' | 'interrupted' | 'audio-start' | 'audio-end' }
  | { type: 'audio'; pcm: string; sampleRate: number }
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string; final: boolean; itemId: string }
  | { type: 'input-discarded'; itemId: string }
  | { type: 'tools'; calls: RealtimeToolCall[] }
  | { type: 'error'; message: string }
  | { type: 'context-status'; message: string }
  | { type: 'connection-state'; state: 'reconnecting' | 'paused' | 'connected'; message: string }
  | { type: 'context-compact'; job: RealtimeContextJob }
);
export interface RealtimeVoiceApi {
  settings(): Promise<RealtimeVoiceSettings>;
  saveSettings(input: RealtimeVoiceSettingsInput): Promise<RealtimeVoiceSettings>;
  start(input: { id: string; sessionId?: string; assistant?: { name: string; persona: string }; voice: 'female' | 'male'; context: { role: 'user' | 'assistant'; text: string }[] }): Promise<void>;
  audio(id: string, pcm: ArrayBuffer): Promise<void>;
  control(id: string, action: 'mute' | 'unmute' | 'interrupt' | 'commit'): Promise<void>;
  results(id: string, results: RealtimeToolResult[]): Promise<void>;
  notify(id: string, result: string): Promise<void>;
  compacted(id: string, jobId: string, result?: RealtimeContextResult): Promise<void>;
  playback(id: string, speaking: boolean): Promise<void>;
  forgetHistory(sessionId?: string): Promise<void>;
  setVoice(id: string, voice: 'female' | 'male'): Promise<void>;
  close(id: string): Promise<void>;
  onEvent(callback: (event: RealtimeVoiceEvent) => void): () => void;
}
