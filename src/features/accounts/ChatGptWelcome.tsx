import { uiText } from '../../i18n';
import { useSiwc } from './useSiwc';
import './siwc.css';

export function ChatGptWelcome({ language }: { language: string }) {
  const { snapshot, action } = useSiwc();
  if (!snapshot?.welcomePending) return null;

  return <aside className="siwc-welcome" role="status">
    <strong>{uiText(language)('chatGptWelcome.youReUsingYourChatgptPlan')}</strong>
    <p>{uiText(language)('chatGptWelcome.eligibleModelRequestsUseThisAccountS')}</p>
    <div className="settings-actions"><button type="button" className="secondary-button" onClick={() => void action({ action: 'manage_usage' })}>{uiText(language)('chatGptWelcome.viewUsage')}</button>
      <button type="button" className="primary-button" onClick={() => void action({ action: 'dismiss_welcome' })}>{uiText(language)('chatGptWelcome.gotIt')}</button></div>
  </aside>;
}
