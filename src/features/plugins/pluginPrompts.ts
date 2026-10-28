import { uiText } from '../../i18n';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import type { PluginTroubleshootingContext } from '../../../electron/pluginTroubleshooting.mjs';

export function pluginReference(plugin: Pick<CardbushAppPlugin, 'id' | 'manifestPath'>): string {
  const path = plugin.manifestPath?.replaceAll('\\', '/').replaceAll('>', '%3E').replaceAll('<', '%3C');
  return path ? `[$${plugin.id}](<${path}>)` : `$${plugin.id}`;
}

export function pluginPrompt(plugin: CardbushAppPlugin, prompt: string): string {
  return `${pluginReference(plugin)} ${prompt.trim()}`;
}

export type PluginLinkReference = { id: string; manifestPath: string };
export type PluginPromptPart = { text: string; start: number; plugin?: CardbushAppPlugin; reference?: PluginLinkReference };

/** An explicit $id link to a plugin manifest remains a plugin reference before catalog loading. */
export function pluginReferenceFromLink(label: string, path: string): PluginLinkReference | null {
  if (!/^\$[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label) ||
    !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) || !/[\\/]plugin\.json$/i.test(path)) return null;
  return { id: label.slice(1), manifestPath: path };
}

export function findReferencedPlugin(reference: PluginLinkReference, plugins: CardbushAppPlugin[]) {
  const pathKey = (path: string) => {
    const normalized = path.replaceAll('\\', '/');
    return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  return plugins.find(plugin => plugin.id === reference.id &&
    pathKey(plugin.manifestPath) === pathKey(reference.manifestPath));
}

/** Parse explicit references; only catalog-backed identities acquire plugin metadata. */
export function pluginPromptParts(value: string, plugins: CardbushAppPlugin[]): PluginPromptPart[] {
  const parts: PluginPromptPart[] = [];
  const references = new Map(plugins.map(plugin => [pluginReference(plugin), plugin]));
  const pattern = /\[(\$[A-Za-z0-9][A-Za-z0-9._-]*)\]\(<([^>\r\n]+)>\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const plugin = references.get(match[0]);
    const reference = plugin ? { id: plugin.id, manifestPath: plugin.manifestPath }
      : pluginReferenceFromLink(match[1], match[2].replace(/%3C/gi, '<').replace(/%3E/gi, '>'));
    if (!reference) continue;
    if (match.index > cursor) parts.push({ text: value.slice(cursor, match.index), start: cursor });
    parts.push({ text: match[0], start: match.index, plugin, reference });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length || !parts.length) parts.push({ text: value.slice(cursor), start: cursor });
  return parts;
}

export function pluginTroubleshootingPrompt(plugin: CardbushAppPlugin, connection: {
  id: string; name: string; state: string; transport?: string; error?: string;
  configurationRevision?: number; updateState?: string; restartAttempts?: number; toolCount?: number;
}, language: AppLanguage, context?: PluginTroubleshootingContext): string {
  const request = uiText(language)('pluginPrompts.reportProgressAndFinalResultsInEnglish');
  // A connection failure is evidence, not an instruction or a diagnosis of missing dependencies.
  const error = connection.error?.replace(/((?:Bearer|Basic)\s+)\S+/gi, '$1[redacted]')
    .replace(/(\b[\w-]*(?:token|secret|password|passwd|authorization|credential|cookie|api[_-]?key|access[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, value => {
      try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[invalid URL omitted]'; }
    }).slice(0, 4000);
  const target = context && context.pluginId === plugin.id && context.serviceId === connection.id ? context : undefined;
  const manifestPath = target?.manifestPath ?? plugin.manifestPath.replaceAll('\\', '/');
  const pluginRoot = target?.pluginRoot ?? manifestPath.replace(/\/(?:\.(?:codex|claude)-plugin\/)?plugin\.json$/i, '');
  return pluginPrompt({ ...plugin, manifestPath }, `${request}\n\n${uiText(language)('pluginPrompts.diagnosticSnapshotConfigurationResolvedAtReadTime')}:\n${JSON.stringify({
    application: 'CardBush', pluginId: plugin.id, version: target?.version ?? plugin.version,
    manifestPath, pluginRoot, source: target?.source ?? plugin.source,
    ...(target ? { capturedAt: target.capturedAt, pluginEnabled: target.pluginEnabled, componentId: target.componentId,
      pluginConfigurationRevision: target.pluginConfigurationRevision, mcpConfigurationRevision: target.mcpConfigurationRevision,
      boundServerId: target.boundServerId, configuredLaunch: target.configuredLaunch, configurationError: target.configurationError }
      : { configuredLaunch: null, contextNote: uiText(language)('pluginPrompts.currentLaunchConfigurationUnavailableVerifyTheInstallation') }),
    serviceId: connection.id, serviceName: connection.name, state: connection.state, transport: target?.configuredLaunch?.transport ?? connection.transport,
    displayedRuntimeConfigurationRevision: connection.configurationRevision, updateState: connection.updateState,
    restartAttempts: connection.restartAttempts, toolCount: connection.toolCount, ...(error ? { error } : {}),
  }, null, 2)}`);
}
