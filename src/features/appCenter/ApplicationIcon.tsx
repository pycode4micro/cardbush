import { useState } from 'react';
import { AppWindow, Blocks, FileText, UsersRound } from 'lucide-react';
import { PluginIcon } from '../../components/PluginIcon';
import { PluginGlyph } from '../plugins/PluginGlyph';
import { BrowserSiteIcon } from '../browser/BrowserSiteIcon';
import type { ApplicationEntry } from './appCenterModel';

export function ApplicationIcon({ app, size = 20 }: { app: ApplicationEntry; size?: number }) {
  const [failedIcon, setFailedIcon] = useState('');
  if (app.plugin) return <PluginGlyph plugin={app.plugin} />;
  if (app.kind === 'web' || app.kind === 'external') return <BrowserSiteIcon url={app.target} icon={app.icon} size={size} persist/>;
  if (app.kind === 'local') return app.icon && app.icon !== failedIcon
    ? <img className="composer-plugin-option-logo" src={app.icon} alt="" draggable={false} onError={() => setFailedIcon(app.icon ?? '')}/>
    : <AppWindow size={size} aria-hidden="true"/>;
  const Icon = app.target === 'plugins' ? PluginIcon : app.target === 'components' ? Blocks : app.target === 'team' ? UsersRound : app.target === 'md-presentation' ? FileText : AppWindow;
  return <Icon size={size} aria-hidden="true" />;
}
