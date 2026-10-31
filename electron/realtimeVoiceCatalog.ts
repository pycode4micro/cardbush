import type { RealtimeVoiceSettings } from './realtimeVoiceTypes';

/** Renderer-safe metadata. Credentials and adapter implementations stay in main. */
export const realtimeVoiceCatalog = {
  volcengine: {
    labelKey: 'realtimeVoice.volcengine_seeduplex' as const, apiKeyRequired: true,
    helpKey: 'realtimeVoiceSettingsPanel.audioRecentConversationAndTaskResultsAre' as const,
    endpointEditable: false, endpointPlaceholder: '',
    defaults: { model: '1.2.6.1', endpoint: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue',
      femaleVoice: 'zh_female_vv_jupiter_bigtts', maleVoice: 'zh_male_yunzhou_jupiter_bigtts' },
  },
  qwen: {
    labelKey: 'realtimeVoice.qwen' as const, apiKeyRequired: true,
    helpKey: 'realtimeVoiceSettingsPanel.qwenHelp' as const,
    endpointEditable: true, endpointPlaceholder: 'wss://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime',
    defaults: { model: 'qwen3.8-omni-flash-realtime', endpoint: '', femaleVoice: 'Tina', maleVoice: 'Raymond' },
  },
  cardbush: {
    labelKey: 'realtimeVoice.cardbush_realtime_compatible_service' as const, apiKeyRequired: false,
    helpKey: 'realtimeVoiceSettingsPanel.connectAServiceImplementingCardbushRealtimeV1' as const,
    endpointEditable: true, endpointPlaceholder: 'wss://voice.example.com/realtime',
    defaults: { model: '', endpoint: '', femaleVoice: 'female', maleVoice: 'male' },
  },
} satisfies Record<RealtimeVoiceSettings['provider'], unknown>;
