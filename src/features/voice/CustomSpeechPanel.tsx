import { useEffect, useState } from 'react';
import { defaultCustomSpeechSettings, type CustomSpeechSettings, type CustomSpeechModelInfo } from '../../../electron/voiceTypes';
import { SettingsInput, SettingsSelect } from '../settings/SettingsControls';

export function CustomSpeechPanel({ language, value, disabled, onChange, onModel, qwenOnly = false }: {
  language: 'zh' | 'en'; value?: CustomSpeechSettings; disabled: boolean;
  qwenOnly?: boolean;
  onChange: (value: CustomSpeechSettings) => void; onModel: (kind: CustomSpeechModelInfo['kind'] | null) => void;
}) {
  const zh = language === 'zh', api = window.cardbushDesktop?.voice, config = value ?? defaultCustomSpeechSettings;
  const [model, setModel] = useState<CustomSpeechModelInfo | null>(null), [error, setError] = useState('');
  const [checking, setChecking] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setModel(null); onModel(null); setError(''); setChecking(Boolean(config.directory));
    const timer = setTimeout(() => {
      if (!config.directory || !api) { setChecking(false); return; }
      void api.inspectSpeechModel(config.directory).then(result => {
        if (qwenOnly && result.kind !== 'qwen3-customvoice') throw Error(zh ? '请选择 Qwen3-TTS CustomVoice 模型目录。' : 'Choose a Qwen3-TTS CustomVoice model folder.');
        if (active) { setModel(result); onModel(result.kind); }
      }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); })
        .finally(() => { if (active) setChecking(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [api, config.directory, revision, onModel, qwenOnly, zh]);
  const update = (field: keyof CustomSpeechSettings, text: string) => onChange({ ...config, [field]: text,
    ...(field === 'directory' ? { femaleVoice: '', maleVoice: '' } : {}) });
  const choose = async (kind: 'model' | 'python') => {
    try { const selected = await api?.chooseSpeechPath(kind); if (selected) update(kind === 'model' ? 'directory' : 'pythonPath', selected); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <div className="voice-custom-model">
    <p className="voice-help">{qwenOnly
      ? zh ? '主要播报模型：Qwen3-TTS CustomVoice。选择已有模型和 Python 环境；可选安装，不预装或自动下载。男女声分别设置，使用正常语速。' : 'Primary speech model: Qwen3-TTS CustomVoice. Choose an existing model and Python environment. Installation is optional, never automatic or bundled. Configure female and male voices independently at their natural rate.'
      : zh ? '支持 Qwen3-TTS 12Hz CustomVoice 和 Kokoro sherpa-onnx 中英文目录。模型保留在原位置，不会自动下载。' : 'Supports Qwen3-TTS 12Hz CustomVoice and Kokoro sherpa-onnx Chinese/English folders. Models stay in place; nothing is downloaded automatically.'}</p>
    <div className="voice-custom-path">
      <SettingsInput label={zh ? '模型目录' : 'Model folder'} value={config.directory} disabled={disabled} onChange={text => update('directory', text)} />
      <button type="button" disabled={disabled} onClick={() => void choose('model')}>{zh ? '选择目录' : 'Browse folder'}</button>
    </div>
    <div className="voice-actions"><button type="button" disabled={disabled || checking || !config.directory} onClick={() => setRevision(v => v + 1)}>{zh ? '重新检测模型' : 'Check model again'}</button></div>
    {checking && <p className="voice-help" role="status">{zh ? '正在读取本地模型信息…' : 'Reading local model information…'}</p>}
    {error && <p className="voice-error" role="alert">{error}</p>}
    {model && <>
      <p className="voice-help" role="status">{model.name} · {model.voices.length} {zh ? '个音色' : 'voices'}</p>
      {(['female', 'male'] as const).map(gender => {
        const field = gender === 'female' ? 'femaleVoice' : 'maleVoice';
        const selected = config[field] || (gender === 'female' ? model.defaultFemaleVoice : model.defaultMaleVoice);
        return <SettingsSelect key={gender} name={`custom-speech-${gender}`} title={zh ? gender === 'female' ? '女声使用的音色' : '男声使用的音色' : gender === 'female' ? 'Female preset' : 'Male preset'}
          value={selected} disabled={disabled} onChange={text => update(field, text)}>
          {!model.voices.some(voice => voice.id === selected) && <option value={selected}>{zh ? '原音色不可用，请重新选择' : 'Saved voice unavailable; choose another'}</option>}
          {model.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
        </SettingsSelect>;
      })}
      {model.kind === 'qwen3-customvoice' ? <>
        <div className="voice-custom-path">
          <SettingsInput label={zh ? 'Python 解释器' : 'Python interpreter'} value={config.pythonPath} placeholder={model.suggestedPythonPath ?? (zh ? '选择已安装 qwen-tts 的 Python' : 'Select Python with qwen-tts installed')} disabled={disabled} onChange={text => update('pythonPath', text)} />
          <button type="button" disabled={disabled} onClick={() => void choose('python')}>{zh ? '选择 Python' : 'Browse Python'}</button>
        </div>
        <p className="voice-help">{zh ? '需在所选环境中安装 qwen-tts 和 PyTorch。目录检测不加载模型；保存并试听时检查运行依赖。首次加载可能需要等待。' : 'The selected environment needs qwen-tts and PyTorch. Folder inspection does not load the model; Save & preview checks runtime dependencies. Loading may take time.'}</p>
        {model.suggestedPythonPath && !config.pythonPath && <p className="voice-help">{zh ? '将使用检测到的环境：' : 'Detected environment: '}{model.suggestedPythonPath}</p>}
        <SettingsSelect name="custom-speech-language" title={zh ? '朗读语言' : 'Speech language'} value={config.language} disabled={disabled} onChange={text => update('language', text)}>
          <option value="Auto">{zh ? '自动' : 'Automatic'}</option><option value="Chinese">{zh ? '中文' : 'Chinese'}</option><option value="English">English</option>
        </SettingsSelect>
        <SettingsSelect name="custom-speech-device" title={zh ? '计算设备' : 'Compute device'} value={config.device} disabled={disabled} onChange={text => update('device', text)}>
          <option value="auto">{zh ? '自动选择（优先 GPU）' : 'Automatic (prefer GPU)'}</option><option value="cpu">CPU</option><option value="cuda">NVIDIA CUDA</option>
        </SettingsSelect>
        {model.supportsInstructions ? <SettingsInput label={zh ? '语气描述（可选）' : 'Delivery instructions (optional)'} value={config.instruction} disabled={disabled} placeholder={zh ? '成熟、温和、可靠，自然地说话' : 'Mature, warm and reassuring; speak naturally'} onChange={text => update('instruction', text)} />
          : <p className="voice-help">{zh ? '此模型版本不支持语气描述。' : 'This model variant does not support delivery instructions.'}</p>}
      </> : <p className="voice-help">{model.runtimeAvailable
        ? zh ? '使用已安装并校验的 Kokoro 运行组件。' : 'Uses the installed, verified Kokoro runtime.'
        : zh ? '请先安装下方的 Kokoro 可选组件，为自定义模型提供运行环境。' : 'Install the optional Kokoro component below to provide its runtime.'}</p>}
    </>}
  </div>;
}
