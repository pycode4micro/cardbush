import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { defaultRealtimeVoiceSettings, type RealtimeVoiceSettings } from '../../../electron/realtimeVoiceTypes';
import { SettingsCard, SettingsInput, SettingsSelect } from '../settings/SettingsControls';
import { realtimeVoiceCatalog } from '../../../electron/realtimeVoiceCatalog';

export function RealtimeVoiceSettingsPanel({ language }: {language:string}) {
  const api=window.cardbushDesktop?.voice?.realtime;
  const [value,setValue]=useState<RealtimeVoiceSettings>(defaultRealtimeVoiceSettings);
  const [key,setKey]=useState(''),[remove,setRemove]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  useEffect(()=>{ let live=true; void api?.settings().then(value=>{if(live){setValue(value);setLoaded(true);}}).catch(()=>{if(live)setError(uiText(language)('realtimeVoiceSettingsPanel.unableToLoadCallSettings'));}); return()=>{live=false;}; },[api,language]);
  if (!api) return null;
  const change=(patch:Partial<RealtimeVoiceSettings>)=>{setValue(current=>({...current,...patch}));setSaved(false);};
  const selectProvider=(provider:RealtimeVoiceSettings['provider'])=>{
    setValue(current=>({...current,provider,...realtimeVoiceCatalog[provider].defaults,hasApiKey:false,...current.profiles?.[provider]}));
    setKey('');setRemove(false);setSaved(false);setError('');
  };
  const save=async()=>{ setBusy(true);setError('');setSaved(false);try { setValue(await api.saveSettings({...value,...(remove?{apiKey:''}:key?{apiKey:key}:{})}));setKey('');setRemove(false);setSaved(true); }
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);} };
  return <SettingsCard title={uiText(language)('realtimeVoiceSettingsPanel.voiceCalls')} subtitle={uiText(language)('realtimeVoiceSettingsPanel.realtimeVoiceHandlesConversationYourConfiguredLocal')}>
    <SettingsSelect name="voice-call-mode" title={uiText(language)('realtimeVoiceSettingsPanel.callMode')} value={value.mode} disabled={!loaded||busy} onChange={mode=>change({mode:mode as RealtimeVoiceSettings['mode']})}>
      <option value="realtime">{uiText(language)('realtimeVoiceSettingsPanel.realtimeVoiceDefault')}</option>
      <option value="chained">{uiText(language)('realtimeVoiceSettingsPanel.transcriptionAgentSpeech')}</option>
    </SettingsSelect>
    {value.mode==='realtime'&&<>
      <SettingsSelect name="voice-realtime-provider" title={uiText(language)('realtimeVoiceSettingsPanel.voiceProvider')} value={value.provider} disabled={!loaded||busy} onChange={provider=>selectProvider(provider as RealtimeVoiceSettings['provider'])}>
        {Object.entries(realtimeVoiceCatalog).map(([id,provider])=><option key={id} value={id}>{uiText(language)(provider.labelKey)}</option>)}
      </SettingsSelect>
      <p className="voice-help">{value.provider==='volcengine' ? uiText(language)('realtimeVoiceSettingsPanel.audioRecentConversationAndTaskResultsAre') : uiText(language)('realtimeVoiceSettingsPanel.connectAServiceImplementingCardbushRealtimeV1')}</p>
      {value.provider==='cardbush'&&<SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.serviceEndpoint')} disabled={!loaded||busy} value={value.endpoint??''} onChange={endpoint=>change({endpoint,hasApiKey:false})} placeholder={uiText(language)('realtimeVoiceSettingsPanel.wss_voice_example_com_realtime')}/>}
      <SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.voiceModelId')} disabled={!loaded||busy} value={value.model??realtimeVoiceCatalog[value.provider].defaults.model} onChange={model=>change({model})}/>
      <SettingsInput label={uiText(language)('modelFormDialog.api_key')} type="password" disabled={!loaded||busy} value={key} onChange={text=>{setKey(text);setRemove(false);setSaved(false);}} placeholder={value.hasApiKey ? uiText(language)('realtimeVoiceSettingsPanel.savedLeaveBlankToKeep'):'API Key'} />
      {value.hasApiKey&&<label className="voice-help"><input type="checkbox" disabled={!loaded||busy} checked={remove} onChange={event=>{setRemove(event.target.checked);setKey('');setSaved(false);}}/>{uiText(language)('realtimeVoiceSettingsPanel.removeSavedKey')}</label>}
      <p className="voice-help">{uiText(language)('realtimeVoiceSettingsPanel.profilesAndEncryptedKeysAreStoredSeparately')}</p>
      <SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.femaleVoiceId')} disabled={!loaded||busy} value={value.femaleVoice} onChange={femaleVoice=>change({femaleVoice})}/>
      <SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.maleVoiceId')} disabled={!loaded||busy} value={value.maleVoice} onChange={maleVoice=>change({maleVoice})}/>
      <label className="voice-realtime-prompt">{uiText(language)('realtimeVoiceSettingsPanel.conversationInstructionsUpTo2000Characters')}<textarea rows={5} maxLength={2000} value={value.instructions} disabled={!loaded||busy} onChange={event=>change({instructions:event.target.value})}/></label>
      <p className="voice-help">{uiText(language)('realtimeVoiceSettingsPanel.theVoiceModelDelegatesTasksToThe')}</p>
    </>}
    {error&&<p className="voice-error" role="alert">{error}</p>}
    <div className="voice-actions"><button type="button" disabled={!loaded||busy} onClick={()=>void save()}>{busy?(uiText(language)('networkProxySettings.saving')):(uiText(language)('realtimeVoiceSettingsPanel.saveCallSettings'))}</button>{saved&&<span role="status">{uiText(language)('modelsSettingsPanel.saved')}</span>}</div>
  </SettingsCard>;
}
