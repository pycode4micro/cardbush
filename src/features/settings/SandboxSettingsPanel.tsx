import { useEffect, useRef, useState } from 'react';
import type { SandboxSetupStatus } from '../../../electron/sandboxTypes';
import type { AppLanguage } from '../../types';
import { SettingsCard, SettingsSwitch } from './SettingsControls';
import { useSettingsHost } from './SettingsHostContext';

export function SandboxSettingsPanel({ language }: { language: AppLanguage }) {
  const host = useSettingsHost(), zh = language === 'zh';
  const [status, setStatus] = useState<SandboxSetupStatus>();
  const [busy, setBusy] = useState<'check' | 'install' | 'update' | ''>('check');
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(undefined); setError(''); setBusy('check');
    void host.fetchSandboxSetup().then(value => { if (current === generation.current) setStatus(value); }, error => {
      if (current === generation.current) setError(error instanceof Error ? error.message : String(error));
    }).finally(() => { if (current === generation.current) setBusy(''); });
    return () => { generation.current++; };
  }, [host]);
  async function act(action: 'check' | 'install' | 'update', enabled?: boolean) {
    if (busy) return;
    const current = generation.current;
    setBusy(action); setError('');
    try {
      const value = await (action === 'check' ? host.fetchSandboxSetup() : action === 'install' ? host.installSandbox() : host.updateSandbox(enabled!));
      if (current === generation.current) setStatus(value);
    } catch (error) {
      if (current === generation.current) {
        setError(error instanceof Error ? error.message : String(error));
        // A package may have installed even if the capability check failed.
        try { const value = await host.fetchSandboxSetup(); if (current === generation.current) setStatus(value); } catch { /* Keep the original failure. */ }
      }
    } finally { if (current === generation.current) setBusy(''); }
  }
  const label = !status ? (error ? zh ? '环境检测失败' : 'Environment check failed' : zh ? '正在检测环境…' : 'Checking environment…')
    : status.state === 'ready' ? (status.enabled ? zh ? '已安装 · 已启用' : 'Installed · On' : zh ? '已安装 · 已关闭' : 'Installed · Off')
    : status.state === 'missing' ? (zh ? '未安装' : 'Not installed')
    : status.state === 'unsupported' ? (zh ? '此系统暂不支持' : 'Not supported on this system')
    : (zh ? '已安装 · 当前不可用' : 'Installed · Unavailable');
  return <SettingsCard title={zh ? '命令沙盒' : 'Command sandbox'}
    subtitle={zh ? '安装后默认启用，重启后保留设置。“申请批准”模式自动隔离命令，需要额外权限时再向你申请。' : 'Enabled after installation, with your preference saved across restarts. Commands in approval mode run in isolation and request extra access when needed.'}>
    <div className="settings-sandbox-status" role="status"><strong>{label}</strong></div>
    {status?.installed && <SettingsSwitch title={zh ? '启用沙盒' : 'Enable sandbox'} checked={status.enabled}
      subtitle={status.managed ? (zh ? '此项由宿主管理员配置。' : 'Managed by the host administrator.')
        : (zh ? '更改对下一次命令生效，已经启动或正在等待批准的命令保持原来的权限。' : 'Applies to the next command. Running commands and pending approvals keep their existing scope.')}
      disabled={Boolean(busy) || status.managed || (!status.enabled && status.state !== 'ready')} onChange={enabled => void act('update', enabled)}/>}
    {status?.managed && !status.installed && <p>{zh ? '此项由宿主管理员配置。' : 'Managed by the host administrator.'}</p>}
    {status?.state === 'missing' && !status.canInstall && !status.managed && <p>{status.platform === 'linux'
      ? (zh ? '未检测到支持的安装方式，安装按钮不可用。按主机可用的包管理器自动识别，兼容使用相同包管理器的衍生发行版。' : 'No supported installer was detected. Installation is unavailable. Detection uses the host’s available package manager, including on derivative distributions.')
      : (zh ? '请更新或重新安装此主机上的 CardBush，以恢复沙盒组件。' : 'Update or reinstall CardBush on this host to restore its sandbox component.')}</p>}
    {status?.state === 'blocked' && <p>{zh ? '组件未通过环境检查。请在下方查看原因，处理后重新检测。' : 'The component did not pass the environment check. See details below, resolve the issue, then check again.'}</p>}
    <div className="settings-sandbox-actions">
      {!status?.installed && <button className="primary-button" disabled={Boolean(busy) || !status?.canInstall} onClick={() => void act('install')}>
        {busy === 'install' ? (zh ? '正在安装…' : 'Installing…') : (zh ? '安装沙盒' : 'Install sandbox')}</button>}
      <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void act('check')}>{busy === 'check' ? (zh ? '正在检测…' : 'Checking…') : (zh ? '重新检测' : 'Check again')}</button>
    </div>
    {status?.canInstall && <p className="settings-muted">{zh ? '仅在点击安装后下载组件，系统可能要求管理员授权。' : 'Components are downloaded only after you click Install. The system may ask for administrator authorization.'}</p>}
    {error && <p role="alert" className="settings-inline-error">{error}</p>}
    {(status?.detail || status?.manualCommand) && <details className="settings-sandbox-details"><summary>{zh ? '环境详情' : 'Environment details'}</summary>
      {status.detail && <p>{status.detail}</p>}
      {status.manualCommand && <><p>{zh ? '如果此主机无法弹出系统授权窗口，可由管理员执行：' : 'If this host cannot show system authorization, an administrator can run:'}</p><code>{status.manualCommand}</code>
        <button className="secondary-button" onClick={() => void navigator.clipboard.writeText(status.manualCommand!).catch(error => setError(String(error)))}>{zh ? '复制安装命令' : 'Copy installation command'}</button></>}
    </details>}
  </SettingsCard>;
}
