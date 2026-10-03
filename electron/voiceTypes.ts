/** Audio transport is local to the desktop, independent of the Agent's provider. */
export interface VoiceSettings {
  recognitionEngine: 'system' | 'sensevoice' | 'cloud';
  recognitionLanguage: 'auto' | 'zh' | 'en';
  recognitionFormatting: 'verbatim' | 'formatted';
  microphoneId: string;
  turnEndPause?: 'normal' | 'patient';
  engine: 'system' | 'qwen' | 'kokoro' | 'custom' | 'cloud';
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
  /** Kokoro presets from the installed v1.1-zh voice bank. */
  kokoroFemaleVoice?: number;
  kokoroMaleVoice?: number;
  kokoroStyle?: 'warm' | 'neutral';
  customSpeech?: CustomSpeechSettings;
  hasApiKey: boolean;
  /** Derived from the independent local speaker profile; not saved with model settings. */
  speakerLockEnabled?: boolean;
}
export type VoiceSettingsInput = Omit<VoiceSettings, 'hasApiKey'> & { apiKey?: string };
export const defaultVoiceSettings: VoiceSettings = {
  recognitionEngine: 'system', recognitionLanguage: 'auto', recognitionFormatting: 'verbatim', microphoneId: '',
  turnEndPause: 'normal',
  engine: 'system', language: 'zh-CN', systemFemaleVoice: '', systemMaleVoice: '',
  baseUrl: 'https://api.openai.com/v1', transcriptionModel: 'gpt-transcribe',
  speechModel: 'gpt-4o-mini-tts', voice: 'female', femaleVoice: 'nova', maleVoice: 'onyx',
  speed: 1, hasApiKey: false, kokoroFemaleVoice: 3, kokoroMaleVoice: 58, kokoroStyle: 'warm',
};
export interface VoiceAudioChunk { id: string; pcm: string; sampleRate: number }
export interface CustomSpeechSettings {
  directory: string;
  pythonPath: string;
  femaleVoice: string;
  maleVoice: string;
  language: 'Auto' | 'Chinese' | 'English';
  device: 'auto' | 'cpu' | 'cuda';
  instruction: string;
}
export const defaultCustomSpeechSettings: CustomSpeechSettings = {
  directory: '', pythonPath: '', femaleVoice: '', maleVoice: '', language: 'Auto', device: 'auto', instruction: '',
};
export const defaultQwenSpeechSettings: CustomSpeechSettings = {
  ...defaultCustomSpeechSettings,
  instruction: '用成熟、温和、可靠的语气自然地说话，正常语速，情绪细腻克制，像在认真倾听后与对方交流。',
};
export interface CustomSpeechModelInfo {
  kind: 'qwen3-customvoice' | 'kokoro';
  name: string;
  directory: string;
  voices: { id: string; name: string }[];
  defaultFemaleVoice: string;
  defaultMaleVoice: string;
  supportsInstructions: boolean;
  suggestedPythonPath?: string;
  /** Kokoro reuses the explicitly installed, verified native runtime. */
  runtimeAvailable: boolean;
}
export interface VoiceCapabilities {
  available: boolean;
  error?: string;
  voices: { id: string; name: string; language: string; gender: string }[];
  recognizers: { id: string; name: string; language: string }[];
}
export interface VoiceDesktopApi {
  chooseSpeechPath(kind: 'model' | 'python'): Promise<string | null>;
  inspectSpeechModel(directory: string): Promise<CustomSpeechModelInfo>;
  modelStatus(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  installModel(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  cancelModelInstall(kind?: VoiceModelKind): Promise<void>;
  removeModel(kind?: VoiceModelKind): Promise<VoiceModelStatus>;
  settings(): Promise<VoiceSettings>;
  capabilities(): Promise<VoiceCapabilities>;
  saveSettings(input: VoiceSettingsInput): Promise<VoiceSettings>;
  transcribe(input: { id: string; audio: ArrayBuffer; mimeType: string; language?: string }): Promise<{ text: string; speaker?: 'rejected' | 'uncertain'; speakerVerified?: boolean }>;
  speakerStatus(): Promise<SpeakerLockStatus>;
  enrollSpeaker(input: { id: string; clips: ArrayBuffer[] }): Promise<SpeakerLockStatus>;
  saveSpeakerProfile(input: { profileId?: string; name: string }): Promise<SpeakerLockStatus>;
  selectSpeakerProfile(profileId: string): Promise<SpeakerLockStatus>;
  saveSpeakerSample(input: SpeakerSampleInput): Promise<SpeakerLockStatus>;
  removeSpeakerSample(input: { profileId: string; sampleId: string }): Promise<SpeakerLockStatus>;
  configureSpeaker(input: { enabled: boolean; mode: SpeakerLockMode }): Promise<SpeakerLockStatus>;
  removeSpeaker(profileId?: string): Promise<SpeakerLockStatus>;
  speak(input: { id: string; text: string; voice?: 'male' | 'female' }): Promise<void>;
  cancel(id: string): Promise<void>;
  onAudio(callback: (chunk: VoiceAudioChunk) => void): () => void;
}

export type VoiceModelKind = 'recognition' | 'speech' | 'speaker';
export type SpeakerLockMode = 'standard' | 'strict';
export interface SpeakerSampleInfo { id: string; prompt: string; voicedSeconds?: number; recordedAt: string }
export interface SpeakerProfileInfo { id: string; name: string; ready: boolean; samples: SpeakerSampleInfo[] }
export interface SpeakerSampleInput { id: string; profileId: string; sampleId?: string; prompt: string; audio: ArrayBuffer }
export interface SpeakerLockStatus {
  enabled: boolean; mode: SpeakerLockMode; enrolled: boolean; enrolledAt?: string;
  activeProfileId?: string; profiles: SpeakerProfileInfo[];
}
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
