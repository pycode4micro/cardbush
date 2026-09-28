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
  const [diagnosticsCopied, setDiagnosticsCopied] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [cleanupCopied, setCleanupCopied] = useState(false);
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

  useEffect(() => {
    if (!status?.connectorEnabled || status.extensionConnected) setPairing(null);
  }, [status?.connectorEnabled, status?.extensionConnected]);
  useEffect(() => {
    if (!pairing) return;
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, Date.parse(pairing.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairing]);

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
        <span><strong>{language === 'zh' ? 'Chrome 连接器（Windows 11）' : 'Chrome connector (Windows 11)'}</strong><small>{language === 'zh' ? '默认关闭。开启后，通过扩展控制你授权的页面，并使用 Chrome 现有登录状态。' : 'Off by default. Enable to control pages you authorize through the extension, using your existing Chrome sign-in.'}</small></span>
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
              <strong>{status?.lifecycleState === 'needs_repair'
                ? (language === 'zh' ? '连接器需要处理' : 'Connector needs attention')
                : !status?.connectorEnabled
                ? (language === 'zh' ? '连接器已关闭' : 'Connector disabled')
                : status?.extensionConnected
                ? (language === 'zh' ? 'Chrome 已连接' : 'Chrome connected')
                : status?.bridgeRunning
                  ? (language === 'zh' ? '本地桥已就绪，等待扩展' : 'Local bridge ready; waiting for extension')
                  : (language === 'zh' ? '连接器未就绪' : 'Connector not ready')}</strong>
              <small>{status?.extensionConnected
                ? `${status.activeTabTitle || (language === 'zh' ? '当前标签页' : 'Current tab')} · ${status.controlledTabCount} ${language === 'zh' ? '个受控标签页' : 'controlled tabs'}`
                : (language === 'zh' ? '首次使用请生成配对码，在 Chrome 扩展中粘贴并配对；页面授权仍由你单独选择。' : 'Generate a pairing code and paste it into the Chrome extension. Page access is authorized separately.')}</small>
            </div>
          </div>
          <div className="chrome-connector-actions">
            <button className="primary-button compact" type="button" disabled={working !== '' || !status || !connector?.setupChromeConnector || (!status.connectorEnabled && (!status.platformSupported || !status.nativeHostAvailable))} title={status?.setupMessage} onClick={() => void run('bridge', async () => status?.connectorEnabled ? connector?.disableChromeConnector() : connector?.setupChromeConnector())}>
              {working === 'bridge' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.connectorEnabled ? (language === 'zh' ? '关闭连接器' : 'Disable connector') : (language === 'zh' ? '开启连接器' : 'Enable connector')}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !status?.bridgeRunning || !connector?.pairChromeConnector}
              onClick={() => void run('pair', async () => { setPairing(await connector!.pairChromeConnector()); setPairingCopied(false); })}>
              {language === 'zh' ? '生成配对码' : 'Generate pairing code'}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.removeChromeConnector || !status?.platformSupported} onClick={() => void run('remove', async () => connector?.removeChromeConnector())}>{language === 'zh' ? '移除连接器配置' : 'Remove connector configuration'}</button>
            <button className="primary-button compact" type="button" disabled={working !== '' || !connector?.openChromeConnectorInstaller} onClick={() => void run('extension', async () => connector?.openChromeConnectorInstaller())}>
              {working === 'extension' ? <LoaderCircle className="spin" size={14} /> : null}
              {status?.storeUrl ? (language === 'zh' ? '安装 Chrome 扩展' : 'Install Chrome extension') : (language === 'zh' ? '打开扩展目录' : 'Open extension folder')}
            </button>
            <button className="secondary-button compact" type="button" disabled={working !== ''} onClick={() => void refresh()}><RefreshCw size={14} />{language === 'zh' ? '刷新状态' : 'Refresh'}</button>
            <button className="secondary-button compact" type="button" disabled={working !== '' || !connector?.copyChromeConnectorDiagnostics} onClick={() => void run('diagnostics', async () => { await connector?.copyChromeConnectorDiagnostics(); setDiagnosticsCopied(true); })}>{diagnosticsCopied ? (language === 'zh' ? '已复制诊断信息' : 'Diagnostics copied') : (language === 'zh' ? '复制诊断信息' : 'Copy diagnostics')}</button>
          </div>
          {pairing && <div className="chrome-connector-pairing">
            <label>{language === 'zh' ? '配对码（5 分钟内有效）' : 'Pairing code (valid for 5 minutes)'}
              <input type="password" readOnly value={pairing.code} autoComplete="off" aria-label={language === 'zh' ? '配对码' : 'Pairing code'} />
            </label>
            <button className="secondary-button compact" type="button" onClick={() => void run('copy-pair', async () => {
              await navigator.clipboard.writeText(pairing.code); setPairingCopied(true);
            })}>{pairingCopied ? (language === 'zh' ? '已复制' : 'Copied') : (language === 'zh' ? '复制配对码' : 'Copy pairing code')}</button>
            <p className="browser-setting-note">{language === 'zh' ? '仅粘贴到 CardBush Chrome 扩展。重新配对成功后会替换原配对。' : 'Paste only into the CardBush Chrome extension. Successful pairing replaces the previous pairing.'}</p>
          </div>}
          <p className="browser-setting-note">{language === 'zh'
            ? '“停止控制”只结束当前控制。此处关闭会断开连接并撤销配对；再次开启需要重新配对。新连接器不写入 Chrome 注册表。Chrome 扩展需在 chrome://extensions 中移除。'
            : 'Stop control ends the current control session. Disabling here disconnects and revokes pairing; enabling again requires a new pairing. The connector creates no Chrome registry entries. Remove the extension at chrome://extensions.'}</p>
          {status?.cleanupWarning && <div className="browser-setting-note">
            <p>{status.cleanupWarning === 'legacy_external_registration'
              ? (language === 'zh' ? '检测到旧版的外部注册项。请退出所有 CardBush 窗口和后台进程，在 Windows 终端的 PowerShell 中执行清理命令。新版本不会再创建此注册项。' : 'A legacy external registration remains. Exit all CardBush windows and background processes and run the cleanup command in Windows Terminal’s PowerShell. This version does not recreate it.')
              : status.cleanupWarning}</p>
            {status.cleanupWarning === 'legacy_external_registration' && <button className="secondary-button compact" type="button"
              onClick={() => void run('legacy-cleanup', async () => { await connector?.copyLegacyChromeConnectorCleanup(); setCleanupCopied(true); })}>
              {cleanupCopied ? (language === 'zh' ? '已复制，请在 PowerShell 中执行' : 'Copied; run in PowerShell') : (language === 'zh' ? '复制旧版清理命令' : 'Copy legacy cleanup command')}
            </button>}
          </div>}
          <p className="browser-setting-note">{language === 'zh'
            ? '连接器不直接读取浏览器的密码或 Cookie 数据库。授权页面的文字、截图和操作结果可能发送给你配置的模型服务。'
            : 'The connector does not read browser password or cookie databases directly. Authorized page text, screenshots and action results may be sent to your configured model provider.'}</p>
          {!status?.storeUrl && <p className="browser-setting-note">{language === 'zh' ? '扩展目录已随 CardBush 提供。按钮会复制目录路径并打开文件夹，请在 Chrome 扩展管理页（chrome://extensions）开启开发者模式，选择“加载已解压的扩展程序”并选中该目录。' : 'The extension ships with CardBush. Copy and reveal its directory, enable developer mode at chrome://extensions, and select the directory with “Load unpacked”.'}</p>}
          {status?.setupMessage && <p className="browser-setting-note">{status.setupMessage}</p>}
          {status?.registrationConflict && <p className="settings-form-error">{status.registrationConflict}</p>}
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
