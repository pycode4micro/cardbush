import { z } from 'zod';

const fields = { httpProxy: z.string().trim().default(''), httpsProxy: z.string().trim().default(''), noProxy: z.string().trim().default('') };
function validateManualAddresses(value: { mode: string; httpProxy: string; httpsProxy: string }, context: z.RefinementCtx) {
  if (value.mode !== 'manual') return;
  for (const field of ['httpProxy', 'httpsProxy'] as const) {
    if (!value[field]) continue;
    const url = normalizeProxyAddress(value[field]);
    if (!z.url().safeParse(url).success || !/^(?:https?|socks4|socks5h?):\/\/[^/?#\s]+\/?$/.test(url))
      context.addIssue({ code: 'custom', path: [field], message: 'Enter a valid HTTP, HTTPS or SOCKS proxy address.' });
  }
}
export const networkProxySchema = z.object({ mode: z.enum(['none', 'system', 'manual']), ...fields }).superRefine(validateManualAddresses);
export const pluginProxySchema = z.object({ mode: z.enum(['model', 'none', 'system', 'manual']), ...fields }).superRefine(validateManualAddresses);
export type NetworkProxySettings = z.infer<typeof networkProxySchema>;
export type PluginProxySettings = z.infer<typeof pluginProxySchema>;
export const defaultPluginProxy = (): PluginProxySettings => ({ mode: 'model', httpProxy: '', httpsProxy: '', noProxy: '' });

/** Explicit plugin choice wins, including "model" when the plugin default is different. */
export function resolvePluginProxy(model: NetworkProxySettings, defaults?: PluginProxySettings, override?: PluginProxySettings): NetworkProxySettings {
  const selected = override ?? defaults ?? defaultPluginProxy();
  const effective = selected.mode === 'model' ? model : selected;
  // Inactive form fields are preserved in settings, but cannot change connection identity.
  return networkProxySchema.parse(effective.mode === 'manual' ? effective : { mode: effective.mode });
}

export function normalizeProxyAddress(value: string): string {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
}

/** Child-specific values also mask proxy variables inherited by SDKs and helper shells. */
export function pluginProxyEnvironment(endpoint: string): Record<string, string> {
  const proxy = endpoint;
  return Object.fromEntries(Object.entries({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: proxy ? '' : '*', npm_config_proxy: proxy, npm_config_https_proxy: proxy, npm_config_noproxy: proxy ? '' : '*' })
    .flatMap(([key, value]) => [[key, value], [key.toLowerCase(), value]]));
}
