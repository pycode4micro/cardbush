import { useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Search, UserRound, ShieldCheck } from 'lucide-react';
import type { AccountAction, AccountProvider, ManagedAccount } from '@cardbush/bush-protocol';
import { useAccounts } from './useAccounts';
import './accounts.css';

export function AccountsPanel({ language, onBack }: { language: 'zh' | 'en'; onBack?: () => void }) {
  const zh = language === 'zh';
  const { snapshot, error, busy, execute, refresh } = useAccounts(language);
  const [query, setQuery] = useState(''), [linkError, setLinkError] = useState('');
  const matches = (provider: AccountProvider) => `${provider.name} ${provider.description[language]}`.toLowerCase().includes(query.trim().toLowerCase());
  const available = snapshot?.providers.filter(provider => provider.availability === 'available' && matches(provider)) ?? [];
  const planned = snapshot?.providers.filter(provider => provider.availability === 'planned' && matches(provider)) ?? [];
  const connected = snapshot?.accounts.filter(account => account.state === 'signed_in').length ?? 0;
  const openDocumentation = async (url: string) => {
    setLinkError('');
    try { if (!window.cardbushDesktop?.openExternal) throw new Error('Browser unavailable'); await window.cardbushDesktop.openExternal(url); }
    catch { setLinkError(zh ? '无法打开说明页面，请检查浏览器设置。' : 'Could not open the documentation. Check your browser settings.'); }
  };
  return <div className="accounts-page">
    {onBack && <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={16}/>{zh ? '返回插件' : 'Back to plugin'}</button>}
    <header className="accounts-heading"><div><h2>{zh ? '账号' : 'Accounts'}</h2><p>{zh ? '管理登录状态，查看账号可用于哪些应用与功能。' : 'Manage sign-in and see which apps and features each account can access.'}</p></div>
      <button type="button" className="account-button" aria-label={zh ? '刷新账号' : 'Refresh accounts'} onClick={() => void refresh()}><RefreshCw size={17}/></button></header>
    <label className="accounts-search"><Search size={17}/><input aria-label={zh ? '搜索账号平台' : 'Search account providers'} value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? '搜索平台或用途' : 'Search providers or capabilities'}/></label>
    {(error || linkError) && <p className="accounts-error" role="alert">{error || linkError}</p>}
    {!snapshot && !error && <p role="status">{zh ? '正在读取账号…' : 'Loading accounts…'}</p>}
    {snapshot && <>
      <div className="accounts-section-title"><h3>{zh ? '可管理的账号' : 'Available accounts'}</h3><span>{zh ? `已登录 ${connected}` : `${connected} signed in`}</span></div>
      {snapshot.errors.map(item => <p key={item.providerId} className="accounts-error" role="alert">{zh ? `无法读取 ${snapshot.providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId} 账号，请刷新重试。` : `Could not read ${item.providerId} accounts. Refresh to retry.`}</p>)}
      <div className="accounts-connections">{available.flatMap(provider => snapshot.accounts.filter(account => account.providerId === provider.id).map(account =>
        <AccountCard key={`${provider.id}:${account.id}`} language={language} provider={provider} account={account} busy={busy[`${provider.id}:${account.id}`] ?? ''}
          onAction={action => void execute({ providerId: provider.id, accountId: account.id, action })}/>))}</div>
      {planned.length > 0 && <><div className="accounts-section-title"><h3>{zh ? '更多平台' : 'More providers'}</h3><span>{zh ? '待接入' : 'Planned'}</span></div>
        <div className="account-provider-grid">{planned.map(provider => <article key={provider.id} className="account-provider-card">
          <header><span className="account-provider-icon" data-provider={provider.id}><UserRound size={19}/></span><h4>{provider.name}</h4><span className="account-state">{zh ? '待接入' : 'Planned'}</span></header>
          <p>{provider.description[language]}</p><details><summary>{zh ? '接入说明' : 'Connection details'}</summary><p>{provider.detail[language]}</p>
            <button type="button" className="account-doc-link" onClick={() => void openDocumentation(provider.documentationUrl)}>{zh ? '官方文档' : 'Official documentation'}<ExternalLink size={13}/></button></details>
        </article>)}</div></>}
      {!available.length && !planned.length && <p className="accounts-empty">{zh ? '没有匹配的平台。' : 'No matching providers.'}</p>}
      <p className="accounts-footer"><ShieldCheck size={16}/>{zh ? '账号凭据加密保存在本机。应用权限按连接分别管理。' : 'Credentials are encrypted on this device. App permissions are managed per connection.'}</p>
    </>}
  </div>;
}

