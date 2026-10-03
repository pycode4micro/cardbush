/** Audio transport is local to the desktop, independent of the Agent's provider. */
export interface VoiceSettings {
  recognitionEngine: 'system' | 'sensevoice' | 'cloud';
  recognitionLanguage: 'auto' | 'zh' | 'en';
  recognitionFormatting: 'verbatim' | 'formatted';
  microphoneId: string;
  engine: 'system' | 'kokoro' | 'cloud';
  language: string;
  systemFemaleVoice: string;
  systemMaleVoice: string;
  baseUrl: string;
  transcriptionModel: string;
  speechModel: string;
  voice: 'female' | 'male';
  femaleVoice: string;
  maleVoice: string;
  speed: number;
  hasApiKey: boolean;
}
export type VoiceSettingsInput = Omit<VoiceSettings, 'hasApiKey'> & { apiKey?: string };
export const defaultVoiceSettings: VoiceSettings = {
  recognitionEngine: 'system', recognitionLanguage: 'auto', recognitionFormatting: 'verbatim', microphoneId: '',
  engine: 'system', language: 'zh-CN', systemFemaleVoice: '', systemMaleVoice: '',
  baseUrl: 'https://api.openai.com/v1', transcriptionModel: 'gpt-transcribe',
  speechModel: 'gpt-4o-mini-tts', voice: 'female', femaleVoice: 'nova', maleVoice: 'onyx',
  speed: 1, hasApiKey: false,
};
export interface VoiceAudioChunk { id: string; pcm: string; sampleRate: number }
export interface VoiceCapabilities {
  available: boolean;
  error?: string;
  voices: { id: string; name: string; language: string; gender: string }[];
  recognizers: { id: string; name: string; language: string }[];
}
export interface VoiceDesktopApi {
  modelStatus(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  installModel(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  cancelModelInstall(kind?: VoiceModelKind): Promise<void>;
  removeModel(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  settings(): Promise<VoiceSettings>;
  capabilities(): Promise<VoiceCapabilities>;
  saveSettings(input: VoiceSettingsInput): Promise<VoiceSettings>;
  transcribe(input: { id: string; audio: ArrayBuffer; mimeType: string; language?: string }): Promise<{ text: string }>;
  speak(input: { id: string; text: string; voice?: 'male' | 'female' }): Promise<void>;
  cancel(id: string): Promise<void>;
  onAudio(callback: (chunk: VoiceAudioChunk) => void): () => void;
}

export type VoiceModelKind = 'recognition' | 'speech';
export interface VoiceModelStatus {
  supported: boolean;
  state: 'not-installed' | 'downloading' | 'verifying' | 'installed' | 'error';
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
  model: string;
  version: string;
  sources: { title: string; url: string }[];
}
