import type { RealtimeVoiceSettings } from './realtimeVoiceTypes';

/** Renderer-safe metadata. Credentials and adapter implementations stay in main. */
export const realtimeVoiceCatalog = {
  volcengine: {
    zh: '火山 · 豆包实时语音', en: 'Volcengine · Seeduplex', apiKeyRequired: true,
    defaults: { model: '1.2.6.1', endpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
      femaleVoice: 'zh_female_vv_jupiter_bigtts', maleVoice: 'zh_male_yunzhou_jupiter_bigtts' },
  },
  cardbush: {
    zh: 'CardBush Realtime 兼容服务', en: 'CardBush Realtime compatible service', apiKeyRequired: false,
    defaults: { model: '', endpoint: '', femaleVoice: 'female', maleVoice: 'male' },
  },
} satisfies Record<RealtimeVoiceSettings['provider'], unknown>;
