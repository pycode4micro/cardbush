import { realtimeSessionContent, type RealtimeVoiceProvider } from './realtimeVoiceProvider';
import { realtimeVoiceMessages } from './realtimeVoiceMessages';

export const CARDBUSH_REALTIME_PROTOCOL = 'cardbush.realtime.v1';
/** A provider-neutral bridge. The server adapts its model's native wire protocol. */
export const cardbushRealtimeVoice: RealtimeVoiceProvider = {
  ...realtimeVoiceMessages,
  endpoint: settings => settings.endpoint!,
  headers: (key): Record<string, string> => key ? { Authorization: `Bearer ${key}` } : {},
  start: (settings, voice, assistant) => ({ type: 'session.create', protocol: CARDBUSH_REALTIME_PROTOCOL, session: {
    model: settings.model, ...realtimeSessionContent(settings, assistant),
    audio: { input: { format: { type: 'pcm', rate: 16000 } },
      output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: voice === 'female' ? settings.femaleVoice : settings.maleVoice } },
  } }),
  normalize: event => {
    if (event.type === 'session.created' && event.protocol !== CARDBUSH_REALTIME_PROTOCOL) throw Error('Unsupported realtime bridge protocol.');
    return event;
  },
};
