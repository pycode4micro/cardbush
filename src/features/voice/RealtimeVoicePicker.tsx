import { useId, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { uiText } from '../../i18n';
import type { RealtimeVoiceSettings, RealtimeCustomVoice } from '../../../electron/realtimeVoiceTypes';
import { realtimeVoiceId, realtimeVoiceOptions, validRealtimeVoiceId } from '../../../electron/realtimeVoiceOptions';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import './realtimeVoicePicker.css';

export function RealtimeVoicePicker({value,language,compact=false,disabled=false,onChange}: {
  value: RealtimeVoiceSettings; language: string; compact?: boolean; disabled?: boolean;
  onChange(voiceId: string, customVoices?: RealtimeCustomVoice[]): void | Promise<void>;
}) {
  const t=uiText(language), heading=useId(), dialog=useRef<HTMLDialogElement>(null);
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [name,setName]=useState(''), [id,setId]=useState('');
  const choices=realtimeVoiceOptions(value), selected=realtimeVoiceId(value);
  const options=choices.map(option=>({value:option.id,label:option.labelKey?t(option.labelKey):option.name||option.id,description:option.id}));
  const close=()=>{dialog.current?.close();setError('');};
  const change=async(voiceId:string,customVoices?:RealtimeCustomVoice[])=>{
    setBusy(true);setError('');
    try {await onChange(voiceId,customVoices);close();}
    catch(error){setError(error instanceof Error?error.message:t('voiceSession.could_not_save_the_voice'));}
    finally{setBusy(false);}
  };
  return <div className="realtime-voice-picker" data-compact={compact}>
    {!compact&&<span>{t('realtimeVoiceOptions.voice')}</span>}
    <div className="realtime-voice-choice" title={t('realtimeVoiceOptions.changeHint')}>
      <SettingsDropdown label={t('realtimeVoiceOptions.voice')} value={selected} disabled={disabled||busy} options={[
        ...options,{value:'\0add',label:t('realtimeVoiceOptions.add'),icon:<Plus aria-hidden="true"/>},
      ]} onChange={voiceId=>{
        if(voiceId==='\0add'){setName('');setId('');setError('');dialog.current?.showModal();}
        else void change(voiceId);
      }}/>
    </div>
    {error&&!dialog.current?.open&&<span className="voice-error" role="alert">{error}</span>}
    <dialog ref={dialog} className="realtime-voice-dialog" aria-labelledby={heading} onCancel={()=>setError('')}>
      <form onSubmit={event=>{
        event.preventDefault();
        const voiceId=id.trim(), voiceName=name.trim();
        if(!validRealtimeVoiceId(voiceId)){setError(t('realtimeVoiceOptions.invalid'));return;}
        const customVoices=[...(value.customVoices??[]).filter(v=>v.id!==voiceId),{id:voiceId,name:voiceName}];
        if(customVoices.length>24){setError(t('realtimeVoiceOptions.invalid'));return;}
        void change(voiceId,customVoices);
      }}>
        <header><strong id={heading}>{t('realtimeVoiceOptions.add')}</strong><button type="button" className="realtime-voice-dialog-close" aria-label={t('common.close')} onClick={close}><X/></button></header>
        <p>{t('realtimeVoiceOptions.customHelp')}</p>
        <label>{t('realtimeVoiceOptions.name')}<input value={name} maxLength={80} onChange={event=>setName(event.target.value)} disabled={busy} autoFocus/></label>
        <label>{t('realtimeVoiceOptions.id')}<input value={id} maxLength={200} onChange={event=>setId(event.target.value)} disabled={busy} required spellCheck={false}/></label>
        {error&&<p className="voice-error" role="alert">{error}</p>}
        <footer><button type="button" disabled={busy} onClick={close}>{t('agentConnectionForm.cancel')}</button><button type="submit" disabled={busy||!id.trim()}>{t('realtimeVoiceOptions.addAndUse')}</button></footer>
      </form>
    </dialog>
  </div>;
}
