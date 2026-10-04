type Desktop = NonNullable<Window['cardbushDesktop']>;
export type PluginMarketplaceApi = Pick<Desktop, 'pluginMarketSources' | 'pluginMarketCatalog' | 'addPluginMarket'
  | 'removePluginMarket' | 'previewMarketPlugin' | 'installMarketPlugin' | 'pluginMarketPresentation'> & Partial<Pick<Desktop,
    'pluginMarketInstallProgress' | 'cancelMarketPluginInstall'>> & {
  addLocalPluginMarket(directory?: string): ReturnType<Desktop['addLocalPluginMarket']>;
};

export const localPluginMarketplace: PluginMarketplaceApi = {
  pluginMarketSources: () => window.cardbushDesktop!.pluginMarketSources(),
  pluginMarketCatalog: (id, refresh) => window.cardbushDesktop!.pluginMarketCatalog(id, refresh),
  addPluginMarket: source => window.cardbushDesktop!.addPluginMarket(source),
  addLocalPluginMarket: () => window.cardbushDesktop!.addLocalPluginMarket(),
  removePluginMarket: id => window.cardbushDesktop!.removePluginMarket(id),
  previewMarketPlugin: (id, name) => window.cardbushDesktop!.previewMarketPlugin(id, name),
  installMarketPlugin: token => window.cardbushDesktop!.installMarketPlugin(token),
  pluginMarketInstallProgress: token => window.cardbushDesktop?.pluginMarketInstallProgress?.(token) ?? Promise.resolve(null),
  cancelMarketPluginInstall: token => window.cardbushDesktop?.cancelMarketPluginInstall?.(token) ?? Promise.resolve(false),
  pluginMarketPresentation: (id, name) => window.cardbushDesktop!.pluginMarketPresentation(id, name),
};
