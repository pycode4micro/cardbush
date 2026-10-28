import { localizedContent } from '../../i18n';
import { uiText } from '../../i18n';
import { useState } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw, Search, UserRound, ShieldCheck } from 'lucide-react';
import type { AccountAction, AccountProvider, ManagedAccount } from '@cardbush/bush-protocol';
import { useAccounts } from './useAccounts';
import { ChatGptWelcome } from './ChatGptWelcome';
import './accounts.css';

export function AccountsPanel({ language, onBack }: { language: string; onBack?: () => void }) {

  const { snapshot, error, busy, execute, refresh } = useAccounts(language);
  const [query, setQuery] = useState(''), [linkError, setLinkError] = useState('');
  const matches = (provider: AccountProvider) => `${provider.name} ${localizedContent(provider.description, language)}`.toLowerCase().includes(query.trim().toLowerCase());
  const available = snapshot?.providers.filter(provider => provider.availability === 'available' && matches(provider)) ?? [];
  const planned = snapshot?.providers.filter(provider => provider.availability === 'planned' && matches(provider)) ?? [];
  const connected = snapshot?.accounts.filter(account => account.state === 'signed_in').length ?? 0;
  const openDocumentation = async (url: string) => {
    setLinkError('');
    try { if (!window.cardbushDesktop?.openExternal) throw new Error(uiText(language)('accountsPanel.browser_unavailable')); await window.cardbushDesktop.openExternal(url); }
    catch { setLinkError(uiText(language)('accountsPanel.couldNotOpenTheDocumentationCheckYour')); }
  };
  return <div className="accounts-page">
    <ChatGptWelcome language={language}/>
    {onBack && <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={16}/>{uiText(language)('accountsPanel.backToPlugin')}</button>}
    <header className="accounts-heading"><div><h2>{uiText(language)('accountsPanel.accounts')}</h2><p>{uiText(language)('accountsPanel.manageSignInAndSeeWhichApps')}</p></div>
      <button type="button" className="account-button" aria-label={uiText(language)('accountsPanel.refreshAccounts')} onClick={() => void refresh()}><RefreshCw size={17}/></button></header>
    <label className="accounts-search"><Search size={17}/><input aria-label={uiText(language)('accountsPanel.searchAccountProviders')} value={query} onChange={event => setQuery(event.target.value)} placeholder={uiText(language)('accountsPanel.searchProvidersOrCapabilities')}/></label>
    {(error || linkError) && <p className="accounts-error" role="alert">{error || linkError}</p>}
    {!snapshot && !error && <p role="status">{uiText(language)('accountsPanel.loadingAccounts')}</p>}
    {snapshot && <>
      <div className="accounts-section-title"><h3>{uiText(language)('accountsPanel.availableAccounts')}</h3><span>{uiText(language)('accountsPanel.signedIn', { connected })}</span></div>
      {snapshot.errors.map(item => <p key={item.providerId} className="accounts-error" role="alert">{uiText(language)('accounts.readFailed', { name: snapshot.providers.find(provider => provider.id === item.providerId)?.name ?? item.providerId })}</p>)}
      <div className="accounts-connections">{available.flatMap(provider => snapshot.accounts.filter(account => account.providerId === provider.id).map(account =>
        <AccountCard key={`${provider.id}:${account.id}`} language={language} provider={provider} account={account} busy={busy[`${provider.id}:${account.id}`] ?? ''}
          onAction={action => void execute({ providerId: provider.id, accountId: account.id, action })}/>))}</div>
      {planned.length > 0 && <><div className="accounts-section-title"><h3>{uiText(language)('accountsPanel.moreProviders')}</h3><span>{uiText(language)('accountsPanel.planned')}</span></div>
        <div className="account-provider-grid">{planned.map(provider => <article key={provider.id} className="account-provider-card">
          <header><span className="account-provider-icon" data-provider={provider.id}><UserRound size={19}/></span><h4>{provider.name}</h4><span className="account-state">{uiText(language)('accountsPanel.planned')}</span></header>
          <p>{localizedContent(provider.description, language)}</p><details><summary>{uiText(language)('accountsPanel.connectionDetails')}</summary><p>{localizedContent(provider.detail, language)}</p>
            <button type="button" className="account-doc-link" onClick={() => void openDocumentation(provider.documentationUrl)}>{uiText(language)('accountsPanel.officialDocumentation')}<ExternalLink size={13}/></button></details>
        </article>)}</div></>}
      {!available.length && !planned.length && <p className="accounts-empty">{uiText(language)('accountsPanel.noMatchingProviders')}</p>}
      <p className="accounts-footer"><ShieldCheck size={16}/>{uiText(language)('accountsPanel.credentialsAreEncryptedOnThisDeviceApp')}</p>
    </>}
  </div>;
}

