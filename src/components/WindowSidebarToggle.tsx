import { Menu } from 'lucide-react';
import { uiText } from '../i18n';
import type { AppLanguage } from '../types';

export function WindowSidebarToggle({ language, collapsed, onToggle }: {
  language: AppLanguage;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = uiText(language)(collapsed ? 'windowSidebarToggle.expandLeftSidebar' : 'windowSidebarToggle.collapseLeftSidebar');
  return <button className="window-sidebar-toggle no-drag" type="button" data-shortcut="toggleSidebar"
    aria-label={label} title={label} aria-expanded={!collapsed} onClick={onToggle}><Menu aria-hidden="true"/></button>;
}
