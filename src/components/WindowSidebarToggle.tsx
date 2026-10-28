import { uiText } from '../i18n';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppLanguage } from '../types';

/** The title bar's brand slot becomes the sidebar control after startup. */
export function WindowSidebarToggle({ language, collapsed, onToggle }: {
  language: AppLanguage;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [showBrand, setShowBrand] = useState(true);

  useEffect(() => {
    if (!showBrand) return undefined;
    const timer = window.setTimeout(() => setShowBrand(false), 3000);
    return () => window.clearTimeout(timer);
  }, [showBrand]);

  const label = collapsed
    ? uiText(language)('windowSidebarToggle.expandLeftSidebar')
    : uiText(language)('windowSidebarToggle.collapseLeftSidebar');

  return (
    <button className="window-sidebar-toggle no-drag" type="button"
      data-brand-visible={showBrand} data-collapsed={collapsed}
      data-shortcut="toggleSidebar"
      aria-label={label} aria-expanded={!collapsed}
      onClick={() => { setShowBrand(false); onToggle(); }}>
      {/* Measure the themed brand naturally; the slot contracts to the icon after startup. */}
      <span className="window-brand window-sidebar-size" aria-hidden="true">{uiText(language)('windowSidebarToggle.cardbush')}</span>
      <span className="window-sidebar-viewport" aria-hidden="true">
        <span className="window-sidebar-track">
          <span className="window-sidebar-screen">
            <span className="window-brand">{uiText(language)('windowSidebarToggle.cardbush')}</span>
          </span>
          <span className="window-sidebar-screen">
            <span className="window-sidebar-icon-viewport">
              <span className="window-sidebar-icon-track">
                <span className="window-sidebar-icon"><PanelLeftClose size={17} /></span>
                <span className="window-sidebar-icon"><PanelLeftOpen size={17} /></span>
              </span>
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
