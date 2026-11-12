import { CardbushAppsConfigStore, defaultCardbushAppsConfig } from '@cardbush/product-host';
import { loadProductPluginCatalog, type PluginRoot } from './productPlugins.js';

export async function loadPluginSearchPackages(pluginRoots: PluginRoot[], configPath?: string) {
  const loadCatalog = (excluded?: ReadonlySet<string>) => loadProductPluginCatalog(pluginRoots, excluded);
  const state = configPath ? await new CardbushAppsConfigStore(configPath, { loadCatalog }).read()
    : defaultCardbushAppsConfig(await loadCatalog());
  const packages = state.plugins
    .filter(plugin => !plugin.removalPending && (plugin.source === 'bundled' || plugin.installed))
    .map(plugin => ({
      name: plugin.id, displayName: plugin.name, description: plugin.description, version: plugin.version,
      keywords: [...plugin.keywords, plugin.localizations?.zh?.description].filter(Boolean).join(' '),
      source: plugin.source, installed: plugin.installed, enabled: state.serviceEnabled && plugin.enabled,
    }));
  return { packages };
}
