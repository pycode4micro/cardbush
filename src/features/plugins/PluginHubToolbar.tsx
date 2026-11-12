import { ChevronDown, FileArchive, FolderOpen, LoaderCircle, PackagePlus, Plus, RefreshCw, Server, Settings, Store, UserRound } from 'lucide-react';
import type { RefObject } from 'react';
import { uiText, type MessageKey } from '../../i18n';
import type { AppLanguage } from '../../types';

export type PluginHubSection = 'plugins' | 'skills' | 'marketplace' | 'accounts' | 'network' | 'mcp' | 'manage';

const tabs = [
  { section: 'plugins', label: 'appCenterModel.plugins' },
  { section: 'skills', label: 'composer.skills' },
  { section: 'marketplace', label: 'pluginManagementPanel.marketplace', icon: Store },
  { section: 'accounts', label: 'accountsPanel.accounts', icon: UserRound },
] as const satisfies ReadonlyArray<{ section: PluginHubSection; label: MessageKey; icon?: typeof Store }>;

type Props = {
  language: AppLanguage;
  section: PluginHubSection;
  remote: boolean;
  busy: string;
  installing: boolean;
  addOpen: boolean;
  addMenuRef: RefObject<HTMLDivElement | null>;
  onToggleAdd: () => void;
  onNavigate: (section: PluginHubSection) => void;
  onRefresh: () => void;
  onInstall: (kind: 'zip' | 'directory') => void;
  onAddMcp: () => void;
};

export function PluginHubToolbar({ language, section, remote, busy, installing, addOpen, addMenuRef,
  onToggleAdd, onNavigate, onRefresh, onInstall, onAddMcp }: Props) {
  const t = uiText(language);
  const current = (destination: PluginHubSection) => destination === section ? 'location' : undefined;
  return <nav className="plugin-hub-toolbar" aria-label={t('appCenterModel.plugins')}>
    <div className="plugin-hub-tabs">
      {tabs.map(tab => {
        if (tab.section === 'accounts' && remote) return null;
        const Icon = 'icon' in tab ? tab.icon : undefined;
        return <button key={tab.section} type="button" aria-current={current(tab.section)} disabled={installing}
          onClick={() => onNavigate(tab.section)}>{Icon && <Icon/>}{t(tab.label)}</button>;
      })}
    </div>
    <div className="plugin-hub-actions">
      <button type="button" title={t('pluginManagementPanel.pluginSettings')} aria-current={current('network')}
        disabled={installing} onClick={() => onNavigate('network')}>{t('common.settings')}</button>
      <button className="plugin-mcp-manage-button" type="button" aria-current={current('mcp')} disabled={installing}
        onClick={() => onNavigate('mcp')}><Server/><span>{t('pluginManagementPanel.mcpServers')}</span></button>
      <button type="button" title={t('automationPanel.refresh')} disabled={Boolean(busy) || installing} onClick={onRefresh}>
        {busy === 'load' ? <LoaderCircle className="spin"/> : <RefreshCw/>}
      </button>
      <button type="button" title={t('browserStartBookmarks.manage')} aria-current={current('manage')} disabled={installing}
        onClick={() => onNavigate('manage')}><Settings/></button>
      <div className="plugin-add-wrap" ref={addMenuRef}>
        <button className="plugin-add-button" type="button" disabled={Boolean(busy) || installing} aria-expanded={addOpen} onClick={onToggleAdd}>
          {t('composer.add')} <ChevronDown/>
        </button>
        {addOpen && <div className="plugin-add-menu">
          <button type="button" onClick={() => onNavigate('marketplace')}>
            <Store/><span><strong>{t('pluginManagementPanel.installFromMarketplace')}</strong><small>{t('pluginManagementPanel.browseGithubAndLocalPluginMarketplaces')}</small></span>
          </button>
          {!remote && <button type="button" onClick={() => onInstall('zip')}>
            <FileArchive/><span><strong>{t('pluginManagementPanel.installFromZip')}</strong><small>{t('pluginManagementPanel.importAPluginArchive')}</small></span>
          </button>}
          <button type="button" onClick={() => onInstall('directory')}>
            <FolderOpen/><span><strong>{t('pluginManagementPanel.installFromFolder')}</strong><small>{t('pluginManagementPanel.chooseAnUnpackedPlugin')}</small></span>
          </button>
          <button type="button" onClick={onAddMcp}>
            <Plus/><span><strong>{t('pluginManagementPanel.addMcpServer')}</strong><small>{t('pluginManagementPanel.connectALocalOrRemoteToolService')}</small></span>
          </button>
          <button type="button" onClick={() => onNavigate('skills')}>
            <PackagePlus/><span><strong>{t('pluginManagementPanel.browseSkills')}</strong><small>{t('pluginManagementPanel.manageTheCardbushSkillCatalog')}</small></span>
          </button>
        </div>}
      </div>
    </div>
  </nav>;
}
