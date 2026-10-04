export interface PluginMarketSource {
  id: string;
  kind: 'github' | 'git' | 'local';
  location: string;
  ref?: string;
  builtin?: boolean;
}

export interface PluginMarketEntry {
  name: string;
  description: string;
  category: string;
  available: boolean;
  unavailableReason?: string;
  presentation?: PluginMarketPresentation;
}

export interface PluginMarketPresentation {
  displayName: string;
  description: string;
  logo: string;
  logoDark: string;
}

export interface PluginMarketCatalog {
  source: PluginMarketSource;
  name: string;
  displayName: string;
  entries: PluginMarketEntry[];
  fetchedAt: string;
  cached?: boolean;
  error?: string;
}

export interface PluginMarketPreview {
  validation?: 'metadata' | 'complete';
  token: string;
  id: string;
  name: string;
  description: string;
  version: string;
  developerName: string;
  source: string;
  revision: string;
  components: Array<{ kind: string; name: string; description: string }>;
  requirements: string[];
  issues: Array<{ code: string; detail: string }>;
  warnings?: Array<{ code: string; detail: string }>;
  notes?: string[];
  updating: boolean;
  format: 'agent-plugins' | 'openai' | 'claude';
  authentication?: 'ON_INSTALL' | 'ON_USE';
}

export interface PluginMarketInstallProgress {
  phase: 'queued' | 'downloading' | 'extracting' | 'validating' | 'installing' | 'completed' | 'cancelled' | 'failed';
  downloadedBytes: number;
  totalBytes?: number;
  cancellable: boolean;
}

export interface PluginMarketInstallResult {
  id: string;
  manifestPath: string;
  warnings?: Array<{ code: string; detail: string }>;
}
