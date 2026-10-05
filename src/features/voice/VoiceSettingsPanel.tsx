import { useEffect, useRef, useState } from 'react';
import { defaultVoiceSettings, defaultQwenSpeechSettings, type VoiceSettings, type VoiceCapabilities, type CustomSpeechModelInfo } from '../../../electron/voiceTypes';
import { SettingsCard, SettingsInput, SettingsSelect } from '../settings/SettingsControls';
import { VoicePlayback } from './voiceAudio';
import { kokoroPresets } from './kokoroPresets';
import { VoiceModelPanel } from './VoiceModelPanel';
import { SpeakerLockPanel } from './SpeakerLockPanel';
import { CustomSpeechPanel } from './CustomSpeechPanel';
import { RealtimeVoiceSettingsPanel } from './RealtimeVoiceSettingsPanel';
import './voice.css';

export function VoiceSettingsPanel({ language }: { language: 'zh' | 'en' }) {
  const zh = language === 'zh', api = window.cardbushDesktop?.voice;
  const [settings, setSettings] = useState<VoiceSettings>(defaultVoiceSettings);
  const [capabilities, setCapabilities] = useState<VoiceCapabilities | null>(null);
  const [customKind, setCustomKind] = useState<CustomSpeechModelInfo['kind'] | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [key, setKey] = useState(''), [removeKey, setRemoveKey] = useState(false);
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [preview, setPreview] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  const player = useRef<VoicePlayback | undefined>(undefined);
  const alive = useRef(true);
  const detect = async () => {
    setCapabilities(null);
    try { const result = await api?.capabilities(); if (alive.current && result) setCapabilities(result); }
    catch { if (alive.current) setCapabilities({ available: false, voices: [], recognizers: [], error: zh ? '无法检测系统语音，请检查本地语音组件。' : 'Unable to detect system speech. Check the local voice component.' }); }
  };
  useEffect(() => {
    alive.current = true;
    if (!api) { setError(zh ? '语音功能需要桌面应用支持。' : 'Voice requires the desktop application.'); return; }
    void api.settings().then(value => { if (alive.current) { setSettings(value); setLoaded(true); } }).catch(error => { if (alive.current) setError(String(error)); });
    void detect();
    const devices = () => { void navigator.mediaDevices?.enumerateDevices().then(items => { if (alive.current) setMicrophones(items.filter(item => item.kind === 'audioinput' && item.deviceId)); }).catch(() => {}); };
    devices(); navigator.mediaDevices?.addEventListener('devicechange', devices);
    return () => { alive.current = false; player.current?.close(); navigator.mediaDevices?.removeEventListener('devicechange', devices); };
  }, [api, zh]);
  const update = (field: keyof VoiceSettings, value: string | number) => {
    setSettings(current => ({ ...current, [field]: value,
      ...(field === 'engine' && value === 'qwen' ? { speed: 1, customSpeech: current.customSpeech ?? { ...defaultQwenSpeechSettings } } : {}) }));
    setSaved(false);
  };
  const system = settings.engine === 'system';
  const voices = capabilities?.voices.filter(voice => voice.language === settings.language) ?? [];
  const languages = [...new Set([settings.language, ...(capabilities?.voices.map(voice => voice.language) ?? []), ...(capabilities?.recognizers.map(item => item.language) ?? [])])];
  const hasRecognition = capabilities?.recognizers.some(item => item.language === settings.language);
  const save = async () => {
    if (!api) return false;
    setBusy(true); setError('');
    try {
      const value = await api.saveSettings({ ...settings, ...(removeKey ? { apiKey: '' } : key ? { apiKey: key } : {}) });
      if (!alive.current) return false;
      setSettings(value); setKey(''); setRemoveKey(false); setSaved(true); return true;
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { if (alive.current) setBusy(false); }
  };
  const audition = async () => {
    if (!api) return;
    if (preview) { const previous = player.current; player.current = undefined; previous?.close(); setPreview(false); return; }
    if (!await save()) return;
    setPreview(true); const playback = new VoicePlayback(api); player.current = playback;
    try { await playback.speak((system ? settings.language.startsWith('zh') : zh) ? '我在听。别着急，我们一起把这件事理清楚。你现在感觉怎么样？能迈出这一步，已经很不容易了。' : 'I am listening. Take your time. We can work through this together. How are you feeling now? Taking that first step matters.', settings.voice); }
    catch (error) { if (alive.current && player.current === playback) setError(error instanceof Error ? error.message : String(error)); }
    finally { playback.close(); if (player.current === playback) { player.current = undefined; if (alive.current) setPreview(false); } }
  };
  return <div className="settings-stack voice-settings">
    <RealtimeVoiceSettingsPanel language={language} />
    <SettingsCard title={zh ? '语音识别' : 'Speech recognition'} subtitle={zh ? '识别为文字后交给当前 Agent，独立选择识别和朗读方式。' : 'Send recognized text to your current Agent. Recognition and speech are configured independently.'}>
      <SettingsSelect name="voice-microphone" title={zh ? '麦克风' : 'Microphone'} value={settings.microphoneId} disabled={!loaded || busy || preview} onChange={value => update('microphoneId', value)}>
        <option value="">{zh ? '系统默认麦克风' : 'System default microphone'}</option>
        {settings.microphoneId && !microphones.some(item => item.deviceId === settings.microphoneId) && <option value={settings.microphoneId}>{zh ? '原麦克风不可用，请重新选择' : 'Previous microphone unavailable; select another'}</option>}
        {microphones.map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `${zh ? '麦克风' : 'Microphone'} ${index + 1}`}</option>)}
      </SettingsSelect>
      <SettingsSelect name="voice-turn-wait" title={zh ? '通话停顿等待' : 'Pause before sending'} value={settings.turnEndPause ?? 'normal'} disabled={!loaded || busy || preview} onChange={value => update('turnEndPause', value)}
        subtitle={zh ? '继续说话会合并为同一条消息；Agent 执行中至少等待 5 秒。点「说完了」可立即结束等待。' : 'Continued speech joins the same message. Waits at least 5 seconds while the Agent works. Tap Finished speaking to send sooner.'}>
        <option value="normal">{zh ? '正常 · 3 秒' : 'Normal · 3 seconds'}</option><option value="patient">{zh ? '耐心 · 6 秒' : 'Patient · 6 seconds'}</option>
      </SettingsSelect>
      <SettingsSelect name="voice-recognition" title={zh ? '识别方式' : 'Recognizer'} value={settings.recognitionEngine} disabled={!loaded || busy || preview} onChange={value => update('recognitionEngine', value)}>
        <option value="system">{zh ? 'Windows 系统听写' : 'Windows dictation'}</option>
        <option value="sensevoice">{zh ? 'SenseVoice 本地模型（推荐，需安装）' : 'SenseVoice local model (recommended, installation required)'}</option>
        <option value="cloud">{zh ? '云端语音接口（可选）' : 'Cloud voice API (optional)'}</option>
      </SettingsSelect>
      {settings.recognitionEngine !== 'system' && <SettingsSelect name="voice-recognition-language" title={zh ? '识别语言' : 'Recognition language'} value={settings.recognitionLanguage} disabled={!loaded || busy || preview} onChange={value => update('recognitionLanguage', value)}>
        <option value="auto">{zh ? '自动识别' : 'Automatic'}</option><option value="zh">{zh ? '中文' : 'Chinese'}</option><option value="en">English</option>
      </SettingsSelect>}
      {settings.recognitionEngine === 'sensevoice' && <SettingsSelect name="voice-recognition-format" title={zh ? '文字整理' : 'Transcript formatting'} subtitle={zh ? '中英混说建议保留原词，避免数字与标点整理误改英文。' : 'Keep original words for mixed-language speech; formatting can distort English words.'} value={settings.recognitionFormatting} disabled={!loaded || busy || preview} onChange={value => update('recognitionFormatting', value)}>
        <option value="verbatim">{zh ? '保留原词（推荐）' : 'Original words (recommended)'}</option>
        <option value="formatted">{zh ? '自动标点与数字' : 'Punctuation and numbers'}</option>
      </SettingsSelect>}
      <VoiceModelPanel language={language} disabled={!loaded || busy || preview} selected={settings.recognitionEngine === 'sensevoice'} select={() => update('recognitionEngine', 'sensevoice')} />
      {(system || settings.recognitionEngine === 'system') && <>
        {settings.recognitionEngine === 'system' && <p className="voice-help">{zh ? 'Windows 传统离线听写无需下载模型，但中文口语、中英混说和专有名词的准确度有限。' : 'Legacy Windows offline dictation needs no model download, but accuracy is limited for conversational speech, mixed languages and specialized terms.'}</p>}
        <SettingsSelect name="voice-language" title={zh ? 'Windows 语音语言' : 'Windows speech language'} value={settings.language} disabled={!loaded || busy || preview} onChange={value => {
          setSettings(current => ({ ...current, language: value, systemFemaleVoice: '', systemMaleVoice: '' })); setSaved(false);
        }}>{languages.map(value => <option key={value} value={value}>{value === 'zh-CN' ? zh ? '普通话（中国）' : 'Mandarin (China)' : value === 'en-US' ? zh ? '英语（美国）' : 'English (US)' : value}</option>)}</SettingsSelect>
        <p className="voice-help" role="status">{!capabilities ? zh ? '正在检测系统语音…' : 'Detecting system speech…' : !capabilities.available ? capabilities.error : zh
          ? `本地识别：${hasRecognition ? '已安装' : '未安装'} · 女声：${voices.some(v => v.gender === 'female') ? '已安装' : '未安装'} · 男声：${voices.some(v => v.gender === 'male') ? '已安装' : '未安装'}`
          : `Dictation: ${hasRecognition ? 'installed' : 'missing'} · Female: ${voices.some(v => v.gender === 'female') ? 'installed' : 'missing'} · Male: ${voices.some(v => v.gender === 'male') ? 'installed' : 'missing'}`}</p>
        {capabilities?.available && (settings.recognitionEngine === 'system' && !hasRecognition || system && !voices.some(v => v.gender === settings.voice)) && <p className="voice-help">{zh ? '可在 Windows「设置 → 时间和语言 → 语言和区域」安装对应语言的语音组件。缺失时不会自动使用云端。' : 'Install the speech components in Windows Settings → Time & language → Language & region. Missing components never trigger a cloud fallback.'}</p>}
        <div className="voice-actions"><button type="button" disabled={!capabilities || busy} onClick={() => void detect()}>{zh ? '重新检测' : 'Detect again'}</button></div>
      </>}
    </SettingsCard>
    <SpeakerLockPanel language={language} microphoneId={settings.microphoneId} disabled={!loaded || busy || preview} />
    {(settings.recognitionEngine === 'cloud' || settings.engine === 'cloud') && <SettingsCard title={zh ? '云端语音接口' : 'Cloud voice API'}>
      <p className="voice-help">{zh ? '仅选择云端处理的录音或朗读文本会发送到此服务。语音 API 独立于对话模型及 ChatGPT 登录。' : 'Only recordings or speech text selected for cloud processing are sent here. Voice credentials are separate from your conversation model and ChatGPT sign-in.'}</p>
      <SettingsInput label={zh ? 'API 根地址' : 'API base URL'} value={settings.baseUrl} disabled={!loaded || busy} onChange={value => update('baseUrl', value)} />
      <SettingsInput label="API Key" type="password" value={key} disabled={!loaded || busy} placeholder={settings.hasApiKey ? zh ? '已安全保存，留空保持不变' : 'Saved securely; leave blank to retain' : 'sk-…'} onChange={value => { setKey(value); setRemoveKey(false); setSaved(false); }} />
      {settings.hasApiKey && <label className="voice-key-remove"><input type="checkbox" checked={removeKey} onChange={event => { setRemoveKey(event.target.checked); setSaved(false); }} />{zh ? '移除已保存的密钥' : 'Remove saved key'}</label>}
      <SettingsInput label={zh ? '转写模型' : 'Transcription model'} value={settings.transcriptionModel} disabled={!loaded || busy} onChange={value => update('transcriptionModel', value)} />
      <SettingsInput label={zh ? '语音合成模型' : 'Speech model'} value={settings.speechModel} disabled={!loaded || busy} onChange={value => update('speechModel', value)} />
      <p className="voice-help">{zh ? '支持 OpenAI 兼容的录音转写和语音合成接口。服务需支持 PCM 24 kHz 音频输出；模型名称可按服务商修改。' : 'Uses OpenAI-compatible transcription and speech endpoints with PCM 24 kHz output. Model names can be changed for your provider.'}</p>
    </SettingsCard>}
    <SettingsCard title={zh ? 'Agent 的声音' : 'Agent voice'} subtitle={zh ? '仅在语音通话中自动朗读。声音由 AI 生成。' : 'Automatic speech only during a voice call. Voices are AI-generated.'}>
      <SettingsSelect name="voice-engine" title={zh ? '朗读方式' : 'Speech engine'} value={settings.engine} disabled={!loaded || busy || preview} onChange={value => update('engine', value)}>
        <option value="qwen">{zh ? 'Qwen3-TTS（推荐，需本地模型）' : 'Qwen3-TTS (recommended, local model required)'}</option>
        <option value="system">{zh ? 'Windows 本地语音' : 'Windows local speech'}</option>
        <option value="custom">{zh ? '自定义本地模型' : 'Custom local model'}</option>
        <option value="cloud">{zh ? '云端语音接口（可选）' : 'Cloud voice API (optional)'}</option>
        <option value="kokoro">{zh ? 'Kokoro（旧版兼容）' : 'Kokoro (legacy)'}</option>
      </SettingsSelect>
      {(settings.engine === 'qwen' || settings.engine === 'custom') && <CustomSpeechPanel language={language} value={settings.customSpeech} qwenOnly={settings.engine === 'qwen'} disabled={!loaded || busy || preview} onModel={setCustomKind}
        onChange={customSpeech => { setSettings(current => ({ ...current, customSpeech })); setSaved(false); }} />}
      {(settings.engine === 'kokoro' || settings.engine === 'custom' && customKind === 'kokoro') && <VoiceModelPanel kind="speech" language={language} disabled={!loaded || busy || preview} selected select={() => update('engine', 'kokoro')} />}
      <SettingsSelect name="voice-preset" title={zh ? '音色' : 'Voice'} value={settings.voice} onChange={value => update('voice', value)}>
        <option value="female">{zh ? '女声' : 'Female'}</option><option value="male">{zh ? '男声' : 'Male'}</option>
      </SettingsSelect>
      {settings.engine === 'qwen' || settings.engine === 'custom' && customKind !== 'kokoro' ? <p className="voice-help">{zh ? 'Qwen 使用模型自然语速（1×），不进行播放加速。' : 'Qwen uses its natural speaking rate (1×), without playback acceleration.'}</p> : <SettingsSelect name="voice-speed" title={zh ? '语速' : 'Speed'} value={String(settings.speed)} onChange={value => update('speed', Number(value))}>
        {[...new Set([.75, .9, .95, 1, 1.1, 1.25, 1.5, settings.speed])].sort((a,b) => a-b).map(value => <option key={value} value={String(value)}>{value}×{value === 1 ? zh ? ' · 正常' : ' · Normal' : ''}</option>)}
      </SettingsSelect>}
      {settings.engine === 'kokoro' && <>
        <SettingsSelect name="kokoro-style" title={zh ? '说话节奏' : 'Delivery'} value={settings.kokoroStyle ?? 'warm'} disabled={!loaded || busy || preview} onChange={value => update('kokoroStyle', value)}
          subtitle={zh ? '连贯自然会衔接已经生成的短句，保留正常语速和音色起伏；男女声均适用。' : 'Connected delivery joins available short phrases, preserving the selected speed and the voice’s natural inflection.'}>
          <option value="warm">{zh ? '连贯自然（推荐）' : 'Connected and natural (recommended)'}</option><option value="neutral">{zh ? '逐句朗读' : 'Separate sentences'}</option>
        </SettingsSelect>
        <SettingsSelect name="kokoro-voice" title={zh ? '本地音色' : 'Local voice'} value={String(settings.voice === 'female' ? settings.kokoroFemaleVoice ?? 3 : settings.kokoroMaleVoice ?? 58)} disabled={!loaded || busy || preview}
          subtitle={zh ? '同一模型内的音色无需另行下载，可保存并试听，选择更符合你偏好的声音。' : 'These voices are already in the installed model. Save and preview to choose your preferred timbre.'}
          onChange={value => update(settings.voice === 'female' ? 'kokoroFemaleVoice' : 'kokoroMaleVoice', Number(value))}>
          {kokoroPresets[settings.voice].map((preset,index) => <option key={preset.value} value={String(preset.value)}>{zh ? settings.voice === 'female' ? '女声' : '男声' : settings.voice === 'female' ? 'Female' : 'Male'} {index + 1} · {preset.name}</option>)}
        </SettingsSelect>
      </>}
      {system ? <>
        {(['female', 'male'] as const).map(gender => {
          const field = gender === 'female' ? 'systemFemaleVoice' : 'systemMaleVoice';
          const available = voices.filter(voice => voice.gender === gender);
          return <SettingsSelect key={gender} name={`system-voice-${gender}`} title={zh ? gender === 'female' ? '系统女声' : '系统男声' : gender === 'female' ? 'System female voice' : 'System male voice'} value={settings[field]} disabled={!loaded || busy || preview} onChange={value => update(field, value)}>
            <option value="">{zh ? '自动选择已安装音色' : 'Choose an installed voice automatically'}</option>
            {settings[field] && !available.some(voice => voice.id === settings[field]) && <option value={settings[field]}>{zh ? '原音色已不可用，请重新选择' : 'Saved voice unavailable; choose another'}</option>}
            {available.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </SettingsSelect>;
        })}
      </> : settings.engine === 'cloud' ? <details className="voice-advanced"><summary>{zh ? '自定义音色标识' : 'Custom voice identifiers'}</summary>
        <SettingsInput label={zh ? '女声音色 ID' : 'Female voice ID'} value={settings.femaleVoice} onChange={value => update('femaleVoice', value)} />
        <SettingsInput label={zh ? '男声音色 ID' : 'Male voice ID'} value={settings.maleVoice} onChange={value => update('maleVoice', value)} />
      </details> : null}
      <div className="voice-actions"><button type="button" disabled={!loaded || busy} onClick={() => void save()}>{saved ? zh ? '已保存' : 'Saved' : zh ? '保存' : 'Save'}</button>
        <button type="button" disabled={!loaded || busy} onClick={() => void audition()}>{preview ? zh ? '停止试听' : 'Stop preview' : zh ? '保存并试听' : 'Save & preview'}</button></div>
    </SettingsCard>
    {error && <p role="alert" className="voice-error">{error}</p>}
  </div>;
}
