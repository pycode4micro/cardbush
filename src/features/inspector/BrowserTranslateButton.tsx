import { Languages, LoaderCircle } from 'lucide-react';
import type { AppLanguage } from '../../types';
import type { BrowserTranslationError, BrowserTranslationState } from '../../../electron/browserTranslationTypes';

export function browserTranslationError(error: BrowserTranslationError | undefined, language: AppLanguage) {
  const zh = language === 'zh';
  switch (error) {
    case 'no_text': return zh ? '当前页面没有可翻译的文字。' : 'No translatable text on this page.';
    case 'model': return zh ? '请先在模型管理中配置可用的默认模型。' : 'Configure an available default model in Models first.';
    case 'timeout': return zh ? '翻译超时，已恢复原文。可以重试。' : 'Translation timed out. Original text restored; you can retry.';
    case 'unavailable': return zh ? '请等待网页加载完成后再翻译。' : 'Wait for the webpage to finish loading before translating.';
    default: return zh ? '翻译失败，已恢复原文。请检查模型或网络后重试。' : 'Translation failed. Original text restored; check the model or network and retry.';
  }
}

export function BrowserTranslateButton({ address, language, state, loading, onClick }: {
  address: string; language: AppLanguage; state?: BrowserTranslationState; loading?: boolean; onClick: () => void;
}) {
  const zh = language === 'zh', busy = state?.status === 'translating', translated = state?.status === 'translated';
  const label = busy ? zh ? '正在翻译，点击取消' : 'Translating — click to cancel'
    : translated ? zh ? '显示原文' : 'Show original'
    : zh ? '翻译为中文' : 'Translate to English';
  const title = state?.status === 'error' ? `${browserTranslationError(state.error, language)} ${label}`
    : translated && state.partial ? zh ? '已翻译部分内容，点击显示原文' : 'Partially translated — click to show original'
    : !busy && !translated ? `${label}${zh ? '（使用默认模型）' : ' (using the default model)'}` : label;
  return <button type="button" className="inspector-translate-button" aria-label={label} title={title}
    aria-pressed={translated} aria-busy={busy} data-error={state?.status === 'error' || undefined}
    disabled={!/^https?:\/\//i.test(address) || Boolean(loading && !busy && !translated)} onClick={onClick}>
    {busy ? <LoaderCircle size={15} className="spinning" aria-hidden="true"/> : <Languages size={15} aria-hidden="true"/>}
  </button>;
}
