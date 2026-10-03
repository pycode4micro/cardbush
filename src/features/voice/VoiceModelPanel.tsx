import { useEffect, useState } from 'react';
import type { VoiceModelStatus, VoiceModelKind } from '../../../electron/voiceTypes';
import { voiceError } from './voiceError';

export function VoiceModelPanel({ language, selected, disabled, select, kind = 'recognition' }: { kind?: VoiceModelKind; language: 'zh' | 'en'; selected: boolean; disabled: boolean; select(): void }) {
  const api = window.cardbushDesktop?.voice, zh = language === 'zh', speech = kind === 'speech', speaker = kind === 'speaker';
  const [status, setStatus] = useState<VoiceModelStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await api?.modelStatus(kind);
        if (alive) { setStatus(value); if (busy || value && ['downloading', 'verifying'].includes(value.state)) timer = setTimeout(read, 500); }
      } catch (error) { if (alive) setError(voiceError(error, '无法读取本地模型状态。')); }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [api, busy, kind]);
  const perform = async (action: 'install' | 'remove' | 'cancel') => {
    if (!api) return;
    setError(''); setBusy(true);
    try {
      if (action === 'cancel') await api.cancelModelInstall(kind);
      else if (action === 'remove') await api.removeModel(kind);
      else await api.installModel(kind);
      setStatus(await api.modelStatus(kind));
    } catch (error) { setError(voiceError(error, zh ? '本地模型操作失败。' : 'Local model operation failed.')); }
    finally { setBusy(false); }
  };
  const installing = status && ['downloading', 'verifying'].includes(status.state);
  return <div className="voice-model-panel">
    <strong>{speaker ? 'CAMPPlus' : speech ? 'Kokoro v1.1' : 'SenseVoice Small'} <span className="voice-help">{speaker ? zh ? '声纹验证 · 可选安装' : 'Speaker verification · Optional' : speech ? zh ? '自然音色 · 可选安装' : 'Neural voices · Optional' : zh ? '推荐 · 可选安装' : 'Recommended · Optional'}</span></strong>
    <p className="voice-help">{speaker ? zh ? '在本机比较说话人与已录入声纹。未通过的音频不转写、不发送，也不打断播报。由 3D-Speaker 提供模型，使用 sherpa-onnx；不预装、不自动下载。' : 'Compare speech with your enrolled voice locally. Unverified audio is not transcribed, sent or allowed to interrupt playback. Model by 3D-Speaker, using sherpa-onnx; no automatic download.' : speech ? zh ? '中英文神经语音，提供男声和女声。CPU 合成比系统语音慢，适合更看重音色的场景；不提供情绪指令控制。不会预装或自动下载。' : 'Chinese and English neural voices, female and male. CPU synthesis is slower than system speech. No emotion instruction control; no automatic download.' : zh ? '中英文离线识别。由 FunAudioLLM 提供模型，sherpa-onnx 官方发布提供转换模型及运行库。不会预装或自动下载。' : 'Offline Chinese and English recognition. Model by FunAudioLLM; converted model and runtime from official sherpa-onnx releases. Never preinstalled or downloaded automatically.'}</p>
    <p className="voice-help">{status ? zh ? `下载约 ${Math.ceil(status.totalBytes / 1e6)} MB，安装后约 ${speaker ? 50 : speech ? 236 : 260} MB。下载完成会校验 SHA-256，安装不会自动切换语音方式。` : `About ${Math.ceil(status.totalBytes / 1e6)} MB to download, about ${speaker ? 50 : speech ? 236 : 260} MB installed. SHA-256 verified; installation does not change your selected engine.` : zh ? '正在读取安装状态…' : 'Checking installation…'}</p>
    <div className="voice-model-sources">{status?.sources.map(source => <a key={source.url} href={source.url} onClick={event => { event.preventDefault(); void window.cardbushDesktop?.openExternal(source.url).catch(() => setError(zh ? '无法打开来源页面。' : 'Unable to open source page.')); }}>{source.title}</a>)}</div>
    <p className="voice-help">{zh ? '下载使用「设置 → 网络」中的插件代理，默认跟随模型代理。' : 'Downloads follow Settings → Network → Plugins; by default this follows the model proxy.'}</p>
    <p className="voice-help" role="status">{status?.state === 'installed' ? zh ? '已安装 · 可离线使用' : 'Installed · Ready offline' : status?.state === 'verifying' ? zh ? '正在校验和安装…' : 'Verifying and installing…' : status?.state === 'downloading'
      ? `${zh ? '正在下载' : 'Downloading'} ${Math.floor(status.downloadedBytes / 1e6)} / ${Math.ceil(status.totalBytes / 1e6)} MB`
      : status && !status.supported ? speech || speaker ? zh ? '当前此模型支持 Windows x64。' : 'This model currently supports Windows x64.' : zh ? '当前仅支持 Windows / Linux x64。' : 'Currently available for Windows / Linux x64.' : zh ? '未安装' : 'Not installed'}</p>
    {installing && <progress aria-label={zh ? '模型下载进度' : 'Model download progress'} value={status.downloadedBytes} max={status.totalBytes} />}
    <div className="voice-actions">
      {installing ? <button type="button" onClick={() => void perform('cancel')}>{zh ? '取消下载' : 'Cancel download'}</button> : status?.state === 'installed' ? <>
        {!speaker && <button type="button" disabled={disabled || busy || selected} onClick={select}>{selected ? zh ? '已选用' : 'Selected' : zh ? '选用此模型' : 'Use this model'}</button>}
        <button type="button" disabled={disabled || busy || selected} onClick={() => void perform('remove')}>{zh ? '卸载' : 'Uninstall'}</button>
      </> : <button type="button" disabled={disabled || busy || !status?.supported} onClick={() => void perform('install')}>{zh ? '下载并安装' : 'Download and install'}</button>}
    </div>
    {(error || status?.error) && <p className="voice-error" role="alert">{error || status?.error}</p>}
  </div>;
}