function AccountCard({ language, provider, account, busy, onAction }: { language: 'zh' | 'en'; provider: AccountProvider; account: ManagedAccount; busy: string; onAction: (action: AccountAction) => void }) {
  const zh = language === 'zh', connected = account.state === 'signed_in', signingIn = account.state === 'signing_in' || busy === 'login';
  const labels = zh ? { signed_out: '未登录', signing_in: '等待浏览器登录', signed_in: '已登录', reauth_required: '需要重新登录', unavailable: '账号存储不可用' }
    : { signed_out: 'Signed out', signing_in: 'Waiting for browser sign-in', signed_in: 'Signed in', reauth_required: 'Sign in again', unavailable: 'Credential storage unavailable' };
  const actionLabel = (action: AccountAction) => ({
    login: zh ? `${connected || account.state === 'reauth_required' ? '重新登录' : '登录'} ${provider.name}` : `Sign in to ${provider.name}${connected ? ' again' : ''}`,
    cancel_login: zh ? `取消 ${provider.name} 登录` : `Cancel ${provider.name} sign-in`,
    logout: zh ? `退出 ${provider.name} 登录` : `Sign out of ${provider.name}`,
    reconnect: zh ? '刷新应用连接' : 'Refresh app connections',
    manage_apps: provider.id === 'openai' ? (zh ? '在 ChatGPT 管理应用' : 'Manage apps in ChatGPT') : (zh ? '管理应用授权' : 'Manage app grants'),
  }[action]);
  const actions = account.actions.filter(action => action !== 'cancel_login' && (action !== 'login' || connected));
  return <section className="account-connection-card" data-provider={provider.id} aria-label={`${provider.name} ${zh ? '账号' : 'account'}`}>
    <header><span className="account-provider-icon" data-provider={provider.id}><UserRound size={22}/></span><div className="account-identity"><strong>{account.label}</strong><span role="status" className="account-state" data-state={account.state}>{labels[account.state]}</span></div>
      <div className="account-primary-actions">{signingIn ? <button type="button" className="account-button" disabled={busy === 'cancel_login'} onClick={() => onAction('cancel_login')}>{busy === 'cancel_login' ? (zh ? '正在取消…' : 'Cancelling…') : actionLabel('cancel_login')}</button>
        : !connected && account.actions.includes('login') && <button type="button" className="account-button account-primary" disabled={Boolean(busy)} onClick={() => onAction('login')}>{actionLabel('login')}</button>}</div></header>
    <p className="account-description">{provider.description[language]}</p>
    {signingIn && <p className="account-description">{zh ? '在浏览器中完成登录，也可以随时取消。' : 'Complete sign-in in your browser or cancel at any time.'}</p>}
    {account.lastError && <p className="accounts-error" role="alert">{account.lastError}</p>}
    <details className="account-options"><summary>{zh ? '账号设置' : 'Account settings'}{provider.experimental && <span>{zh ? '实验性接入' : 'Experimental'}</span>}</summary>
      <p>{provider.detail[language]}</p><div className="account-actions">{actions.map(action => <button className="account-button" type="button" key={action} disabled={Boolean(busy) || signingIn} onClick={() => onAction(action)}>{actionLabel(action)}</button>)}</div></details>
  </section>;
}
