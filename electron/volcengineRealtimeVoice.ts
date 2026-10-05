import { realtimeSessionContent, type RealtimeVoiceProvider } from './realtimeVoiceProvider';
import { realtimeVoiceMessages } from './realtimeVoiceMessages';
import { realtimeVoiceCatalog } from './realtimeVoiceCatalog';

/** Seeduplex JSON protocol, not the legacy binary O/SC protocol. */
export const volcengineRealtimeVoice: RealtimeVoiceProvider = {
  ...realtimeVoiceMessages,
  endpoint: realtimeVoiceCatalog.volcengine.defaults.endpoint,
  headers: key => ({ 'X-Api-Key': key }),
  start: (settings, voice, assistant) => ({ type: 'session.create', session: {
    model: settings.model || realtimeVoiceCatalog.volcengine.defaults.model,
    ...realtimeSessionContent(settings, assistant),
    audio: { input: { format: { type: 'pcm', rate: 16000 } },
      output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: voice === 'female' ? settings.femaleVoice : settings.maleVoice, speed: 0 } },
  } }),
};
