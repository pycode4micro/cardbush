import type { AppLanguage } from '../types';

export function CompactSidebarBackdrop({ visible, language, onClose }: {
  visible: boolean; language: AppLanguage; onClose: () => void;
}) {
  return visible ? <button type="button" className="compact-sidebar-backdrop"
    aria-label={language === 'zh' ? '收起侧栏' : 'Close sidebar'} onClick={onClose} /> : null;
}
