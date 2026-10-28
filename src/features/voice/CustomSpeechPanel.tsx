import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import { defaultCustomSpeechSettings, type CustomSpeechSettings, type CustomSpeechModelInfo } from '../../../electron/voiceTypes';
import { SettingsInput, SettingsSelect } from '../settings/SettingsControls';

export function CustomSpeechPanel({ language, value, disabled, onChange, onModel, qwenOnly = false }: {
  language: string; value?: CustomSpeechSettings; disabled: boolean;
  qwenOnly?: boolean;
  onChange: (value: CustomSpeechSettings) => void; onModel: (kind: CustomSpeechModelInfo['kind'] | null) => void;
}) {
  const api = window.cardbushDesktop?.voice, config = value ?? defaultCustomSpeechSettings;
  const [model, setModel] = useState<CustomSpeechModelInfo | null>(null), [error, setError] = useState('');
  const [checking, setChecking] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setModel(null); onModel(null); setError(''); setChecking(Boolean(config.directory));
    const timer = setTimeout(() => {
      if (!config.directory || !api) { setChecking(false); return; }
      void api.inspectSpeechModel(config.directory).then(result => {
        if (qwenOnly && result.kind !== 'qwen3-customvoice') throw Error(uiText(language)('customSpeechPanel.chooseAQwen3TtsCustomvoiceModelFolder'));
        if (active) { setModel(result); onModel(result.kind); }
      }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (active) setChecking(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [api, config.directory, revision, onModel, qwenOnly, language]);
  const update = (field: keyof CustomSpeechSettings, text: string) => onChange({ ...config, [field]: text,
    ...(field === 'directory' ? { femaleVoice: '', maleVoice: '' } : {}) });
  const choose = async (kind: 'model' | 'python') => {
    try { const selected = await api?.chooseSpeechPath(kind); if (selected) update(kind === 'model' ? 'directory' : 'pythonPath', selected); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="voice-custom-model">
    <p className="voice-help">{qwenOnly
      ? uiText(language)('customSpeechPanel.primarySpeechModelQwen3TtsCustomvoiceChoose')
      : uiText(language)('customSpeechPanel.supportsQwen3Tts12hzCustomvoiceAndKokoro')}</p>
    <div className="voice-custom-path">
      <SettingsInput label={uiText(language)('customSpeechPanel.modelFolder')} value={config.directory} disabled={disabled} onChange={text => update('directory', text)} />
      <button type="button" disabled={disabled} onClick={() => void choose('model')}>{uiText(language)('customSpeechPanel.browseFolder')}</button>
    </div>
    <div className="voice-actions"><button type="button" disabled={disabled || checking || !config.directory} onClick={() => setRevision(v => v + 1)}>{uiText(language)('customSpeechPanel.checkModelAgain')}</button></div>
    {checking && <p className="voice-help" role="status">{uiText(language)('customSpeechPanel.readingLocalModelInformation')}</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
    {model && <>
      <p className="voice-help" role="status">{model.name} · {model.voices.length} {uiText(language)('customSpeechPanel.voices')}</p>
      {(['female', 'male'] as const).map(gender => {
        const field = gender === 'female' ? 'femaleVoice' : 'maleVoice';
        const selected = config[field] || (gender === 'female' ? model.defaultFemaleVoice : model.defaultMaleVoice);
        return <SettingsSelect key={gender} name={`custom-speech-${gender}`} title={(gender === 'female' ? uiText(language)('customSpeechPanel.femalePreset') : uiText(language)('customSpeechPanel.malePreset'))}
          value={selected} disabled={disabled} onChange={text => update(field, text)}>
          {!model.voices.some(voice => voice.id === selected) && <option value={selected}>{uiText(language)('customSpeechPanel.savedVoiceUnavailableChooseAnother')}</option>}
          {model.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
        </SettingsSelect>;
      })}
      {model.kind === 'qwen3-customvoice' ? <>
        <div className="voice-custom-path">
          <SettingsInput label={uiText(language)('customSpeechPanel.pythonInterpreter')} value={config.pythonPath} placeholder={model.suggestedPythonPath ?? (uiText(language)('customSpeechPanel.selectPythonWithQwenTtsInstalled'))} disabled={disabled} onChange={text => update('pythonPath', text)} />
          <button type="button" disabled={disabled} onClick={() => void choose('python')}>{uiText(language)('customSpeechPanel.browsePython')}</button>
        </div>
        <p className="voice-help">{uiText(language)('customSpeechPanel.theSelectedEnvironmentNeedsQwenTtsAnd')}</p>
        {model.suggestedPythonPath && !config.pythonPath && <p className="voice-help">{uiText(language)('customSpeechPanel.detectedEnvironment')}{model.suggestedPythonPath}</p>}
        <SettingsSelect name="custom-speech-language" title={uiText(language)('customSpeechPanel.speechLanguage')} value={config.language} disabled={disabled} onChange={text => update('language', text)}>
          <option value="Auto">{uiText(language)('customSpeechPanel.automatic')}</option><option value="Chinese">{uiText(language)('customSpeechPanel.chinese')}</option><option value="English">{uiText(language)('customSpeechPanel.english')}</option>
        </SettingsSelect>
        <SettingsSelect name="custom-speech-device" title={uiText(language)('customSpeechPanel.computeDevice')} value={config.device} disabled={disabled} onChange={text => update('device', text)}>
          <option value="auto">{uiText(language)('customSpeechPanel.automaticPreferGpu')}</option><option value="cpu">{uiText(language)('customSpeechPanel.cpu')}</option><option value="cuda">{uiText(language)('customSpeechPanel.nvidia_cuda')}</option>
        </SettingsSelect>
        {model.supportsInstructions ? <SettingsInput label={uiText(language)('customSpeechPanel.deliveryInstructionsOptional')} value={config.instruction} disabled={disabled} placeholder={uiText(language)('customSpeechPanel.matureWarmAndReassuringSpeakNaturally')} onChange={text => update('instruction', text)} />
          : <p className="voice-help">{uiText(language)('customSpeechPanel.thisModelVariantDoesNotSupportDelivery')}</p>}
      </> : <p className="voice-help">{model.runtimeAvailable
        ? uiText(language)('customSpeechPanel.usesTheInstalledVerifiedKokoroRuntime')
        : uiText(language)('customSpeechPanel.installTheOptionalKokoroComponentBelowTo')}</p>}
    </>}
  </div>;
}
