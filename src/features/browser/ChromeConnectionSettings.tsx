import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { SettingsCard } from '../settings/SettingsControls';
import './browser-settings.css';

type ChromeConnectorStatus = NonNullable<Window['cardbushDesktop']> extends infer Desktop
  ? Desktop extends { chromeConnectorStatus: () => Promise<infer Status> } ? Status : never
  : never;

export function ChromeConnectionSettings({ language, plugin, busy, onReplace, onPersist }: {
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  busy: boolean;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const [status, setStatus] = useState<ChromeConnectorStatus | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const connector = window.cardbushDesktop;
  const mode = plugin.config.connectionMode === 'remote_debugging'
    ? 'remote_debugging'
    : 'connector';

  const refresh = useCallback(async () => {
    if (!connector?.chromeConnectorStatus) return;
    try {
      setStatus(await connector.chromeConnectorStatus());
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [connector]);

  useEffect(() => {
    void refresh();
    return connector?.onChromeConnectorStatus?.((next) => setStatus(next));
  }, [connector, refresh]);

  const selectMode = (connectionMode: 'connector' | 'remote_debugging') => {
    const next = { ...plugin, config: { ...plugin.config, connectionMode } };
    onReplace(next);
    onPersist(next, language === 'zh' ? 'Chrome 连接方式已保存' : 'Chrome connection mode saved');
  };

  const run = async (key: string, action: () => Promise<unknown>) => {
    setWorking(key);
    setError('');
    try {
      await action();
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setWorking('');
    }
  };

  return (
    <SettingsCard title={language === 'zh' ? '浏览器连接' : 'Browser connection'}>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'connector'} disabled={busy} onChange={() => selectMode('connector')} />
        <span><strong>{language === 'zh' ? 'Browser Connector（推荐）' : 'Browser Connector (recommended)'}</strong><small>{language === 'zh' ? '通过 Chrome 扩展和本地桥复用当前标签页、Cookie 与登录状态。' : 'Reuse current tabs, cookies, and signed-in state through the Chrome extension and local bridge.'}</small></span>
      </label>
      <label className="chrome-radio-setting">
        <input type="radio" name="chrome-connection-mode" checked={mode === 'remote_debugging'} disabled={busy} onChange={() => selectMode('remote_debugging')} />
        <span><strong>{language === 'zh' ? '远程调试兼容模式' : 'Remote debugging compatibility mode'}</strong><small>{language === 'zh' ? '仅供开发者使用；连接已主动开启远程调试的 Chrome，不创建临时资料。' : 'For advanced development only; connects to an opted-in remote-debugging Chrome without creating a temporary profile.'}</small></span>
      </label>
      {mode === 'connector' ? (
        <div className="chrome-connector-card">
          <div className="chrome-connector-heading">
            <span className={`chrome-connector-indicator ${status?.extensionConnected ? 'online' : status?.bridgeRunning ? 'waiting' : ''}`} />
            <div>
              <strong>{status?.extensionConnected
                ? (language === 'zh' ? 'Chrome 已连接' : 'Chrome connected')
                : status?.bridgeRunning
                  ? (language === 'zh' ? '本地桥已就绪，等待扩展' : 'Local bridge ready; waiting for extension')
                  : (language === 'zh' ? '连接器未就绪' : 'Connector not ready')}</strong>
              <small>{status?.extensionConnected
                ? `${status.activeTabTitle || (language === 'zh' ? '当前标签页' : 'Current tab')} · ${status.controlledTabCount} ${language === 'zh' ? '个受控标签页' : 'controlled tabs'}`
                : (language === 'zh' ? '安装扩展后，在扩展弹窗中授权本次、当前网站或全部网站。' : 'After installing, grant this tab, this site, or all sites in the extension popup.')}</small>
            </div>
          </div>
          <div className="chrome-connector-actions">
            <button className="primary-button compact" type="button" disabled={working !== '' || !connector?.setupChromeConnector || status?.bridgeRegistered === true || status?.nativeHostAvailable === false} title={status?.setupMessage} onClick={() => void run('bridge', async () => connector?.setupChromeConnector())}>
              {working === 'bridge' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.bridgeRegistered ? (language === 'zh' ? '本地桥已配置' : 'Local bridge configured') : (language === 'zh' ? '1. 配置本地桥' : '1. Configure local bridge')}
            </button>
            <button className="primary-button compact" type="button" disabled={working !== '' || !connector?.openChromeConnectorInstaller} onClick={() => void run('extension', async () => connector?.openChromeConnectorInstaller())}>
              {working === 'extension' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.storeUrl ? (language === 'zh' ? '2. 从商店安装扩展' : '2. Install from Chrome Web Store') : (language === 'zh' ? '2. 打开扩展目录' : '2. Open extension folder')}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== ''} onClick={() => void refresh()}><RefreshCw size={14} />{language === 'zh' ? '刷新状态' : 'Refresh'}</button>
          </div>
          {!status?.storeUrl && <p className="browser-setting-note">{language === 'zh' ? '扩展目录已随 CardBush 提供。按钮会复制目录路径并打开文件夹，请在 Chrome 扩展管理页（chrome://extensions）开启开发者模式，选择“加载已解压的扩展程序”并选中该目录。' : 'The extension ships with CardBush. Copy and reveal its directory, enable developer mode at chrome://extensions, and select the directory with “Load unpacked”.'}</p>}
          {status?.setupMessage && <p className="browser-setting-note">{status.setupMessage}</p>}
          {status?.lastError && <p className="settings-form-error">{status.lastError}</p>}
          {error && <p className="settings-form-error">{error}</p>}
        </div>
      ) : (
        <p className="browser-setting-note">
          {language === 'zh'
            ? '在 Chrome 144+ 的 chrome://inspect/#remote-debugging 中主动开启远程调试。此兼容路径仍依赖 DevToolsActivePort，仅在扩展连接器不可用时使用。'
            : 'Explicitly enable remote debugging at chrome://inspect/#remote-debugging in Chrome 144+. This compatibility path still relies on DevToolsActivePort and is only for cases where the extension connector cannot be used.'}
        </p>
      )}
    </SettingsCard>
  );
}


function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
