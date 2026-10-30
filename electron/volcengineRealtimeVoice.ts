import { realtimeSessionContent, type RealtimeVoiceProvider } from './realtimeVoiceProvider';
import { realtimeVoiceMessages } from './realtimeVoiceMessages';
import { realtimeVoiceCatalog } from './realtimeVoiceCatalog';

/** Seeduplex JSON protocol, not the legacy binary O/SC protocol. */
export const volcengineRealtimeVoice: RealtimeVoiceProvider = {
  ...realtimeVoiceMessages,
  serverAssignedContextIds: true,
  // Seeduplex documents 64K tokens including instructions/history/tools. Reserve
  // 16K for provider internals, audio and the next reply; UTF-8 bytes / 2 is conservative.
  contextPolicy: { maintenanceTokens: 48_000, maxInputBytes: 96_000, batchItems: 40 },
  endpoint: realtimeVoiceCatalog.volcengine.defaults.endpoint,
  headers: key => ({ 'X-Api-Key': key }),
  start: (settings, voice, assistant) => ({ type: 'session.create', session: {
    model: settings.model || realtimeVoiceCatalog.volcengine.defaults.model,
    ...realtimeSessionContent(settings, assistant),
    audio: { input: { format: { type: 'pcm', rate: 16000 } },
      output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: voice === 'female' ? settings.femaleVoice : settings.maleVoice, speed: 0 } },
  } }),
};
