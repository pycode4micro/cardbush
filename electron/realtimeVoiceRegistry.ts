import type { RealtimeVoiceProvider } from './realtimeVoiceProvider';
import type { RealtimeVoiceSettings } from './realtimeVoiceTypes';
import { volcengineRealtimeVoice } from './volcengineRealtimeVoice';
import { cardbushRealtimeVoice } from './cardbushRealtimeVoice';
import { qwenRealtimeVoice } from './qwenRealtimeVoice';

export const realtimeVoiceProviders: Record<RealtimeVoiceSettings['provider'], RealtimeVoiceProvider> = {
  volcengine: volcengineRealtimeVoice,
  qwen: qwenRealtimeVoice,
  cardbush: cardbushRealtimeVoice,
};
