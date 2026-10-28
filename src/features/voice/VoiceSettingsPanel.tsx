import { uiText } from '../../i18n';
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

export function VoiceSettingsPanel({ language }: { language: string }) {
  const api = window.cardbushDesktop?.voice;
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
    catch { if (alive.current) setCapabilities({ available: false, voices: [], recognizers: [], error: uiText(language)('voiceSettingsPanel.unableToDetectSystemSpeechCheckThe') }); }
  };
  useEffect(() => {
    alive.current = true;
    if (!api) { setError(uiText(language)('voiceSettingsPanel.voiceRequiresTheDesktopApplication')); return; }
    void api.settings().then(value => { if (alive.current) { setSettings(value); setLoaded(true); } }).catch(error => { if (alive.current) setError(String(error)); });
    void detect();
    const devices = () => { void navigator.mediaDevices?.enumerateDevices().then(items => { if (alive.current) setMicrophones(items.filter(item => item.kind === 'audioinput' && item.deviceId)); }).catch(() => {}); };
    devices(); navigator.mediaDevices?.addEventListener('devicechange', devices);
    return () => { alive.current = false; player.current?.close(); navigator.mediaDevices?.removeEventListener('devicechange', devices); };
  }, [api, language]);
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
    try { await playback.speak(uiText(system ? settings.language : language)('voice.previewSample'), settings.voice); }
    catch (error) { if (alive.current && player.current === playback) setError(error instanceof Error ? error.message : String(error)); }
    finally { playback.close(); if (player.current === playback) { player.current = undefined; if (alive.current) setPreview(false); } }
  };
  return <div className="settings-stack voice-settings">
    <RealtimeVoiceSettingsPanel language={language} />
    <SettingsCard title={uiText(language)('voiceSettingsPanel.speechRecognition')} subtitle={uiText(language)('voiceSettingsPanel.sendRecognizedTextToYourCurrentAgent')}>
      <SettingsSelect name="voice-microphone" title={uiText(language)('voiceSettingsPanel.microphone')} value={settings.microphoneId} disabled={!loaded || busy || preview} onChange={value => update('microphoneId', value)}>
        <option value="">{uiText(language)('voiceSettingsPanel.systemDefaultMicrophone')}</option>
        {settings.microphoneId && !microphones.some(item => item.deviceId === settings.microphoneId) && <option value={settings.microphoneId}>{uiText(language)('voiceSettingsPanel.previousMicrophoneUnavailableSelectAnother')}</option>}
        {microphones.map((item, index) => <option key={item.deviceId} value={item.deviceId}>{item.label || `${uiText(language)('voiceSettingsPanel.microphone')} ${index + 1}`}</option>)}
      </SettingsSelect>
      <SettingsSelect name="voice-turn-wait" title={uiText(language)('voiceSettingsPanel.pauseBeforeSending')} value={settings.turnEndPause ?? 'normal'} disabled={!loaded || busy || preview} onChange={value => update('turnEndPause', value)}
        subtitle={uiText(language)('voiceSettingsPanel.continuedSpeechJoinsTheSameMessageWaits')}>
        <option value="normal">{uiText(language)('voiceSettingsPanel.normal3Seconds')}</option><option value="patient">{uiText(language)('voiceSettingsPanel.patient6Seconds')}</option>
      </SettingsSelect>
      <SettingsSelect name="voice-recognition" title={uiText(language)('voiceSettingsPanel.recognizer')} value={settings.recognitionEngine} disabled={!loaded || busy || preview} onChange={value => update('recognitionEngine', value)}>
        <option value="system">{uiText(language)('voiceSettingsPanel.windowsDictation')}</option>
        <option value="sensevoice">{uiText(language)('voiceSettingsPanel.sensevoiceLocalModelRecommendedInstallationRequired')}</option>
        <option value="cloud">{uiText(language)('voiceSettingsPanel.cloudVoiceApiOptional')}</option>
      </SettingsSelect>
      {settings.recognitionEngine !== 'system' && <SettingsSelect name="voice-recognition-language" title={uiText(language)('voiceSettingsPanel.recognitionLanguage')} value={settings.recognitionLanguage} disabled={!loaded || busy || preview} onChange={value => update('recognitionLanguage', value)}>
        <option value="auto">{uiText(language)('voiceSettingsPanel.automatic')}</option><option value="zh">{uiText(language)('customSpeechPanel.chinese')}</option><option value="en">{uiText(language)('customSpeechPanel.english')}</option>
      </SettingsSelect>}
      {settings.recognitionEngine === 'sensevoice' && <SettingsSelect name="voice-recognition-format" title={uiText(language)('voiceSettingsPanel.transcriptFormatting')} subtitle={uiText(language)('voiceSettingsPanel.keepOriginalWordsForMixedLanguageSpeech')} value={settings.recognitionFormatting} disabled={!loaded || busy || preview} onChange={value => update('recognitionFormatting', value)}>
        <option value="verbatim">{uiText(language)('voiceSettingsPanel.originalWordsRecommended')}</option>
        <option value="formatted">{uiText(language)('voiceSettingsPanel.punctuationAndNumbers')}</option>
      </SettingsSelect>}
      <VoiceModelPanel language={language} disabled={!loaded || busy || preview} selected={settings.recognitionEngine === 'sensevoice'} select={() => update('recognitionEngine', 'sensevoice')} />
      {(system || settings.recognitionEngine === 'system') && <>
        {settings.recognitionEngine === 'system' && <p className="voice-help">{uiText(language)('voiceSettingsPanel.legacyWindowsOfflineDictationNeedsNoModel')}</p>}
        <SettingsSelect name="voice-language" title={uiText(language)('voiceSettingsPanel.windowsSpeechLanguage')} value={settings.language} disabled={!loaded || busy || preview} onChange={value => {
          setSettings(current => ({ ...current, language: value, systemFemaleVoice: '', systemMaleVoice: '' })); setSaved(false);
        }}>{languages.map(value => <option key={value} value={value}>{new Intl.DisplayNames(language, { type: 'language' }).of(value) ?? value}</option>)}</SettingsSelect>
        <p className="voice-help" role="status">{!capabilities ? uiText(language)('voiceSettingsPanel.detectingSystemSpeech') : !capabilities.available ? capabilities.error : uiText(language)('voiceSettingsPanel.dictationFemaleMale', { value1: (hasRecognition ? uiText(language)('voiceSettingsPanel.installed') : uiText(language)('voiceSettingsPanel.missing')), value2: (voices.some(v => v.gender === 'female') ? uiText(language)('voiceSettingsPanel.installed') : uiText(language)('voiceSettingsPanel.missing')), value3: (voices.some(v => v.gender === 'male') ? uiText(language)('voiceSettingsPanel.installed') : uiText(language)('voiceSettingsPanel.missing')) })}</p>
        {capabilities?.available && (settings.recognitionEngine === 'system' && !hasRecognition || system && !voices.some(v => v.gender === settings.voice)) && <p className="voice-help">{uiText(language)('voiceSettingsPanel.installTheSpeechComponentsInWindowsSettings')}</p>}
        <div className="voice-actions"><button type="button" disabled={!capabilities || busy} onClick={() => void detect()}>{uiText(language)('voiceSettingsPanel.detectAgain')}</button></div>
      </>}
    </SettingsCard>
    <SpeakerLockPanel language={language} microphoneId={settings.microphoneId} disabled={!loaded || busy || preview} />
    {(settings.recognitionEngine === 'cloud' || settings.engine === 'cloud') && <SettingsCard title={uiText(language)('voiceSettingsPanel.cloudVoiceApi')}>
      <p className="voice-help">{uiText(language)('voiceSettingsPanel.onlyRecordingsOrSpeechTextSelectedFor')}</p>
      <SettingsInput label={uiText(language)('voiceSettingsPanel.apiBaseUrl')} value={settings.baseUrl} disabled={!loaded || busy} onChange={value => update('baseUrl', value)} />
      <SettingsInput label={uiText(language)('modelFormDialog.api_key')} type="password" value={key} disabled={!loaded || busy} placeholder={settings.hasApiKey ? uiText(language)('voiceSettingsPanel.savedSecurelyLeaveBlankToRetain') : 'sk-…'} onChange={value => { setKey(value); setRemoveKey(false); setSaved(false); }} />
      {settings.hasApiKey && <label className="voice-key-remove"><input type="checkbox" checked={removeKey} onChange={event => { setRemoveKey(event.target.checked); setSaved(false); }} />{uiText(language)('voiceSettingsPanel.removeSavedKey')}</label>}
      <SettingsInput label={uiText(language)('voiceSettingsPanel.transcriptionModel')} value={settings.transcriptionModel} disabled={!loaded || busy} onChange={value => update('transcriptionModel', value)} />
      <SettingsInput label={uiText(language)('voiceSettingsPanel.speechModel')} value={settings.speechModel} disabled={!loaded || busy} onChange={value => update('speechModel', value)} />
      <p className="voice-help">{uiText(language)('voiceSettingsPanel.usesOpenaiCompatibleTranscriptionAndSpeechEndpoints')}</p>
    </SettingsCard>}
    <SettingsCard title={uiText(language)('voiceSettingsPanel.agentVoice')} subtitle={uiText(language)('voiceSettingsPanel.automaticSpeechOnlyDuringAVoiceCall')}>
      <SettingsSelect name="voice-engine" title={uiText(language)('voiceSettingsPanel.speechEngine')} value={settings.engine} disabled={!loaded || busy || preview} onChange={value => update('engine', value)}>
        <option value="qwen">{uiText(language)('voiceSettingsPanel.qwen3TtsRecommendedLocalModelRequired')}</option>
        <option value="system">{uiText(language)('voiceSettingsPanel.windowsLocalSpeech')}</option>
        <option value="custom">{uiText(language)('voiceSettingsPanel.customLocalModel')}</option>
        <option value="cloud">{uiText(language)('voiceSettingsPanel.cloudVoiceApiOptional')}</option>
        <option value="kokoro">{uiText(language)('voiceSettingsPanel.kokoroLegacy')}</option>
      </SettingsSelect>
      {(settings.engine === 'qwen' || settings.engine === 'custom') && <CustomSpeechPanel language={language} value={settings.customSpeech} qwenOnly={settings.engine === 'qwen'} disabled={!loaded || busy || preview} onModel={setCustomKind}
        onChange={customSpeech => { setSettings(current => ({ ...current, customSpeech })); setSaved(false); }} />}
      {(settings.engine === 'kokoro' || settings.engine === 'custom' && customKind === 'kokoro') && <VoiceModelPanel kind="speech" language={language} disabled={!loaded || busy || preview} selected select={() => update('engine', 'kokoro')} />}
      <SettingsSelect name="voice-preset" title={uiText(language)('voiceSettingsPanel.voice')} value={settings.voice} onChange={value => update('voice', value)}>
        <option value="female">{uiText(language)('voiceSettingsPanel.female')}</option><option value="male">{uiText(language)('voiceSettingsPanel.male')}</option>
      </SettingsSelect>
      {settings.engine === 'qwen' || settings.engine === 'custom' && customKind !== 'kokoro' ? <p className="voice-help">{uiText(language)('voiceSettingsPanel.qwenUsesItsNaturalSpeakingRate1')}</p> : <SettingsSelect name="voice-speed" title={uiText(language)('voiceSettingsPanel.speed')} value={String(settings.speed)} onChange={value => update('speed', Number(value))}>
        {[...new Set([.75, .9, .95, 1, 1.1, 1.25, 1.5, settings.speed])].sort((a,b) => a-b).map(value => <option key={value} value={String(value)}>{value}×{value === 1 ? uiText(language)('voiceSettingsPanel.normal') : ''}</option>)}
      </SettingsSelect>}
      {settings.engine === 'kokoro' && <>
        <SettingsSelect name="kokoro-style" title={uiText(language)('voiceSettingsPanel.delivery')} value={settings.kokoroStyle ?? 'warm'} disabled={!loaded || busy || preview} onChange={value => update('kokoroStyle', value)}
          subtitle={uiText(language)('voiceSettingsPanel.connectedDeliveryJoinsAvailableShortPhrasesPreserving')}>
          <option value="warm">{uiText(language)('voiceSettingsPanel.connectedAndNaturalRecommended')}</option><option value="neutral">{uiText(language)('voiceSettingsPanel.separateSentences')}</option>
        </SettingsSelect>
        <SettingsSelect name="kokoro-voice" title={uiText(language)('voiceSettingsPanel.localVoice')} value={String(settings.voice === 'female' ? settings.kokoroFemaleVoice ?? 3 : settings.kokoroMaleVoice ?? 58)} disabled={!loaded || busy || preview}
          subtitle={uiText(language)('voiceSettingsPanel.theseVoicesAreAlreadyInTheInstalled')}
          onChange={value => update(settings.voice === 'female' ? 'kokoroFemaleVoice' : 'kokoroMaleVoice', Number(value))}>
          {kokoroPresets[settings.voice].map((preset,index) => <option key={preset.value} value={String(preset.value)}>{(settings.voice === 'female' ? uiText(language)('voiceSettingsPanel.female') : uiText(language)('voiceSettingsPanel.male'))} {index + 1} · {preset.name}</option>)}
        </SettingsSelect>
      </>}
      {system ? <>
        {(['female', 'male'] as const).map(gender => {
          const field = gender === 'female' ? 'systemFemaleVoice' : 'systemMaleVoice';
          const available = voices.filter(voice => voice.gender === gender);
          return <SettingsSelect key={gender} name={`system-voice-${gender}`} title={(gender === 'female' ? uiText(language)('voiceSettingsPanel.systemFemaleVoice') : uiText(language)('voiceSettingsPanel.systemMaleVoice'))} value={settings[field]} disabled={!loaded || busy || preview} onChange={value => update(field, value)}>
            <option value="">{uiText(language)('voiceSettingsPanel.chooseAnInstalledVoiceAutomatically')}</option>
            {settings[field] && !available.some(voice => voice.id === settings[field]) && <option value={settings[field]}>{uiText(language)('voiceSettingsPanel.savedVoiceUnavailableChooseAnother')}</option>}
            {available.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
          </SettingsSelect>;
        })}
      </> : settings.engine === 'cloud' ? <details className="voice-advanced"><summary>{uiText(language)('voiceSettingsPanel.customVoiceIdentifiers')}</summary>
        <SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.femaleVoiceId')} value={settings.femaleVoice} onChange={value => update('femaleVoice', value)} />
        <SettingsInput label={uiText(language)('realtimeVoiceSettingsPanel.maleVoiceId')} value={settings.maleVoice} onChange={value => update('maleVoice', value)} />
      </details> : null}
      <div className="voice-actions"><button type="button" disabled={!loaded || busy} onClick={() => void save()}>{saved ? uiText(language)('modelsSettingsPanel.saved') : uiText(language)('appCenter.save')}</button>
        <button type="button" disabled={!loaded || busy} onClick={() => void audition()}>{preview ? uiText(language)('voiceSettingsPanel.stopPreview') : uiText(language)('voiceSettingsPanel.savePreview')}</button></div>
    </SettingsCard>
    {error && <p role="alert" className="voice-error">{error}</p>}
  </div>;
}
