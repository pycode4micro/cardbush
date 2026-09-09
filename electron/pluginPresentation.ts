import { extname } from 'node:path';
import type { PluginMarketPresentation } from './pluginMarketplaceTypes';
import { safePackagePath } from './pluginPackagePaths';

/** Read presentation without downloading or executing a plugin package. */
export async function readPluginPresentation(read: (path: string) => Promise<Buffer>): Promise<PluginMarketPresentation> {
  const json = async (path: string): Promise<Record<string, unknown> | null> => {
    try { return JSON.parse((await read(path)).toString('utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  };
  const root = await json('plugin.json');
  const portable = root?.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  const extension = record(root?.extensions)['com.openai'];
  const manifest = portable && extension && typeof extension === 'object' && !Array.isArray(extension) ? record(extension)
    : await json('.codex-plugin/plugin.json') ?? await json('.claude-plugin/plugin.json') ?? root ?? {};
  const metadata = record(manifest.interface);
  const asset = async (value: unknown) => {
    if (typeof value !== 'string' || !value) return '';
    try {
      const path = safePackagePath(value);
      const type = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' } as Record<string, string>)[extname(path).toLowerCase()];
      if (!type) return '';
      const bytes = await read(path);
      return bytes.length <= 512 * 1024 ? `data:${type};base64,${bytes.toString('base64')}` : '';
    } catch { return ''; }
  };
  const logo = await asset(metadata.logo ?? metadata.composerIcon);
  return { displayName: text(metadata.displayName), description: text(metadata.shortDescription ?? root?.description ?? manifest.description),
    logo, logoDark: metadata.logoDark === metadata.logo ? logo : await asset(metadata.logoDark) };
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function text(value: unknown) { return typeof value === 'string' ? value : ''; }