function AccountCard({ language, provider, account, busy, onAction }: { language: string; provider: AccountProvider; account: ManagedAccount; busy: string; onAction: (action: AccountAction) => void }) {
  const connected = account.state === 'signed_in', signingIn = account.state === 'signing_in' || busy === 'login';
  const labels = ({ signed_out: uiText(language)('accountsPanel.signedOut'), signing_in: uiText(language)('accountsPanel.waitingForBrowserSignIn'), signed_in: uiText(language)('accountsPanel.signedIn_21eb867'), reauth_required: uiText(language)('accountsPanel.signInAgain'), unavailable: uiText(language)('accountsPanel.credentialStorageUnavailable') });
  const actionLabel = (action: AccountAction) => ({
    login: provider.id === 'chatgpt' ? uiText(language)('accountsPanel.continue_with_chatgpt') : uiText(language)(connected || account.state === 'reauth_required' ? 'accounts.signInAgain' : 'accounts.signIn', { name: provider.name }),
    cancel_login: uiText(language)('accountsPanel.cancelSignIn', { value1: provider.name }),
    logout: uiText(language)('accountsPanel.signOutOf', { value1: provider.name }),
    reconnect: uiText(language)('accountsPanel.refreshAppConnections'),
    manage_apps: provider.id === 'chatgpt' ? (uiText(language)('accountsPanel.planUsageAndAccess')) : provider.id === 'openai' ? (uiText(language)('accountsPanel.manageAppsInChatgpt')) : (uiText(language)('accountsPanel.manageAppGrants')),
  }[action]);
  const actions = account.actions.filter(action => action !== 'cancel_login' && (action !== 'login' || connected));
  return <section className="account-connection-card" data-provider={provider.id} aria-label={`${provider.name} ${uiText(language)('accountsPanel.account')}`}>
    <header><span className="account-provider-icon" data-provider={provider.id}><UserRound size={22}/></span><div className="account-identity"><strong>{account.label}</strong><span role="status" className="account-state" data-state={account.state}>{labels[account.state]}</span></div>
      <div className="account-primary-actions">{signingIn ? <button type="button" className="account-button" disabled={busy === 'cancel_login'} onClick={() => onAction('cancel_login')}>{busy === 'cancel_login' ? (uiText(language)('accountsPanel.cancelling')) : actionLabel('cancel_login')}</button>
        : !connected && account.actions.includes('login') && <button type="button" className="account-button account-primary" disabled={Boolean(busy)} onClick={() => onAction('login')}>{actionLabel('login')}</button>}</div></header>
    <p className="account-description">{localizedContent(provider.description, language)}</p>
    {signingIn && <p className="account-description">{uiText(language)('accountsPanel.completeSignInInYourBrowserOr')}</p>}
    {account.lastError && <p className="accounts-error" role="alert">{account.lastError}</p>}
    <details className="account-options"><summary>{uiText(language)('accountsPanel.accountSettings')}{provider.experimental && <span>{uiText(language)('accountsPanel.experimental')}</span>}</summary>
      <p>{localizedContent(provider.detail, language)}</p><div className="account-actions">{actions.map(action => <button className="account-button" type="button" key={action} disabled={Boolean(busy) || signingIn} onClick={() => onAction(action)}>{actionLabel(action)}</button>)}</div></details>
  </section>;
}
