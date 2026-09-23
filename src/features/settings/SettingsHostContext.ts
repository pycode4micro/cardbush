import { createContext, useContext } from 'react';
import * as api from '../../backend/api';
type Desktop = NonNullable<Window['cardbushDesktop']>;
export const localSettingsHost = {
  remote: false,
  supportsPluginConnections: true,
  fetchCardbushAppsConfiguration: api.fetchCardbushAppsConfiguration,
  saveCardbushAppsConfiguration: api.saveCardbushAppsConfiguration,
  fetchMcpConnectionOverview: api.fetchMcpConnectionOverview,
  savePluginSearchResultLimit: api.savePluginSearchResultLimit,
  uninstallCardbushPlugin: api.uninstallCardbushPlugin,
  setMcpServerProxy: api.setMcpServerProxy,
  resetMcpServerProxies: api.resetMcpServerProxies,
  fetchMcpServers: api.fetchMcpServers,
  saveMcpServerConfig: api.saveMcpServerConfig,
  setMcpServerEnabled: api.setMcpServerEnabled,
  deleteMcpServerConfig: api.deleteMcpServerConfig,
  savePluginConnections: ((input) => window.cardbushDesktop!.savePluginConnections(input)) as Desktop['savePluginConnections'],
  mcpConnectionAction: ((id, action) => window.cardbushDesktop!.mcpConnectionAction(id, action)) as Desktop['mcpConnectionAction'],
};
export type SettingsHost = typeof localSettingsHost & { installDirectory?: (path: string) => Promise<unknown> };
export const SettingsHostContext = createContext<SettingsHost>(localSettingsHost);
export const useSettingsHost = () => useContext(SettingsHostContext);
