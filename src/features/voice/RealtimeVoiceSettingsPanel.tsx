import { useEffect, useState } from 'react';
import { defaultRealtimeVoiceSettings, type RealtimeVoiceSettings } from '../../../electron/realtimeVoiceTypes';
import { SettingsCard, SettingsInput, SettingsSelect } from '../settings/SettingsControls';
import { realtimeVoiceCatalog } from '../../../electron/realtimeVoiceCatalog';

export function RealtimeVoiceSettingsPanel({ language }: {language:'zh'|'en'}) {
  const zh=language==='zh', api=window.cardbushDesktop?.voice?.realtime;
  const [value,setValue]=useState<RealtimeVoiceSettings>(defaultRealtimeVoiceSettings);
  const [key,setKey]=useState(''),[remove,setRemove]=useState(false),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
  useEffect(()=>{ let live=true; void api?.settings().then(value=>{if(live){setValue(value);setLoaded(true);}}).catch(()=>{if(live)setError(zh?'无法读取通话设置。':'Unable to load call settings.');}); return()=>{live=false;}; },[api,zh]);
  if (!api) return null;
  const change=(patch:Partial<RealtimeVoiceSettings>)=>{setValue(current=>({...current,...patch}));setSaved(false);};
  const selectProvider=(provider:RealtimeVoiceSettings['provider'])=>{
    setValue(current=>({...current,provider,...realtimeVoiceCatalog[provider].defaults,hasApiKey:false,...current.profiles?.[provider]}));
    setKey('');setRemove(false);setSaved(false);setError('');
  };
  const save=async()=>{ setBusy(true);setError('');setSaved(false);try { setValue(await api.saveSettings({...value,...(remove?{apiKey:''}:key?{apiKey:key}:{})}));setKey('');setRemove(false);setSaved(true); }
    catch(error){setError(error instanceof Error?error.message:String(error));}finally{setBusy(false);} };
  return <SettingsCard title={zh?'语音通话':'Voice calls'} subtitle={zh?'实时语音负责交流，当前配置的本地 Agent 负责执行任务。录音发送仍使用下方的转写设置。':'Realtime voice handles conversation; your configured local Agent executes tasks. Voice messages still use transcription below.'}>
    <SettingsSelect name="voice-call-mode" title={zh?'通话模式':'Call mode'} value={value.mode} disabled={!loaded||busy} onChange={mode=>change({mode:mode as RealtimeVoiceSettings['mode']})}>
      <option value="realtime">{zh?'实时语音（默认）':'Realtime voice (default)'}</option>
      <option value="chained">{zh?'转写 + Agent + 朗读':'Transcription + Agent + speech'}</option>
    </SettingsSelect>
    {value.mode==='realtime'&&<>
      <SettingsSelect name="voice-realtime-provider" title={zh?'语音服务':'Voice provider'} value={value.provider} disabled={!loaded||busy} onChange={provider=>selectProvider(provider as RealtimeVoiceSettings['provider'])}>
        {Object.entries(realtimeVoiceCatalog).map(([id,provider])=><option key={id} value={id}>{provider[language]}</option>)}
      </SettingsSelect>
      <p className="voice-help">{value.provider==='volcengine' ? zh?'音频、近期对话和任务结果会发送到火山。使用豆包语音 API Key，需开通全双工服务。':'Audio, recent conversation and task results are sent to Volcengine. A Doubao Voice API Key with full-duplex access is required.' : zh?'接入实现 cardbush.realtime.v1 的服务；不能直接填写任意厂商 API 地址。音频、近期对话和任务结果会发送到此服务。本机服务可不填密钥。':'Connect a service implementing cardbush.realtime.v1, not an arbitrary vendor API. Audio, recent conversation and task results are sent there. A local service may not require a key.'}</p>
      {value.provider==='cardbush'&&<SettingsInput label={zh?'服务地址':'Service endpoint'} disabled={!loaded||busy} value={value.endpoint??''} onChange={endpoint=>change({endpoint,hasApiKey:false})} placeholder="wss://voice.example.com/realtime"/>}
      <SettingsInput label={zh?'语音模型 ID':'Voice model ID'} disabled={!loaded||busy} value={value.model??realtimeVoiceCatalog[value.provider].defaults.model} onChange={model=>change({model})}/>
      <SettingsInput label="API Key" type="password" disabled={!loaded||busy} value={key} onChange={text=>{setKey(text);setRemove(false);setSaved(false);}} placeholder={value.hasApiKey ? zh?'已保存；留空保留原密钥':'Saved; leave blank to keep':'API Key'} />
      {value.hasApiKey&&<label className="voice-help"><input type="checkbox" disabled={!loaded||busy} checked={remove} onChange={event=>{setRemove(event.target.checked);setKey('');setSaved(false);}}/>{zh?'删除已保存的密钥':'Remove saved key'}</label>}
      <p className="voice-help">{zh?'每个服务分别保存配置与加密密钥；更换服务地址需要重新填写密钥。切换在下次通话生效，当前通话保持连接。':'Profiles and encrypted keys are stored separately. Changing the endpoint requires a new key. Switching applies to the next call; the current call stays connected.'}</p>
      <SettingsInput label={zh?'女声音色 ID':'Female voice ID'} disabled={!loaded||busy} value={value.femaleVoice} onChange={femaleVoice=>change({femaleVoice})}/>
      <SettingsInput label={zh?'男声音色 ID':'Male voice ID'} disabled={!loaded||busy} value={value.maleVoice} onChange={maleVoice=>change({maleVoice})}/>
      <label className="voice-realtime-prompt">{zh?'通话提示词（最多 2000 字符）':'Conversation instructions (up to 2000 characters)'}<textarea rows={5} maxLength={2000} value={value.instructions} disabled={!loaded||busy} onChange={event=>change({instructions:event.target.value})}/></label>
      <p className="voice-help">{zh?'语音模型直接将任务交给本地 Agent，执行期间可继续交流，沿用 Agent 原有权限设置。挂断不会取消已启动任务。实时通话不支持声纹锁定，开始前请关闭锁定；需要声纹时可使用「转写 + Agent + 朗读」。设置在下次通话生效。':'The voice model delegates tasks to the local Agent with its existing permissions. Keep talking while it works; hanging up keeps tasks running. Realtime calls do not support voice lock. Disable it before starting, or choose Transcription + Agent + speech to use voice lock. Settings apply to the next call.'}</p>
    </>}
    {error&&<p className="voice-error" role="alert">{error}</p>}
    <div className="voice-actions"><button type="button" disabled={!loaded||busy} onClick={()=>void save()}>{busy?(zh?'正在保存…':'Saving…'):(zh?'保存通话设置':'Save call settings')}</button>{saved&&<span role="status">{zh?'已保存':'Saved'}</span>}</div>
  </SettingsCard>;
}
