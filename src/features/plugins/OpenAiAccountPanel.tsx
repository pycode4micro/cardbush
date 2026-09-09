import { useEffect, useState } from 'react';
import type { OpenAiAccountStatus } from '@cardbush/bush-protocol';
import './mcp-integration.css';

export function OpenAiAccountPanel({ language, onChanged, onStatusChange }: {
  language: 'zh' | 'en'; onChanged?: () => void; onStatusChange?: (status: OpenAiAccountStatus | undefined) => void;
}) {
  const zh = language === 'zh';
  const desktop = window.cardbushDesktop;
  const [status, setStatus] = useState<OpenAiAccountStatus>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!desktop?.openAiAccountStatus) return;
    let active = true;
    const refresh = () => { void desktop.openAiAccountStatus().then(value => { if (active) setStatus(value); }).catch(() => { if (active) setError(zh ? '无法读取 OpenAI 账户状态。' : 'Could not read OpenAI account status.'); }); };
    refresh();
    const unsubscribe = desktop.onOpenAiAccountChanged?.(() => { refresh(); onChanged?.(); });
    return () => { active = false; unsubscribe?.(); };
  }, [desktop, language]);
  useEffect(() => { onStatusChange?.(status); }, [status, onStatusChange]);
  if (!desktop?.openAiAccountStatus) return null;
  const signingIn = status?.state === 'signing_in' || busy === 'login';
  const connected = status?.state === 'signed_in';
  const labels = zh ? { signed_out: '未登录', signing_in: '等待浏览器登录', signed_in: '已登录', reauth_required: '需要重新登录', unavailable: '账户存储不可用' }
    : { signed_out: 'Signed out', signing_in: 'Waiting for browser sign-in', signed_in: 'Signed in', reauth_required: 'Sign in again', unavailable: 'Credential storage unavailable' };
  const action = async (action: Parameters<typeof desktop.openAiAccountAction>[0]) => {
    if (action !== 'cancel_login') setBusy(action);
    setError('');
    try { setStatus(await desktop.openAiAccountAction(action)); onChanged?.(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (action !== 'cancel_login') setBusy(''); void desktop.openAiAccountStatus().then(setStatus).catch(() => {}); }
  };
  return <section className="openai-account-panel" aria-label={zh ? 'OpenAI 账户' : 'OpenAI account'}>
    <header><div className="openai-account-identity"><strong>{zh ? 'OpenAI 账户' : 'OpenAI account'}</strong><span role="status" data-connected={connected}>{status ? labels[status.state] : (zh ? '读取中…' : 'Loading…')}</span></div>
      {signingIn ? <button type="button" onClick={() => void action('cancel_login')}>{zh ? '取消 OpenAI 登录' : 'Cancel OpenAI sign-in'}</button>
        : !connected && <button type="button" className="mcp-primary-action" disabled={!status || Boolean(busy) || status.state === 'unavailable'} onClick={() => void action('login')}>{status?.state === 'reauth_required' ? (zh ? '重新登录 OpenAI' : 'Sign in to OpenAI again') : (zh ? '登录 OpenAI' : 'Sign in to OpenAI')}</button>}
    </header>
    {!connected && <p className="openai-account-hint">{signingIn ? (zh ? '在浏览器中完成登录。' : 'Finish signing in in your browser.') : (zh ? '登录一次，即可为应用授权。' : 'Sign in once to connect your apps.')}</p>}
    <details className="openai-account-options"><summary>{zh ? '账户设置' : 'Account settings'}</summary><div className="plugin-mcp-actions">
      {connected && <button type="button" disabled={Boolean(busy)} onClick={() => void action('login')}>{zh ? '重新登录 OpenAI' : 'Sign in to OpenAI again'}</button>}
      <button type="button" disabled={Boolean(busy)} onClick={() => void action('manage_apps')}>{zh ? '在 ChatGPT 管理应用' : 'Manage apps in ChatGPT'}</button>
      {connected && <button type="button" disabled={Boolean(busy)} onClick={() => void action('reconnect')}>{zh ? '刷新应用连接' : 'Refresh app connections'}</button>}
      {status && status.state !== 'signed_out' && !signingIn && <button type="button" disabled={Boolean(busy)} onClick={() => void action('logout')}>{zh ? '退出 OpenAI 登录' : 'Sign out of OpenAI'}</button>}
    </div>
    <p>{zh ? '应用授权时需要登录对应的服务商账号。请在网页中使用与此处相同的 OpenAI 账户。登录信息加密保存在本机，供应用共享。' : 'App authorization requires signing in to its provider. Use the same OpenAI account in the browser. Credentials are encrypted on this device and shared by your apps.'}</p>
    <details><summary>{zh ? '实验性接入说明' : 'About this experimental connection'}</summary><p>{zh
      ? '当前沿用 OpenAI 公开客户端的 OAuth 注册信息，授权页可能显示 Codex。无需安装 Codex。目标应用仍需在 ChatGPT 中完成授权；服务端可用性可能变化。退出登录会断开所有使用此账户的 CardBush 插件，不会撤销 ChatGPT 中的第三方授权。'
      : 'Uses OAuth registration from OpenAI’s public client, so the consent page may say Codex. Codex installation is not required. Connect the target app in ChatGPT first. Server availability may change. Signing out disconnects all CardBush plugins using this account; it does not revoke third-party grants in ChatGPT.'}</p></details></details>
    {(error || status?.lastError) && <div role="alert" className="plugin-mcp-error"><p>{zh ? '账户操作未完成。' : 'The account action could not be completed.'}</p><details><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{error || status?.lastError}</p></details></div>}
  </section>;
}
