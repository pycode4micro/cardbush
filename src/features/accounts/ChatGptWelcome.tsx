import { useSiwc } from './useSiwc';
import './siwc.css';

export function ChatGptWelcome({ language }: { language: 'zh' | 'en' }) {
  const { snapshot, action } = useSiwc();
  if (!snapshot?.welcomePending) return null;
  const zh = language === 'zh';
  return <aside className="siwc-welcome" role="status">
    <strong>{zh ? '正在使用你的 ChatGPT 套餐' : 'You’re using your ChatGPT plan'}</strong>
    <p>{zh ? '符合条件的模型请求会使用此账号的套餐额度。你可以在 ChatGPT 设置中查看用量和管理授权。' : 'Eligible model requests use this account’s ChatGPT plan. Review usage and manage access in ChatGPT settings.'}</p>
    <div className="settings-actions"><button type="button" className="secondary-button" onClick={() => void action({ action: 'manage_usage' })}>{zh ? '查看用量' : 'View usage'}</button>
      <button type="button" className="primary-button" onClick={() => void action({ action: 'dismiss_welcome' })}>{zh ? '知道了' : 'Got it'}</button></div>
  </aside>;
}
