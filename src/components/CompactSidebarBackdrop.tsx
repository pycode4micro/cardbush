import type { AppLanguage } from '../types';
import { useSoftPanelPresence } from '../hooks/useSoftPanelPresence';

export function CompactSidebarBackdrop({ visible, language, onClose }: {
  visible: boolean; language: AppLanguage; onClose: () => void;
}) {
  const presence = useSoftPanelPresence(visible, 180);
  return presence.mounted ? <button type="button" className="compact-sidebar-backdrop"
    data-visible={presence.visible} aria-hidden={!visible} inert={!visible}
    aria-label={language === 'zh' ? '收起侧栏' : 'Close sidebar'} onClick={onClose} /> : null;
}
