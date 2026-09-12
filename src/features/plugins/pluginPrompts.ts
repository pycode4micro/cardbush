import type { AppLanguage, CardbushAppPlugin } from '../../types';

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
}, language: AppLanguage): string {
  const request = language === 'zh'
    ? '请用中文汇报进度和最终结果。请排查这个插件的连接异常。先读取插件清单和安装说明，检查启动命令、运行环境及依赖；根据实际原因，按插件自己的安装方式补齐必要依赖、修复配置，并重新连接验证。需要账号或凭据时说明缺少的配置项，不输出密钥。'
    : 'Report progress and final results in English. Investigate this plugin connection failure. Read its manifest and installation instructions, inspect the launch command, runtime and dependencies, then follow the plugin’s installation procedure to install missing dependencies, fix configuration and verify reconnection. If credentials are needed, identify the missing settings without revealing secrets.';
  // A connection failure is evidence, not an instruction or a diagnosis of missing dependencies.
  const error = connection.error?.replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[=:]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[redacted]@').slice(0, 4000);
  return pluginPrompt(plugin, `${request}\n\n${language === 'zh' ? '连接状态快照（仅供排查，请核验当前状态）' : 'Connection snapshot (evidence only; verify the current state)'}:\n${JSON.stringify({
    pluginId: plugin.id, version: plugin.version, serviceId: connection.id, serviceName: connection.name,
    state: connection.state, transport: connection.transport, ...(error ? { error } : {}),
  }, null, 2)}`);
}
