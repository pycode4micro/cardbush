import { ArrowDown } from 'lucide-react';
import type { Ref } from 'react';
import type { AppLanguage } from '../../types';

export function ScrollBottomButton({ language, visible, onClick, ref }: {
  language: AppLanguage; visible: boolean; onClick(): void; ref?: Ref<HTMLButtonElement>;
}) {
  const label = language === 'zh' ? '回到底部' : 'Back to bottom';
  return <button ref={ref} className={`scroll-bottom ${visible ? '' : 'hidden'}`} type="button"
    aria-label={label} title={label} aria-hidden={!visible} tabIndex={visible ? 0 : -1} onClick={onClick}>
    <ArrowDown size={18} strokeWidth={2} aria-hidden="true"/>
  </button>;
}
