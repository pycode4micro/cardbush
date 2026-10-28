import { uiText } from '../../i18n';
import { useEffect, useState } from 'react';
import type { VoiceModelStatus, VoiceModelKind } from '../../../electron/voiceTypes';
import { voiceError } from './voiceError';

export function VoiceModelPanel({ language, selected, disabled, select, kind = 'recognition' }: { kind?: VoiceModelKind; language: string; selected: boolean; disabled: boolean; select(): void }) {
  const api = window.cardbushDesktop?.voice, speech = kind === 'speech', speaker = kind === 'speaker';
  const [status, setStatus] = useState<VoiceModelStatus>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const value = await api?.modelStatus(kind);
        if (alive) { setStatus(value); if (busy || value && ['downloading', 'verifying'].includes(value.state)) timer = setTimeout(read, 500); }
      } catch (error) { if (alive) setError(voiceError(error, uiText(language)('voiceModelPanel.could_not_read_the_local_model_status'))); }
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
    } catch (error) { setError(voiceError(error, uiText(language)('voiceModelPanel.localModelOperationFailed'))); }
    finally { setBusy(false); }
  };
  const installing = status && ['downloading', 'verifying'].includes(status.state);
  return <div className="voice-model-panel">
    <strong>{speaker ? 'CAMPPlus' : speech ? 'Kokoro v1.1' : 'SenseVoice Small'} <span className="voice-help">{speaker ? uiText(language)('voiceModelPanel.speakerVerificationOptional') : speech ? uiText(language)('voiceModelPanel.neuralVoicesOptional') : uiText(language)('voiceModelPanel.recommendedOptional')}</span></strong>
    <p className="voice-help">{speaker ? uiText(language)('voiceModelPanel.compareSpeechWithYourEnrolledVoiceLocally') : speech ? uiText(language)('voiceModelPanel.chineseAndEnglishNeuralVoicesFemaleAnd') : uiText(language)('voiceModelPanel.offlineChineseAndEnglishRecognitionModelBy')}</p>
    <p className="voice-help">{status ? uiText(language)('voiceModelPanel.aboutMbToDownloadAboutMbInstalled', { value1: Math.ceil(status.totalBytes / 1e6), value2: speaker ? 50 : speech ? 236 : 260 }) : uiText(language)('voiceModelPanel.checkingInstallation')}</p>
    <div className="voice-model-sources">{status?.sources.map(source => <a key={source.url} href={source.url} onClick={event => { event.preventDefault(); void window.cardbushDesktop?.openExternal(source.url).catch(() => setError(uiText(language)('voiceModelPanel.unableToOpenSourcePage'))); }}>{source.title}</a>)}</div>
    <p className="voice-help">{uiText(language)('voiceModelPanel.downloadsUseSettingsNetworkProxyMarketplacePlugins')}</p>
    <p className="voice-help" role="status">{status?.state === 'installed' ? uiText(language)('voiceModelPanel.installedReadyOffline') : status?.state === 'verifying' ? uiText(language)('voiceModelPanel.verifyingAndInstalling') : status?.state === 'downloading'
      ? `${uiText(language)('voiceModelPanel.downloading')} ${Math.floor(status.downloadedBytes / 1e6)} / ${Math.ceil(status.totalBytes / 1e6)} MB`
      : status && !status.supported ? speech || speaker ? uiText(language)('voiceModelPanel.thisModelCurrentlySupportsWindowsX64') : uiText(language)('voiceModelPanel.currentlyAvailableForWindowsLinuxX64') : uiText(language)('sandboxSettingsPanel.notInstalled')}</p>
    {installing && <progress aria-label={uiText(language)('voiceModelPanel.modelDownloadProgress')} value={status.downloadedBytes} max={status.totalBytes} />}
    <div className="voice-actions">
      {installing ? <button type="button" onClick={() => void perform('cancel')}>{uiText(language)('browserLibraryDialog.cancelDownload')}</button> : status?.state === 'installed' ? <>
        {!speaker && <button type="button" disabled={disabled || busy || selected} onClick={select}>{selected ? uiText(language)('voiceModelPanel.selected') : uiText(language)('voiceModelPanel.useThisModel')}</button>}
        <button type="button" disabled={disabled || busy || selected} onClick={() => void perform('remove')}>{uiText(language)('settingsView.uninstall')}</button>
      </> : <button type="button" disabled={disabled || busy || !status?.supported} onClick={() => void perform('install')}>{uiText(language)('voiceModelPanel.downloadAndInstall')}</button>}
    </div>
    {(error || status?.error) && <p className="voice-error" role="alert">{error || status?.error}</p>}
  </div>;
}
