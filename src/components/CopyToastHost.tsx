import { CheckCircle2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { COPY_FEEDBACK_EVENT } from '../features/messageFeedback';
import { type AppLanguage } from '../types';

export function CopyToastHost({ language }: { language: AppLanguage }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer = 0;
    const show = () => {
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), 1500);
    };
    window.addEventListener(COPY_FEEDBACK_EVENT, show);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(COPY_FEEDBACK_EVENT, show);
    };
  }, []);

  if (!visible) {
    return null;
  }
  return (
    <div className="copy-toast" role="status" aria-live="polite">
      <CheckCircle2 size={15} />
      <span>{language === 'zh' ? '已复制到剪贴板' : 'Copied to clipboard'}</span>
    </div>
  );
}