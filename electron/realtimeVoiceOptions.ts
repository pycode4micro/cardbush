import type { RealtimeVoiceSettings } from './realtimeVoiceTypes';
import type { MessageKey } from '@cardbush/platform/i18n';

export interface RealtimeVoiceOption { id: string; name?: string; labelKey?: MessageKey }
// Verified provider catalogs: docs/REALTIME_VOICE.md links to both sources.
const presets: Record<RealtimeVoiceSettings['provider'], RealtimeVoiceOption[]> = {
  volcengine: [
    {id:'zh_female_vv_jupiter_bigtts',labelKey:'realtimeVoiceOptions.vv'},
    {id:'zh_male_yunzhou_jupiter_bigtts',labelKey:'realtimeVoiceOptions.yunzhou'},
    {id:'zh_female_vv_uranus_bigtts',labelKey:'realtimeVoiceOptions.vivi2'},
    {id:'zh_female_xiaohe_uranus_bigtts',labelKey:'realtimeVoiceOptions.xiaohe2'},
    {id:'zh_male_m191_uranus_bigtts',labelKey:'realtimeVoiceOptions.yunzhou2'},
    {id:'zh_male_taocheng_uranus_bigtts',labelKey:'realtimeVoiceOptions.xiaotian2'},
  ],
  qwen: [
    {id:'Tina',labelKey:'realtimeVoiceOptions.tina'},
    {id:'Raymond',labelKey:'realtimeVoiceOptions.raymond'},
    {id:'Cindy',name:'Cindy'},
    {id:'Theo Calm',name:'Theo Calm'},
  ],
  cardbush: [{id:'female',labelKey:'voiceSettingsPanel.female'},{id:'male',labelKey:'voiceSettingsPanel.male'}],
};
export const validRealtimeVoiceId = (id: unknown): id is string => typeof id==='string' && id===id.trim() && /^[a-zA-Z0-9_.: -]{1,200}$/.test(id) && !!id.trim();
export function realtimeVoiceId(settings: Pick<RealtimeVoiceSettings,'voiceId'|'femaleVoice'|'maleVoice'>, selection?: string) {
  if(selection && selection===settings.voiceId)return selection;
  return selection === 'female' ? settings.femaleVoice : selection === 'male' ? settings.maleVoice : selection || settings.voiceId || settings.femaleVoice;
}
export function realtimeVoiceOptions(settings: Pick<RealtimeVoiceSettings,'provider'|'femaleVoice'|'maleVoice'|'voiceId'|'customVoices'>): RealtimeVoiceOption[] {
  const choices = new Map(presets[settings.provider].map(option=>[option.id,option]));
  for (const id of [settings.femaleVoice,settings.maleVoice,settings.voiceId]) if(id && !choices.has(id)) choices.set(id,{id,name:id});
  for (const option of settings.customVoices ?? []) choices.set(option.id,option);
  return [...choices.values()];
}
