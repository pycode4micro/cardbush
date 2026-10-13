import { ArrowDown } from 'lucide-react';
import type { Ref } from 'react';
import type { AppLanguage } from '../../types';

export function ScrollBottomButton({ language, visible, running = false, onClick, ref }: {
  language: AppLanguage; visible: boolean; running?: boolean; onClick(): void; ref?: Ref<HTMLButtonElement>;
}) {
  const label = language === 'zh' ? '回到底部' : 'Back to bottom';
  const status = running ? language === 'zh' ? '正在生成' : 'Generating' : undefined;
  return <button ref={ref} className={`scroll-bottom${running ? ' loop-running' : ''}${visible ? '' : ' hidden'}`} type="button"
    aria-label={label} aria-description={status} title={status ? `${label} · ${status}` : label}
    aria-hidden={!visible} tabIndex={visible ? 0 : -1} onClick={onClick}>
    <ArrowDown size={18} strokeWidth={2} aria-hidden="true"/>
  </button>;
}
