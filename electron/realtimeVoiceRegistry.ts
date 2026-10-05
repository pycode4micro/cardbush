import type { RealtimeVoiceProvider } from './realtimeVoiceProvider';
import type { RealtimeVoiceSettings } from './realtimeVoiceTypes';
import { volcengineRealtimeVoice } from './volcengineRealtimeVoice';
import { cardbushRealtimeVoice } from './cardbushRealtimeVoice';

export const realtimeVoiceProviders: Record<RealtimeVoiceSettings['provider'], RealtimeVoiceProvider> = {
  volcengine: volcengineRealtimeVoice,
  cardbush: cardbushRealtimeVoice,
};
